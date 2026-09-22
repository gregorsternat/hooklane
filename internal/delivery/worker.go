package delivery

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gregorsternat/hooklane/internal/store"
)

type Config struct {
	Concurrency  int
	MaxAttempts  int
	Timeout      time.Duration
	PollInterval time.Duration
	RetryBase    time.Duration
	Retention    time.Duration
}

type Worker struct {
	store  store.WorkerStore
	cfg    Config
	policy Policy
	client *http.Client
	logger *slog.Logger
}

func New(s store.WorkerStore, cfg Config, policy Policy, logger *slog.Logger) *Worker {
	return &Worker{store: s, cfg: cfg, policy: policy, client: policy.client(cfg.Timeout), logger: logger}
}

// Run starts a fixed number of claimers and returns only after they have stopped.
func (w *Worker) Run(ctx context.Context) {
	defer w.client.CloseIdleConnections()
	var wg sync.WaitGroup
	for range w.cfg.Concurrency {
		wg.Go(func() { w.loop(ctx) })
	}
	wg.Go(func() { w.retention(ctx) })
	wg.Wait()
}

func (w *Worker) loop(ctx context.Context) {
	for ctx.Err() == nil {
		claimCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		job, err := w.store.Claim(claimCtx, w.cfg.Timeout+15*time.Second, w.cfg.MaxAttempts)
		cancel()
		if err != nil && ctx.Err() == nil {
			w.logger.Warn("delivery claim unavailable")
		}
		if err != nil || job == nil {
			if !pause(ctx, w.cfg.PollInterval) {
				return
			}
			continue
		}
		w.deliver(ctx, job)
	}
}

func (w *Worker) deliver(ctx context.Context, job *store.Job) {
	start := time.Now()
	result := store.Completion{DeliveryID: job.DeliveryID, ClaimToken: job.ClaimToken}
	requestCtx, cancel := context.WithTimeout(ctx, w.cfg.Timeout)
	defer cancel()
	code, retryAfter, errCode := w.send(requestCtx, job)
	result.StatusCode = code
	result.ErrorCode = errCode
	result.DurationMS = time.Since(start).Milliseconds()
	switch {
	case code >= 200 && code < 300:
		result.Status = "succeeded"
	case job.AttemptNumber >= w.cfg.MaxAttempts || (code >= 300 && code < 500 && code != 408 && code != 425 && code != 429) || errCode == "destination_blocked":
		result.Status = "dead"
	default:
		result.Status = "retrying"
		delay := backoff(w.cfg.RetryBase, job.AttemptNumber)
		if retryAfter > delay {
			delay = retryAfter
		}
		next := time.Now().Add(delay)
		result.NextAttemptAt = &next
	}
	// Recording shutdown cancellation has a short independent deadline. A failed
	// database write leaves the lease recoverable; it never pretends success.
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer finishCancel()
	applied, err := w.store.Finish(finishCtx, result)
	if err != nil {
		w.logger.Warn("delivery result could not be persisted", "delivery_id", job.DeliveryID)
		return
	}
	if applied {
		w.logger.Info("delivery attempt finished", "delivery_id", job.DeliveryID, "attempt", job.AttemptNumber, "status", result.Status, "status_code", code, "duration_ms", result.DurationMS)
	}
}

func (w *Worker) send(ctx context.Context, job *store.Job) (int, time.Duration, string) {
	if _, err := w.policy.parse(job.URL); err != nil {
		return 0, 0, "destination_blocked"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, job.URL, bytes.NewReader(job.Payload))
	if err != nil {
		return 0, 0, "destination_blocked"
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Hooklane/1.0")
	req.Header.Set("Webhook-Id", job.EventID)
	req.Header.Set("Webhook-Timestamp", timestamp)
	req.Header.Set("Webhook-Signature", Signature(job.SigningSecret, job.EventID, timestamp, job.Payload))
	req.Header.Set("X-Hooklane-Delivery-Id", job.DeliveryID)
	req.Header.Set("X-Hooklane-Attempt", strconv.Itoa(job.AttemptNumber))
	req.Header.Set("X-Hooklane-Event-Type", job.EventType)
	resp, err := w.client.Do(req)
	if err != nil {
		if errors.Is(err, ErrDestinationBlocked) {
			return 0, 0, "destination_blocked"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return 0, 0, "timeout"
		}
		if errors.Is(err, context.Canceled) {
			return 0, 0, "interrupted"
		}
		return 0, 0, "network_error"
	}
	defer func() { _ = resp.Body.Close() }()
	// Discard a bounded response; receiver data never enters history or logs.
	_, _ = io.CopyN(io.Discard, resp.Body, 4096)
	code := "http_error"
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		code = ""
	}
	return resp.StatusCode, parseRetryAfter(resp.Header.Get("Retry-After"), time.Now()), code
}

// Signature authenticates the exact payload and stable event identity. Receivers
// should enforce a five-minute timestamp tolerance and deduplicate Webhook-Id.
func Signature(secret, eventID, timestamp string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(eventID + "." + timestamp + "."))
	_, _ = mac.Write(payload)
	return "v1," + hex.EncodeToString(mac.Sum(nil))
}

func backoff(base time.Duration, attempt int) time.Duration {
	delay := base
	for i := 1; i < attempt && delay < time.Hour; i++ {
		delay *= 2
	}
	if delay > time.Hour {
		delay = time.Hour
	}
	return delay/2 + time.Duration(rand.Int64N(int64(delay/2)+1))
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	var delay time.Duration
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds <= 0 {
			return 0
		}
		if seconds > 3600 {
			return time.Hour
		}
		delay = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(value); err == nil {
		delay = at.Sub(now)
	}
	if delay < 0 {
		return 0
	}
	if delay > time.Hour {
		return time.Hour
	}
	return delay
}

func (w *Worker) retention(ctx context.Context) {
	for ctx.Err() == nil {
		runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		n, err := w.store.Retain(runCtx, w.cfg.Retention)
		cancel()
		if err != nil && ctx.Err() == nil {
			w.logger.Warn("retention pass unavailable")
		}
		if n > 0 {
			w.logger.Info("retention completed", "events_deleted", n)
		}
		if !pause(ctx, time.Minute) {
			return
		}
	}
}

func pause(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
