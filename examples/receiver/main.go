// Command receiver demonstrates timestamped signature verification. Its in-memory
// deduplication is for development; production receivers must persist event IDs
// atomically with their business side effects.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

func main() {
	secret := os.Getenv("HOOKLANE_SIGNING_SECRET")
	if len(secret) < 32 {
		slog.Error("HOOKLANE_SIGNING_SECRET must contain at least 32 characters")
		os.Exit(1)
	}
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = "127.0.0.1:8099"
	}
	failures, _ := strconv.Atoi(os.Getenv("FAIL_FIRST"))
	var mu sync.Mutex
	seen := make(map[string]time.Time)
	count := 0
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("POST /webhook", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		id, timestamp := r.Header.Get("Webhook-Id"), r.Header.Get("Webhook-Timestamp")
		seconds, err := strconv.ParseInt(timestamp, 10, 64)
		// Compare seconds before constructing a time to avoid overflow edge cases.
		now := time.Now().Unix()
		if err != nil || seconds < now-300 || seconds > now+300 || id == "" {
			http.Error(w, "invalid timestamp", http.StatusUnauthorized)
			return
		}
		provided, err := hex.DecodeString(strings.TrimPrefix(r.Header.Get("Webhook-Signature"), "v1,"))
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(id + "." + timestamp + "."))
		_, _ = mac.Write(body)
		if err != nil || !hmac.Equal(provided, mac.Sum(nil)) {
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		count++
		if count <= failures {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "simulated receiver outage", http.StatusServiceUnavailable)
			return
		}
		for k, at := range seen {
			if time.Since(at) > 24*time.Hour {
				delete(seen, k)
			}
		}
		_, duplicate := seen[id]
		if !duplicate && len(seen) >= 10000 {
			http.Error(w, "demo deduplication capacity reached", http.StatusServiceUnavailable)
			return
		}
		seen[id] = time.Now()
		slog.Info("verified webhook", "event_id", id, "delivery_id", r.Header.Get("X-Hooklane-Delivery-Id"), "duplicate", duplicate)
		w.WriteHeader(http.StatusNoContent)
	})
	server := &http.Server{Addr: address, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	slog.Info("example receiver listening", "address", address)
	if err := server.ListenAndServe(); err != nil {
		slog.Error("receiver stopped")
		os.Exit(1)
	}
}
