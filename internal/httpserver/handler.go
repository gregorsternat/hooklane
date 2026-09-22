// Package httpserver provides the application's HTTP boundary.
package httpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"time"
)

// NewHandler accepts a readiness probe so HTTP tests do not require PostgreSQL.
func NewHandler(ping func(context.Context) error, readinessTimeout time.Duration, webDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		status(w, http.StatusOK, "ok")
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readinessTimeout)
		defer cancel()
		if err := ping(ctx); err != nil {
			status(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		status(w, http.StatusOK, "ok")
	})
	if webDir != "" {
		files := http.FileServerFS(os.DirFS(webDir))
		mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			// The bootstrap has one page. Do not turn unknown API paths into HTML.
			if r.URL.Path != "/" {
				info, err := os.Stat(webDir + r.URL.Path)
				if err != nil || !info.Mode().IsRegular() {
					http.NotFound(w, r)
					return
				}
			}
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r)
		})
	}
	return mux
}

func status(w http.ResponseWriter, code int, state string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	// A write failure means the caller has disconnected; there is no useful retry.
	_ = json.NewEncoder(w).Encode(struct {
		Status string `json:"status"`
	}{Status: state})
}
