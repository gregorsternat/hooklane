package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gregorsternat/hooklane/internal/store"
)

const (
	adminToken  = "admin-token-that-must-never-be-returned"
	ingestToken = "ingestion-token-that-cannot-administer"
	dstID       = "dst_019974bf582009cd73303535aa76ce33edee"
	evtID       = "evt_019974bf582009cd73303535aa76ce33edee"
	dlvID       = "dlv_019974bf582009cd73303535aa76ce33edee"
)

type fakeBackend struct {
	backend
	create    func(context.Context, store.DestinationInput) (store.Destination, error)
	update    func(context.Context, string, store.DestinationInput) (store.Destination, error)
	get       func(context.Context, string) (store.Destination, error)
	ingest    func(context.Context, store.IngestInput) (store.IngestResult, error)
	list      func(context.Context, store.Page) ([]store.Destination, error)
	listEvent func(context.Context, store.EventFilter) ([]store.Event, error)
	stats     func(context.Context) (store.Stats, error)
	cancel    func(context.Context, string) error
}

func (f fakeBackend) CreateDestination(ctx context.Context, in store.DestinationInput) (store.Destination, error) {
	return f.create(ctx, in)
}
func (f fakeBackend) UpdateDestination(ctx context.Context, id string, in store.DestinationInput) (store.Destination, error) {
	return f.update(ctx, id, in)
}
func (f fakeBackend) GetDestination(ctx context.Context, id string) (store.Destination, error) {
	return f.get(ctx, id)
}
func (f fakeBackend) Ingest(ctx context.Context, in store.IngestInput) (store.IngestResult, error) {
	return f.ingest(ctx, in)
}
func (f fakeBackend) ListDestinations(ctx context.Context, page store.Page) ([]store.Destination, error) {
	return f.list(ctx, page)
}
func (f fakeBackend) ListEvents(ctx context.Context, filter store.EventFilter) ([]store.Event, error) {
	return f.listEvent(ctx, filter)
}
func (f fakeBackend) Stats(ctx context.Context) (store.Stats, error) { return f.stats(ctx) }
func (f fakeBackend) Cancel(ctx context.Context, id string) error    { return f.cancel(ctx, id) }

func testOptions() Options {
	return Options{AdminToken: adminToken, IngestToken: ingestToken, MaxPayloadBytes: 1024,
		ValidateURL: func(context.Context, string) error { return nil }}
}

func testAPI(b backend, options Options) http.Handler {
	return newAPIHandler(func(context.Context) error { return nil }, time.Second, "", b, options)
}

func request(h http.Handler, method, path, token, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://hooklane.test"+path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestAuthenticationScopes(t *testing.T) {
	h := testAPI(fakeBackend{
		stats: func(context.Context) (store.Stats, error) { return store.Stats{Events: 7}, nil },
		ingest: func(context.Context, store.IngestInput) (store.IngestResult, error) {
			return store.IngestResult{Event: store.Event{ID: evtID}}, nil
		},
	}, testOptions())
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/v1/stats"}, {"GET", "/api/v1/metrics"}, {"GET", "/api/v1/destinations"},
		{"POST", "/api/v1/destinations"}, {"GET", "/api/v1/destinations/" + dstID},
		{"PUT", "/api/v1/destinations/" + dstID}, {"DELETE", "/api/v1/destinations/" + dstID},
		{"GET", "/api/v1/events"}, {"GET", "/api/v1/events/" + evtID},
		{"DELETE", "/api/v1/events/" + evtID + "/payload"}, {"GET", "/api/v1/deliveries"},
		{"GET", "/api/v1/deliveries/" + dlvID}, {"POST", "/api/v1/deliveries/" + dlvID + "/replay"},
		{"POST", "/api/v1/deliveries/" + dlvID + "/cancel"}, {"GET", "/api/v1/session"},
	} {
		for _, token := range []string{"", "wrong", ingestToken} {
			w := request(h, route.method, route.path, token, "", nil)
			if w.Code != http.StatusUnauthorized {
				t.Errorf("%s %s with token %q: got %d", route.method, route.path, token, w.Code)
			}
		}
	}
	for _, token := range []string{adminToken, ingestToken} {
		w := request(h, "POST", "/api/v1/events", token, `{"destination_id":"`+dstID+`","type":"order.created","payload":{"total":12}}`, map[string]string{"Idempotency-Key": "order-42"})
		if w.Code != http.StatusAccepted {
			t.Fatalf("authorized ingestion: %d %s", w.Code, w.Body)
		}
	}
	w := request(h, "GET", "/api/v1/stats", adminToken, "", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"events":7`) {
		t.Fatalf("admin stats: %d %s", w.Code, w.Body)
	}
}

func TestSessionCookieAndCSRF(t *testing.T) {
	canceled := 0
	h := testAPI(fakeBackend{cancel: func(context.Context, string) error { canceled++; return nil }}, testOptions())
	login := request(h, "POST", "/api/v1/session", "", `{"token":"`+adminToken+`"}`, map[string]string{"Origin": "http://hooklane.test"})
	if login.Code != http.StatusOK || strings.Contains(login.Body.String(), adminToken) {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].MaxAge != int(sessionTTL.Seconds()) || cookies[0].Secure {
		t.Fatalf("unexpected session cookie: %+v", cookies)
	}
	cookie := cookies[0].Name + "=" + cookies[0].Value
	for _, tc := range []struct {
		origin string
		want   int
	}{
		{"", http.StatusForbidden},
		{"http://attacker.test", http.StatusForbidden},
		{"http://hooklane.test.attacker.test", http.StatusForbidden},
		{"null", http.StatusForbidden},
		{"http://hooklane.test", http.StatusNoContent},
	} {
		w := request(h, "POST", "/api/v1/deliveries/"+dlvID+"/cancel", "", "", map[string]string{"Cookie": cookie, "Origin": tc.origin})
		if w.Code != tc.want {
			t.Errorf("origin %q: got %d want %d: %s", tc.origin, w.Code, tc.want, w.Body)
		}
	}
	if canceled != 1 {
		t.Fatalf("CSRF requests reached persistence: %d", canceled)
	}
	w := request(h, "GET", "/api/v1/session", "", "", map[string]string{"Cookie": cookie})
	if w.Code != http.StatusOK {
		t.Fatalf("cookie session: %d", w.Code)
	}
	w = request(h, "GET", "/api/v1/session", "wrong", "", map[string]string{"Cookie": cookie})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("invalid explicit bearer must not fall back to cookie: %d", w.Code)
	}
	w = request(h, "DELETE", "/api/v1/session", "", "", map[string]string{"Cookie": cookie, "Origin": "http://hooklane.test"})
	if w.Code != http.StatusNoContent || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatalf("logout must clear cookie: %d %v", w.Code, w.Header())
	}
}

func TestSecureSessionAndExpiry(t *testing.T) {
	options := testOptions()
	options.SecureCookies = true
	h := testAPI(nil, options)
	w := request(h, "POST", "/api/v1/session", "", `{"token":"`+adminToken+`"}`, map[string]string{"Origin": "https://hooklane.test"})
	if w.Code != http.StatusOK || !w.Result().Cookies()[0].Secure {
		t.Fatalf("secure cookie: %d %v", w.Code, w.Header())
	}
	a := &api{options: options}
	now := time.Now()
	valid := a.signSession(now.Add(time.Hour))
	for _, value := range []string{a.signSession(now.Add(-time.Second)), valid + "x", "v1.99999999999.fake", "", "v2.0.fake"} {
		if a.validSession(value, now) {
			t.Errorf("accepted invalid session %q", value)
		}
	}
	if !a.validSession(valid, now) {
		t.Fatal("rejected signed unexpired session")
	}
	a.options.AdminToken = "rotated-token"
	if a.validSession(valid, now) {
		t.Fatal("token rotation must invalidate sessions")
	}
}

func TestLoginValidationAndRateLimit(t *testing.T) {
	h := testAPI(nil, testOptions())
	for _, tc := range []struct {
		body    string
		headers map[string]string
		want    int
	}{
		{`{"token":"` + ingestToken + `"}`, nil, http.StatusUnauthorized},
		{`{"token":"` + adminToken + `"}`, map[string]string{"Origin": "https://attacker.test"}, http.StatusForbidden},
		{`{"token":"` + adminToken + `"}`, map[string]string{"Content-Type": "text/plain"}, http.StatusUnsupportedMediaType},
		{`{"token":"` + adminToken + `","extra":true}`, nil, http.StatusBadRequest},
		{`{"token":"` + strings.Repeat("x", 5000) + `"}`, nil, http.StatusRequestEntityTooLarge},
	} {
		w := request(h, "POST", "/api/v1/session", "", tc.body, tc.headers)
		if w.Code != tc.want {
			t.Errorf("got %d want %d: %s", w.Code, tc.want, w.Body)
		}
	}
	h = testAPI(nil, testOptions())
	for range 10 {
		w := request(h, "POST", "/api/v1/session", "", `{"token":"wrong"}`, nil)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("unexpected limiter: %d", w.Code)
		}
	}
	w := request(h, "POST", "/api/v1/session", "", `{"token":"wrong"}`, nil)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("expected bounded sign-in attempts: %d", w.Code)
	}
}

func TestIngestPreservesPayloadAndIdempotency(t *testing.T) {
	payload := `{ "private" : [1,  2], "text": "\u0061" }`
	calls := 0
	h := testAPI(fakeBackend{ingest: func(ctx context.Context, input store.IngestInput) (store.IngestResult, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 8*time.Second {
			t.Fatal("API storage operation must have a bounded deadline")
		}
		if string(input.Payload) != payload || input.IdempotencyKey != "producer-order-1" || input.Type != "order.created" || input.DestinationID != dstID {
			t.Fatalf("ingestion changed request: %+v", input)
		}
		calls++
		return store.IngestResult{Event: store.Event{ID: evtID}, Delivery: store.Delivery{ID: dlvID}, Duplicate: calls > 1}, nil
	}}, testOptions())
	for _, want := range []int{http.StatusAccepted, http.StatusOK} {
		w := request(h, "POST", "/api/v1/events", ingestToken, `{"destination_id":"`+dstID+`","type":"order.created","payload":`+payload+`}`, map[string]string{"Idempotency-Key": "producer-order-1"})
		if w.Code != want || strings.Contains(w.Body.String(), "private") || w.Header().Get("Location") != "/api/v1/events/"+evtID {
			t.Fatalf("ingestion response: %d %s", w.Code, w.Body)
		}
	}
}

func TestIngestRejectsInvalidRequests(t *testing.T) {
	options := testOptions()
	options.MaxPayloadBytes = 32
	h := testAPI(fakeBackend{ingest: func(context.Context, store.IngestInput) (store.IngestResult, error) {
		t.Fatal("invalid request reached store")
		return store.IngestResult{}, nil
	}}, options)
	for _, tc := range []struct {
		body, key string
		want      int
	}{
		{`{"destination_id":"` + dstID + `","type":"t","payload":{}}`, "", 400},
		{`{"destination_id":"` + dstID + `","type":"t","payload":{}}`, "space key", 400},
		{`{"destination_id":"` + dstID + `","type":"t","payload":{}}`, strings.Repeat("k", 129), 400},
		{`{"destination_id":"bad","type":"t","payload":{}}`, "key", 400},
		{`{"destination_id":"` + dstID + `","type":"t"}`, "key", 400},
		{`{"destination_id":"` + dstID + `","type":"bad\ntype","payload":{}}`, "key", 400},
		{`{"destination_id":"` + dstID + `","type":"événement","payload":{}}`, "key", 400},
		{`{"destination_id":"` + dstID + `","type":"t","payload":"` + strings.Repeat("x", 33) + `"}`, "key", 413},
		{`{"destination_id":"` + dstID + `","type":"t","payload":{}} {}`, "key", 400},
		{`{"destination_id":"` + dstID + `","type":"t","payload":{},"unknown":true}`, "key", 400},
		{`{"destination_id":"` + dstID + `","type":"t","payload":`, "key", 400},
	} {
		w := request(h, "POST", "/api/v1/events", ingestToken, tc.body, map[string]string{"Idempotency-Key": tc.key})
		if w.Code != tc.want {
			t.Errorf("body %q: got %d want %d %s", tc.body, w.Code, tc.want, w.Body)
		}
	}
}

func TestDestinationValidationAndSecretBoundary(t *testing.T) {
	secret := strings.Repeat("secret-material-", 3)
	options := testOptions()
	validated := false
	options.ValidateURL = func(ctx context.Context, raw string) error {
		validated = true
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("URL validation requires deadline")
		}
		if raw != "https://receiver.example/hook" {
			return errors.New("credential token secret DNS internals")
		}
		return nil
	}
	h := testAPI(fakeBackend{create: func(_ context.Context, input store.DestinationInput) (store.Destination, error) {
		if !validated || input.SigningSecret != secret || !input.Enabled {
			t.Fatalf("destination validation missing: %+v", input)
		}
		return store.Destination{ID: dstID, Name: input.Name, URL: input.URL, Enabled: true}, nil
	}}, options)
	w := request(h, "POST", "/api/v1/destinations", adminToken, `{"name":"Checkout","url":"https://receiver.example/hook","signing_secret":"`+secret+`"}`, nil)
	if w.Code != http.StatusCreated || strings.Contains(w.Body.String(), secret) || strings.Contains(w.Body.String(), "signing_secret") {
		t.Fatalf("destination creation: %d %s", w.Code, w.Body)
	}
	for _, raw := range []string{"https://blocked.test", "https://user:password@receiver.test", "https://receiver.test/hook?token=secret", "file:///etc/passwd"} {
		w := request(h, "POST", "/api/v1/destinations", adminToken, `{"name":"Checkout","url":"`+raw+`","signing_secret":"`+secret+`"}`, nil)
		if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "DNS internals") || strings.Contains(w.Body.String(), secret) {
			t.Errorf("invalid destination: %d %s", w.Code, w.Body)
		}
	}
}

func TestPaginationAndFilters(t *testing.T) {
	next := "dst_019974bf582009cd73303535aa76ce33edef"
	h := testAPI(fakeBackend{
		list: func(_ context.Context, page store.Page) ([]store.Destination, error) {
			if page.Limit != 2 || page.Before != dstID {
				t.Fatalf("unexpected pagination: %+v", page)
			}
			return []store.Destination{{ID: next}, {ID: dstID}}, nil
		},
		listEvent: func(_ context.Context, filter store.EventFilter) ([]store.Event, error) {
			if filter.Limit != 26 || filter.DestinationID != dstID || filter.Type != "order.created" {
				t.Fatalf("unexpected filter: %+v", filter)
			}
			return nil, nil
		},
	}, testOptions())
	w := request(h, "GET", "/api/v1/destinations?limit=1&before="+dstID, adminToken, "", nil)
	var result struct {
		Items      []store.Destination `json:"items"`
		NextCursor *string             `json:"next_cursor"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(result.Items) != 1 || result.NextCursor == nil || *result.NextCursor != next {
		t.Fatalf("pagination: %d %s", w.Code, w.Body)
	}
	w = request(h, "GET", "/api/v1/events?destination_id="+dstID+"&type=order.created", adminToken, "", nil)
	if w.Code != http.StatusOK || w.Body.String() != "{\"items\":[],\"next_cursor\":null}\n" {
		t.Fatalf("empty list: %d %s", w.Code, w.Body)
	}
	for _, path := range []string{
		"/api/v1/events?limit=0", "/api/v1/events?limit=101", "/api/v1/events?limit=NaN", "/api/v1/events?before=invalid",
		"/api/v1/events?destination_id=invalid", "/api/v1/deliveries?status=unknown", "/api/v1/deliveries?event_id=invalid", "/api/v1/events/invalid",
	} {
		w = request(h, "GET", path, adminToken, "", nil)
		if w.Code != http.StatusBadRequest {
			t.Errorf("invalid filter %s: %d %s", path, w.Code, w.Body)
		}
	}
}

func TestSafeErrorsMetricsAndUnconfiguredStore(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want int
	}{
		{store.ErrNotFound, 404}, {store.ErrConflict, 409}, {store.ErrUnavailable, 409},
		{context.DeadlineExceeded, 503}, {errors.New("postgres://admin:password@private-host"), 503},
	} {
		h := testAPI(fakeBackend{stats: func(context.Context) (store.Stats, error) { return store.Stats{}, tc.err }}, testOptions())
		w := request(h, "GET", "/api/v1/stats", adminToken, "", nil)
		if w.Code != tc.want || strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), "private-host") {
			t.Errorf("safe error: %d %s", w.Code, w.Body)
		}
	}
	h := testAPI(fakeBackend{stats: func(context.Context) (store.Stats, error) { return store.Stats{Pending: 3}, nil }}, testOptions())
	w := request(h, "GET", "/api/v1/metrics", adminToken, "", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `hooklane_deliveries{status="pending"} 3`) || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain;") {
		t.Fatalf("metrics: %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatalf("security headers: %v", w.Header())
	}
	h = NewAPIHandler(func(context.Context) error { return nil }, time.Second, "", nil, testOptions())
	w = request(h, "GET", "/api/v1/stats", adminToken, "", nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil store: %d", w.Code)
	}
	w = request(h, "GET", "/api/v1/unknown", adminToken, "", nil)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), `"error"`) {
		t.Fatalf("unknown API: %d %s", w.Code, w.Body)
	}
}

func TestDestinationPauseDuringDNSOutage(t *testing.T) {
	options := testOptions()
	options.ValidateURL = func(context.Context, string) error { return errors.New("DNS unavailable") }
	updates := 0
	h := testAPI(fakeBackend{
		get: func(context.Context, string) (store.Destination, error) {
			return store.Destination{ID: dstID, Name: "Old name", URL: "https://offline.example/hook", Enabled: false}, nil
		},
		update: func(_ context.Context, id string, in store.DestinationInput) (store.Destination, error) {
			if id != dstID || in.Enabled || in.SigningSecret != "" || in.Name != "Paused destination" {
				t.Fatalf("unexpected update: %+v", in)
			}
			updates++
			return store.Destination{ID: id, Name: in.Name, URL: in.URL, Enabled: in.Enabled}, nil
		},
	}, options)
	w := request(h, "PUT", "/api/v1/destinations/"+dstID, adminToken, `{"name":"Paused destination","url":"https://offline.example/hook"}`, nil)
	if w.Code != http.StatusOK || updates != 1 {
		t.Fatalf("existing offline destination should remain editable: %d %s", w.Code, w.Body)
	}
	w = request(h, "PUT", "/api/v1/destinations/"+dstID, adminToken, `{"name":"Paused destination","url":"https://changed.example/hook"}`, nil)
	if w.Code != http.StatusBadRequest || updates != 1 {
		t.Fatalf("URL change must validate DNS: %d %s", w.Code, w.Body)
	}
}

func TestStoreRoutesWaitForInitialization(t *testing.T) {
	options := testOptions()
	options.Ready = func() bool { return false }
	h := testAPI(fakeBackend{}, options)
	for _, tc := range []struct{ method, path, token string }{
		{"GET", "/api/v1/stats", adminToken},
		{"GET", "/api/v1/destinations", adminToken},
		{"POST", "/api/v1/destinations", adminToken},
		{"POST", "/api/v1/events", ingestToken},
	} {
		w := request(h, tc.method, tc.path, tc.token, "", nil)
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("uninitialized route %s %s: %d %s", tc.method, tc.path, w.Code, w.Body)
		}
	}
	w := request(h, "GET", "/api/v1/session", adminToken, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("session unavailable during database initialization: %d", w.Code)
	}
	w = request(h, "GET", "/healthz", "", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("liveness unavailable during database initialization: %d", w.Code)
	}
}
