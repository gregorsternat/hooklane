package delivery

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"log/slog"
	"net"
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

type failingResolver struct{ err error }

func (r failingResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return nil, r.err
}

func TestDNSFailuresPersistSafeRetry(t *testing.T) {
	for name, resolverError := range map[string]error{
		"lookup failure": &net.DNSError{Name: "sensitive-host.example", Server: "192.0.2.123", Err: "private resolver details"},
		"no answers":     nil,
		"timeout":        &net.DNSError{Name: "sensitive-host.example", IsTimeout: true},
		"canceled":       context.Canceled,
	} {
		t.Run(name, func(t *testing.T) {
			s := &recordingStore{}
			worker := testWorker(s)
			worker.policy.resolver = failingResolver{err: resolverError}
			worker.client = worker.policy.client(worker.cfg.Timeout)
			defer worker.client.CloseIdleConnections()
			var logs bytes.Buffer
			worker.logger = slog.New(slog.NewTextHandler(&logs, nil))
			worker.deliver(context.Background(), testJob("https://sensitive-host.example/private-endpoint"))
			want := "dns_error"
			if name == "timeout" {
				want = "timeout"
			}
			if name == "canceled" {
				want = "interrupted"
			}
			if s.result.ErrorCode != want || s.result.Status != "retrying" || s.result.NextAttemptAt == nil || s.result.StatusCode != 0 {
				t.Fatalf("incorrect DNS failure result %+v", s.result)
			}
			for _, sensitive := range []string{"sensitive-host", "192.0.2.123", "private resolver", "private-endpoint", "test-secret-for-receiver-verification"} {
				if strings.Contains(logs.String(), sensitive) {
					t.Fatalf("transport details leaked to logs: %q", sensitive)
				}
			}
		})
	}
}

func TestBlockedDNSDestinationIsTerminal(t *testing.T) {
	s := &recordingStore{}
	worker := testWorker(s)
	worker.policy.resolver = &testResolver{answers: [][]netip.Addr{{netip.MustParseAddr("169.254.169.254")}}}
	worker.client = worker.policy.client(worker.cfg.Timeout)
	defer worker.client.CloseIdleConnections()
	worker.deliver(context.Background(), testJob("https://example.com/webhook"))
	if s.result.ErrorCode != "destination_blocked" || s.result.Status != "dead" || s.result.NextAttemptAt != nil {
		t.Fatalf("policy rejection was confused with a retryable DNS failure %+v", s.result)
	}
}

func TestTLSCertificateFailurePersistsSafeRetryAndExhaustion(t *testing.T) {
	var hits atomic.Int32
	receiver := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	receiver.Config.ErrorLog = log.New(io.Discard, "", 0)
	receiver.StartTLS()
	defer receiver.Close()
	s := &recordingStore{}
	worker := testWorker(s)
	defer worker.client.CloseIdleConnections()
	job := testJob(receiver.URL)
	worker.deliver(context.Background(), job)
	if hits.Load() != 0 || s.result.ErrorCode != "tls_error" || s.result.Status != "retrying" || s.result.NextAttemptAt == nil {
		t.Fatalf("incorrect TLS failure result %+v", s.result)
	}
	job.AttemptNumber = worker.cfg.MaxAttempts
	worker.deliver(context.Background(), job)
	if s.result.ErrorCode != "tls_error" || s.result.Status != "dead" || s.result.NextAttemptAt != nil {
		t.Fatalf("TLS failure did not exhaust the attempt budget %+v", s.result)
	}
}

func TestConnectionFailurePersistsSafeRetry(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	s := &recordingStore{}
	worker := testWorker(s)
	defer worker.client.CloseIdleConnections()
	worker.deliver(context.Background(), testJob("http://"+address+"/private-endpoint"))
	if s.result.ErrorCode != "connection_error" || s.result.Status != "retrying" || s.result.NextAttemptAt == nil {
		t.Fatalf("incorrect connection failure result %+v", s.result)
	}
}

type errorTransport struct{ err error }

func (transport errorTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, transport.err
}

func TestTransportClassificationPreservesPolicyAndUnknownErrors(t *testing.T) {
	for _, tt := range []struct {
		name, code, status string
		err                error
	}{
		{"policy", "destination_blocked", "dead", ErrDestinationBlocked},
		{"cancellation", "interrupted", "retrying", context.Canceled},
		{"socket read timeout", "timeout", "retrying", &net.OpError{Op: "read", Net: "tcp", Err: context.DeadlineExceeded}},
		{"socket read failure", "connection_error", "retrying", &net.OpError{Op: "read", Net: "tcp", Err: errors.New("private socket details")}},
		{"TLS record", "tls_error", "retrying", tls.RecordHeaderError{Msg: "private record details"}},
		{"TLS alert", "tls_error", "retrying", tls.AlertError(40)},
		{"unknown", "network_error", "retrying", errors.New("tls: receiver-controlled string is not a typed TLS error")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := &recordingStore{}
			worker := testWorker(s)
			worker.client.Transport = errorTransport{err: tt.err}
			worker.deliver(context.Background(), testJob("https://example.com/private-endpoint"))
			if s.result.ErrorCode != tt.code || s.result.Status != tt.status || (s.result.NextAttemptAt != nil) != (tt.status == "retrying") {
				t.Fatalf("incorrect transport failure result %+v", s.result)
			}
		})
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
