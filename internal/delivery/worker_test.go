package delivery

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gregorsternat/hooklane/internal/store"
)

type recordingStore struct{ result store.Completion }

func (s *recordingStore) Claim(context.Context, time.Duration, int) (*store.Job, error) {
	return nil, nil
}
func (s *recordingStore) Finish(_ context.Context, c store.Completion) (bool, error) {
	s.result = c
	return true, nil
}
func (s *recordingStore) Retain(context.Context, time.Duration) (int64, error) { return 0, nil }
func testWorker(s *recordingStore) *Worker {
	return New(s, Config{Concurrency: 2, MaxAttempts: 3, Timeout: time.Second, PollInterval: time.Millisecond, RetryBase: time.Second, Retention: 24 * time.Hour}, Policy{AllowHTTP: true, AllowedCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}
func testJob(url string) *store.Job {
	return &store.Job{DeliveryID: "dlv_test", EventID: "evt_test", URL: url, SigningSecret: "test-secret-for-receiver-verification", Payload: []byte(`{ "id": 42 }`), EventType: "order.created", AttemptNumber: 1, ClaimToken: "claim_one"}
}

func TestSignedDeliveryPreservesExactBodyAndIdentity(t *testing.T) {
	var received atomic.Bool
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if string(body) != `{ "id": 42 }` {
			t.Error("payload changed")
		}
		if r.Header.Get("Webhook-Id") != "evt_test" || r.Header.Get("X-Hooklane-Delivery-Id") != "dlv_test" || r.Header.Get("X-Hooklane-Attempt") != "1" {
			t.Error("missing identity headers")
		}
		timestamp := r.Header.Get("Webhook-Timestamp")
		seconds, err := strconv.ParseInt(timestamp, 10, 64)
		if err != nil || time.Since(time.Unix(seconds, 0)) > 5*time.Second {
			t.Error("invalid timestamp")
		}
		mac := hmac.New(sha256.New, []byte("test-secret-for-receiver-verification"))
		_, _ = mac.Write([]byte("evt_test." + timestamp + "."))
		_, _ = mac.Write(body)
		want := "v1," + hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(want), []byte(r.Header.Get("Webhook-Signature"))) {
			t.Error("signature does not verify")
		}
		received.Store(true)
		w.WriteHeader(204)
	}))
	defer receiver.Close()
	s := &recordingStore{}
	worker := testWorker(s)
	defer worker.client.CloseIdleConnections()
	worker.deliver(context.Background(), testJob(receiver.URL))
	if !received.Load() || s.result.Status != "succeeded" || s.result.StatusCode != 204 || s.result.ClaimToken != "claim_one" {
		t.Fatalf("incorrect result %+v", s.result)
	}
}

func TestDeliveryFailureClassification(t *testing.T) {
	for _, tt := range []struct {
		code, attempt int
		want          string
	}{{400, 1, "dead"}, {404, 1, "dead"}, {408, 1, "retrying"}, {425, 1, "retrying"}, {429, 1, "retrying"}, {500, 1, "retrying"}, {503, 3, "dead"}} {
		t.Run(strconv.Itoa(tt.code)+"/"+strconv.Itoa(tt.attempt), func(t *testing.T) {
			receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Retry-After", "120")
				w.WriteHeader(tt.code)
			}))
			defer receiver.Close()
			s := &recordingStore{}
			worker := testWorker(s)
			defer worker.client.CloseIdleConnections()
			job := testJob(receiver.URL)
			job.AttemptNumber = tt.attempt
			worker.deliver(context.Background(), job)
			if s.result.Status != tt.want || s.result.ErrorCode != "http_error" {
				t.Fatalf("incorrect result %+v", s.result)
			}
			if tt.want == "retrying" && (s.result.NextAttemptAt == nil || time.Until(*s.result.NextAttemptAt) < 119*time.Second) {
				t.Fatal("Retry-After ignored")
			}
		})
	}
}

func TestRedirectIsNeverFollowed(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	s := &recordingStore{}
	worker := testWorker(s)
	defer worker.client.CloseIdleConnections()
	worker.deliver(context.Background(), testJob(redirect.URL))
	if hits.Load() != 0 || s.result.Status != "dead" || s.result.StatusCode != 307 {
		t.Fatalf("redirect followed: %+v", s.result)
	}
}

func TestTimeoutPersistsSafeRetryWithoutReceiverContents(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { _, _ = io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	defer receiver.Close()
	s := &recordingStore{}
	worker := testWorker(s)
	worker.cfg.Timeout = 20 * time.Millisecond
	defer worker.client.CloseIdleConnections()
	worker.deliver(context.Background(), testJob(receiver.URL+"/private-token"))
	if s.result.Status != "retrying" || s.result.ErrorCode != "timeout" || strings.Contains(s.result.ErrorCode, "token") {
		t.Fatalf("incorrect timeout result %+v", s.result)
	}
}

func TestBackoffAndRetryAfterBounds(t *testing.T) {
	for attempt := 1; attempt <= 20; attempt++ {
		delay := backoff(time.Second, attempt)
		if delay < 500*time.Millisecond || delay > time.Hour {
			t.Fatalf("unbounded backoff: %s", delay)
		}
	}
	for value, want := range map[string]time.Duration{"-1": 0, "0": 0, "20": 20 * time.Second, "9223372036854775807": time.Hour, "garbage": 0} {
		if got := parseRetryAfter(value, time.Now()); got != want {
			t.Errorf("%q: got %s want %s", value, got, want)
		}
	}
	now := time.Now().UTC().Truncate(time.Second)
	if got := parseRetryAfter(now.Add(30*time.Second).Format(http.TimeFormat), now); got != 30*time.Second {
		t.Fatal(got)
	}
}

func TestWorkerStopsOnCancellation(t *testing.T) {
	worker := testWorker(&recordingStore{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { worker.Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}
}
