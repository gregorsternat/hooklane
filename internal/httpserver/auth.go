package httpserver

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookieName = "hooklane_session"
	sessionTTL        = 12 * time.Hour
)

func equalToken(got, expected string) bool {
	gotHash := sha256.Sum256([]byte(got))
	expectedHash := sha256.Sum256([]byte(expected))
	return expected != "" && hmac.Equal(gotHash[:], expectedHash[:])
}

func (a *api) authorize(allowIngest, requiresStore bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.options.AdminToken == "" {
			apiError(w, http.StatusServiceUnavailable, "unavailable", "Authentication is not configured.")
			return
		}
		cookieAuth := false
		if header := r.Header.Get("Authorization"); header != "" {
			parts := strings.Fields(header)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				unauthorized(w)
				return
			}
			authorized := equalToken(parts[1], a.options.AdminToken) || allowIngest && equalToken(parts[1], a.options.IngestToken)
			if !authorized {
				unauthorized(w)
				return
			}
		} else {
			cookie, err := r.Cookie(sessionCookieName)
			if err != nil || !a.validSession(cookie.Value, time.Now()) {
				unauthorized(w)
				return
			}
			cookieAuth = true
		}
		if cookieAuth && r.Method != http.MethodGet && r.Method != http.MethodHead && !a.sameOrigin(r) {
			apiError(w, http.StatusForbidden, "invalid_origin", "Cookie-authenticated changes require a same-origin request.")
			return
		}
		if requiresStore && (a.store == nil || a.options.Ready != nil && !a.options.Ready()) {
			apiError(w, http.StatusServiceUnavailable, "unavailable", "The service is temporarily unavailable.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="hooklane"`)
	apiError(w, http.StatusUnauthorized, "unauthorized", "Authentication is required.")
}

func (a *api) sameOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || origin.Path != "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil || a.options.SecureCookies {
		scheme = "https"
	}
	return origin.Scheme == scheme && strings.EqualFold(origin.Host, r.Host)
}

func (a *api) createSession(w http.ResponseWriter, r *http.Request) {
	if !a.login.allow(time.Now()) {
		w.Header().Set("Retry-After", "6")
		apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many sign-in attempts. Try again shortly.")
		return
	}
	if a.options.AdminToken == "" {
		apiError(w, http.StatusServiceUnavailable, "unavailable", "Authentication is not configured.")
		return
	}
	if r.Header.Get("Origin") != "" && !a.sameOrigin(r) {
		apiError(w, http.StatusForbidden, "invalid_origin", "Sign-in requires a same-origin request.")
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if !decodeJSON(w, r, 4096, &input) {
		return
	}
	if !equalToken(input.Token, a.options.AdminToken) {
		unauthorized(w)
		return
	}
	expires := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: a.signSession(expires), Path: "/", Expires: expires, MaxAge: int(sessionTTL.Seconds()), HttpOnly: true, Secure: a.options.SecureCookies, SameSite: http.SameSiteStrictMode})
	a.session(w, r)
}

func (a *api) session(w http.ResponseWriter, _ *http.Request) {
	respond(w, http.StatusOK, struct {
		Authenticated bool `json:"authenticated"`
	}{Authenticated: true})
}

func (a *api) deleteSession(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", Expires: time.Unix(1, 0), MaxAge: -1, HttpOnly: true, Secure: a.options.SecureCookies, SameSite: http.SameSiteStrictMode})
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) signSession(expires time.Time) string {
	message := "v1." + strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(a.options.AdminToken))
	_, _ = mac.Write([]byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *api) validSession(value string, now time.Time) bool {
	if a.options.AdminToken == "" || len(value) > 128 {
		return false
	}
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return false
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || expiry <= now.Unix() {
		return false
	}
	return equalToken(value, a.signSession(time.Unix(expiry, 0)))
}

// loginLimiter bounds memory and brute-force attempts without trusting proxy IP headers.
// The installation shares a burst of 10 attempts and recovers one every six seconds.
type loginLimiter struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{tokens: 10, last: time.Now()}
}

func (l *loginLimiter) allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.tokens = min(10, l.tokens+now.Sub(l.last).Seconds()/6)
	l.last = now
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}
