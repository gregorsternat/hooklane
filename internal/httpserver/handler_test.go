package httpserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHealthDoesNotProbeDatabase(t *testing.T) {
	h := NewHandler(func(context.Context) error {
		t.Fatal("liveness must not depend on PostgreSQL")
		return nil
	}, time.Second, "")
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if r.Code != http.StatusOK || r.Body.String() != "{\"status\":\"ok\"}\n" {
		t.Fatalf("unexpected health response: %d %s", r.Code, r.Body)
	}
}

func TestReadinessOutageAndRecovery(t *testing.T) {
	var probeErr error
	h := NewHandler(func(context.Context) error { return probeErr }, time.Second, "")
	for _, failed := range []bool{false, true, false} {
		probeErr = nil
		want := http.StatusOK
		if failed {
			probeErr = errors.New("postgres://user:secret@internal-host")
			want = http.StatusServiceUnavailable
		}
		r := httptest.NewRecorder()
		h.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if r.Code != want || strings.Contains(r.Body.String(), "secret") {
			t.Fatalf("unexpected readiness response: %d %s", r.Code, r.Body)
		}
		if r.Header().Get("Content-Type") != "application/json" || r.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unexpected headers: %v", r.Header())
		}
	}
}

func TestReadinessDeadline(t *testing.T) {
	h := NewHandler(func(ctx context.Context) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("readiness probe has no deadline")
		}
		<-ctx.Done()
		return ctx.Err()
	}, 5*time.Millisecond, "")
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if r.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d", r.Code)
	}
}

func TestStaticFilesAndUnknownRoutes(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("Hooklane"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(func(context.Context) error { return nil }, time.Second, dir)
	for _, tt := range []struct {
		method, path string
		code         int
	}{
		{http.MethodGet, "/", http.StatusOK},
		{http.MethodGet, "/api/v1/events", http.StatusNotFound},
		{http.MethodGet, "/missing.js", http.StatusNotFound},
		{http.MethodPost, "/readyz", http.StatusMethodNotAllowed},
		{http.MethodGet, "/readyz", http.StatusOK},
	} {
		r := httptest.NewRecorder()
		h.ServeHTTP(r, httptest.NewRequest(tt.method, tt.path, nil))
		if r.Code != tt.code {
			t.Errorf("%s %s: got %d, want %d", tt.method, tt.path, r.Code, tt.code)
		}
	}
}
