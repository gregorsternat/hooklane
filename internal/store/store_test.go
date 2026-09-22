package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	databaseURL := os.Getenv("HOOKLANE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("HOOKLANE_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal("configure test database:", err)
	}
	schema := newID("test")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal("create isolated schema:", err)
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.MaxConns = 24
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close(); _, _ = admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); admin.Close() })
	if err = Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s, err := New(pool, bytes.Repeat([]byte{42}, 32), 3)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func createDestination(t *testing.T, s *Store, enabled bool) Destination {
	t.Helper()
	d, err := s.CreateDestination(context.Background(), DestinationInput{Name: "Test", URL: "https://example.com/hook", SigningSecret: "test-signing-material", Enabled: enabled})
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func ingest(t *testing.T, s *Store, destinationID, key string) IngestResult {
	t.Helper()
	r, err := s.Ingest(context.Background(), IngestInput{DestinationID: destinationID, Type: "test.created", IdempotencyKey: key, Payload: []byte(`{"hello":"world"}`)})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func claim(t *testing.T, s *Store, max int) *Job {
	t.Helper()
	job, err := s.Claim(context.Background(), time.Minute, max)
	if err != nil {
		t.Fatal(err)
	}
	if job == nil {
		t.Fatal("expected a claimed delivery")
	}
	return job
}
func finish(t *testing.T, s *Store, job *Job, status string) {
	t.Helper()
	ok, err := s.Finish(context.Background(), Completion{DeliveryID: job.DeliveryID, ClaimToken: job.ClaimToken, Status: status, StatusCode: 200, DurationMS: 17})
	if err != nil || !ok {
		t.Fatalf("finish=%v, %v", ok, err)
	}
}
func TestEncryptionAndMigration(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, true)
	var ciphertext []byte
	if err := s.pool.QueryRow(ctx, `SELECT secret_cipher FROM destinations WHERE id=$1`, d.ID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("test-signing-material")) {
		t.Fatal("secret stored as plaintext")
	}
	if _, err := s.decrypt("another-destination", ciphertext); err == nil {
		t.Fatal("AAD did not bind destination identity")
	}
	if err := s.ValidateKey(ctx); err != nil {
		t.Fatal(err)
	}
	wrong, err := New(s.pool, bytes.Repeat([]byte{43}, 32), 3)
	if err != nil {
		t.Fatal(err)
	}
	if err = wrong.ValidateKey(ctx); err == nil {
		t.Fatal("wrong encryption key accepted")
	}
	if _, err = s.UpdateDestination(ctx, d.ID, DestinationInput{Name: "Renamed", URL: d.URL, Enabled: true, Revision: d.Revision}); err != nil {
		t.Fatal(err)
	}
	ingest(t, s, d.ID, "")
	job := claim(t, s, 3)
	if job.SigningSecret != "test-signing-material" {
		t.Fatal("empty secret update lost current secret")
	}
	failures := make(chan error, 4)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() { failures <- Migrate(ctx, s.pool) })
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatalf("concurrent migration: %v", err)
		}
	}
}
func TestIngestionIdempotencyAndAtomicity(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, true)
	type outcome struct {
		r IngestResult
		e error
	}
	out := make(chan outcome, 12)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			r, err := s.Ingest(ctx, IngestInput{DestinationID: d.ID, Type: "test.created", IdempotencyKey: "same", Payload: []byte(`{"hello":"world"}`)})
			out <- outcome{r, err}
		})
	}
	wg.Wait()
	close(out)
	firstID := ""
	fresh := 0
	for result := range out {
		if result.e != nil {
			t.Fatal(result.e)
		}
		if firstID == "" {
			firstID = result.r.Event.ID
		}
		if firstID != result.r.Event.ID {
			t.Fatal("concurrent duplicate created different events")
		}
		if !result.r.Duplicate {
			fresh++
		}
	}
	if fresh != 1 {
		t.Fatalf("fresh accepted events=%d, want1", fresh)
	}
	for _, in := range []IngestInput{{DestinationID: d.ID, Type: "different", IdempotencyKey: "same", Payload: []byte(`{"hello":"world"}`)}, {DestinationID: d.ID, Type: "test.created", IdempotencyKey: "same", Payload: []byte(`{"hello": "world"}`)}} {
		if _, err := s.Ingest(ctx, in); !errors.Is(err, ErrConflict) {
			t.Fatalf("conflicting idempotency key error=%v", err)
		}
	}
	other := createDestination(t, s, true)
	if r := ingest(t, s, other.ID, "same"); r.Duplicate {
		t.Fatal("idempotency leaked across destinations")
	}
	if _, err := s.pool.Exec(ctx, `CREATE FUNCTION reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$; CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION reject_delivery()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Ingest(ctx, IngestInput{DestinationID: d.ID, Type: "rollback", Payload: []byte(`{}`)}); err == nil {
		t.Fatal("failed transaction returned success")
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM events WHERE event_type='rollback'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("event survived rolled-back delivery insert")
	}
}
func TestConcurrentClaimsAndFencing(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, true)
	for i := range 16 {
		ingest(t, s, d.ID, fmt.Sprint(i))
	}
	type outcome struct {
		job *Job
		err error
	}
	out := make(chan outcome, 16)
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() { job, err := s.Claim(ctx, time.Minute, 3); out <- outcome{job, err} })
	}
	wg.Wait()
	close(out)
	seen := map[string]bool{}
	var first *Job
	for result := range out {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.job == nil {
			t.Fatal("missing claimed work")
		}
		if seen[result.job.DeliveryID] {
			t.Fatal("delivery claimed twice")
		}
		seen[result.job.DeliveryID] = true
		if first == nil {
			first = result.job
		} else {
			finish(t, s, result.job, "succeeded")
		}
	}
	if _, err := s.pool.Exec(ctx, `UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE id=$1`, first.DeliveryID); err != nil {
		t.Fatal(err)
	}
	ok, err := s.Finish(ctx, Completion{DeliveryID: first.DeliveryID, ClaimToken: first.ClaimToken, Status: "succeeded"})
	if err != nil || ok {
		t.Fatalf("expired lease accepted: %v %v", ok, err)
	}
	recovered := claim(t, s, 3)
	if recovered.DeliveryID != first.DeliveryID || recovered.AttemptNumber != 2 || recovered.ClaimToken == first.ClaimToken {
		t.Fatal("invalid recovered claim")
	}
	ok, err = s.Finish(ctx, Completion{DeliveryID: first.DeliveryID, ClaimToken: first.ClaimToken, Status: "dead"})
	if err != nil || ok {
		t.Fatalf("stale claim overwrote recovery: %v %v", ok, err)
	}
	finish(t, s, recovered, "succeeded")
	detail, err := s.GetDelivery(ctx, first.DeliveryID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Attempts) != 2 || detail.Attempts[0].Status != "abandoned" || detail.Attempts[1].Status != "succeeded" {
		t.Fatalf("attempt history=%+v", detail.Attempts)
	}
}
func TestRetrySchedulingAndCrashExhaustion(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, true)
	r := ingest(t, s, d.ID, "")
	job := claim(t, s, 2)
	future := time.Now().Add(time.Hour)
	ok, err := s.Finish(ctx, Completion{DeliveryID: job.DeliveryID, ClaimToken: job.ClaimToken, Status: "retrying", ErrorCode: "http_5xx", StatusCode: 503, NextAttemptAt: &future})
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if job, err = s.Claim(ctx, time.Minute, 2); err != nil || job != nil {
		t.Fatal("future retry claimed", job, err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE deliveries SET next_attempt_at=now() WHERE id=$1`, r.Delivery.ID); err != nil {
		t.Fatal(err)
	}
	last := claim(t, s, 2)
	if last.AttemptNumber != 2 {
		t.Fatal("attempt count not persisted")
	}
	if _, err = s.pool.Exec(ctx, `UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE id=$1`, last.DeliveryID); err != nil {
		t.Fatal(err)
	}
	if job, err = s.Claim(ctx, time.Minute, 2); err != nil || job != nil {
		t.Fatal("exhausted work reclaimed", job, err)
	}
	detail, err := s.GetDelivery(ctx, last.DeliveryID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Delivery.Status != "dead" || detail.Delivery.LastError != "attempts_exhausted" || len(detail.Attempts) != 2 {
		t.Fatalf("final crash recovery=%+v", detail)
	}
}
func TestReplayRedactionRetentionAndControls(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, false)
	r := ingest(t, s, d.ID, "original")
	if job, err := s.Claim(ctx, time.Minute, 3); err != nil || job != nil {
		t.Fatal("paused destination claimed")
	}
	if err := s.Redact(ctx, r.Event.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("active event redaction allowed", err)
	}
	if _, _, err := s.Replay(ctx, r.Delivery.ID, "replay"); !errors.Is(err, ErrConflict) {
		t.Fatal("active replay allowed", err)
	}
	if _, err := s.UpdateDestination(ctx, d.ID, DestinationInput{Name: d.Name, URL: d.URL, Enabled: true, Revision: d.Revision}); err != nil {
		t.Fatal(err)
	}
	original := claim(t, s, 3)
	if err := s.Cancel(ctx, original.DeliveryID); !errors.Is(err, ErrConflict) {
		t.Fatal("active claim canceled", err)
	}
	finish(t, s, original, "succeeded")
	replay, duplicate, err := s.Replay(ctx, r.Delivery.ID, "replay")
	if err != nil || duplicate || replay.ReplayOf != r.Delivery.ID || replay.EventID != r.Event.ID {
		t.Fatal("bad replay", replay, duplicate, err)
	}
	again, duplicate, err := s.Replay(ctx, r.Delivery.ID, "replay")
	if err != nil || !duplicate || again.ID != replay.ID {
		t.Fatal("replay idempotency", again, duplicate, err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE events SET created_at=now()-interval '40 days' WHERE id=$1`, r.Event.ID); err != nil {
		t.Fatal(err)
	}
	if deleted, err := s.Retain(ctx, 30*24*time.Hour); err != nil || deleted != 0 {
		t.Fatal("retention deleted active replay", deleted, err)
	}
	if err = s.Cancel(ctx, replay.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.Redact(ctx, r.Event.ID); err != nil {
		t.Fatal(err)
	}
	detail, err := s.GetEvent(ctx, r.Event.ID)
	if err != nil || !detail.Event.Redacted || len(detail.Deliveries) != 2 {
		t.Fatal("redaction lost history", detail, err)
	}
	if _, _, err = s.Replay(ctx, r.Delivery.ID, "new-key"); !errors.Is(err, ErrConflict) {
		t.Fatal("redacted payload replayed", err)
	}
	if deleted, err := s.Retain(ctx, 30*24*time.Hour); err != nil || deleted != 1 {
		t.Fatal("terminal retention failed", deleted, err)
	}
	if _, err = s.GetDelivery(ctx, replay.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("retention did not cascade", err)
	}
	queued := ingest(t, s, d.ID, "")
	active := claim(t, s, 3)
	if err = s.ArchiveDestination(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Ingest(ctx, IngestInput{DestinationID: d.ID, Type: "new", Payload: []byte(`{}`)}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("archived ingestion allowed", err)
	}
	finish(t, s, active, "succeeded")
	if _, _, err = s.Replay(ctx, queued.Delivery.ID, "archive"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("archived replay allowed", err)
	}
}
func TestArchivedInflightRetryAndQueueCancellation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, true)
	ingest(t, s, d.ID, "1")
	ingest(t, s, d.ID, "2")
	job := claim(t, s, 3)
	if err := s.ArchiveDestination(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	next := time.Now()
	ok, err := s.Finish(ctx, Completion{DeliveryID: job.DeliveryID, ClaimToken: job.ClaimToken, Status: "retrying", NextAttemptAt: &next})
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	deliveries, err := s.ListDeliveries(ctx, DeliveryFilter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, delivery := range deliveries {
		if delivery.Status != "canceled" {
			t.Fatal("archived work was not canceled", delivery)
		}
	}
}

func TestConcurrentReplayAndRetention(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, true)
	// Both operations contend on the event row. If replay commits successfully,
	// no retention snapshot may erase its newly committed pending work.
	for i := range 40 {
		r := ingest(t, s, d.ID, fmt.Sprint(i))
		finish(t, s, claim(t, s, 3), "succeeded")
		if _, err := s.pool.Exec(ctx, `UPDATE events SET created_at=now()-interval '40 days' WHERE id=$1`, r.Event.ID); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var replay Delivery
		var replayErr, retainErr error
		var wg sync.WaitGroup
		wg.Go(func() { <-start; replay, _, replayErr = s.Replay(ctx, r.Delivery.ID, "once") })
		wg.Go(func() { <-start; _, retainErr = s.Retain(ctx, 30*24*time.Hour) })
		close(start)
		wg.Wait()
		if retainErr != nil {
			t.Fatal(retainErr)
		}
		if replayErr != nil && !errors.Is(replayErr, ErrNotFound) {
			t.Fatal(replayErr)
		}
		if replayErr == nil {
			detail, err := s.GetDelivery(ctx, replay.ID)
			if err != nil || detail.Delivery.Status != "pending" {
				t.Fatal("accepted replay lost to retention", detail, err)
			}
			if err = s.Cancel(ctx, replay.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
}
func TestCursorFiltersAndStats(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, false)
	other := createDestination(t, s, false)
	for i := range 7 {
		ingest(t, s, d.ID, fmt.Sprint(i))
	}
	ingest(t, s, other.ID, "")
	var before string
	seen := map[string]bool{}
	for {
		rows, err := s.ListEvents(ctx, EventFilter{Page: Page{Limit: 2, Before: before}, DestinationID: d.ID, Type: "test.created"})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			if seen[row.ID] || row.DestinationID != d.ID {
				t.Fatal("invalid cursor page", row)
			}
			seen[row.ID] = true
		}
		before = rows[len(rows)-1].ID
	}
	if len(seen) != 7 {
		t.Fatalf("cursor returned %d events", len(seen))
	}
	stats, err := s.Stats(ctx)
	if err != nil || stats.Events != 8 || stats.Pending != 8 || stats.Destinations != 2 {
		t.Fatal("wrong stats", stats, err)
	}
}
func TestArchiveRacingCompletion(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for i := range 20 {
		d := createDestination(t, s, true)
		ingest(t, s, d.ID, fmt.Sprint(i))
		job := claim(t, s, 3)
		next := time.Now()
		start := make(chan struct{})
		var finishErr, archiveErr error
		var wg sync.WaitGroup
		wg.Go(func() {
			<-start
			_, finishErr = s.Finish(ctx, Completion{DeliveryID: job.DeliveryID, ClaimToken: job.ClaimToken, Status: "retrying", NextAttemptAt: &next})
		})
		wg.Go(func() { <-start; archiveErr = s.ArchiveDestination(ctx, d.ID) })
		close(start)
		wg.Wait()
		if finishErr != nil || archiveErr != nil {
			t.Fatal("concurrent archive/finish", finishErr, archiveErr)
		}
		detail, err := s.GetDelivery(ctx, job.DeliveryID)
		if err != nil || detail.Delivery.Status != "canceled" {
			t.Fatal("archived retry stranded", detail, err)
		}
	}
}

func TestIdempotencyResultsSurviveArchival(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d := createDestination(t, s, true)
	original := ingest(t, s, d.ID, "accepted")
	finish(t, s, claim(t, s, 3), "succeeded")
	replay, duplicate, err := s.Replay(ctx, original.Delivery.ID, "accepted-replay")
	if err != nil || duplicate {
		t.Fatal(replay, duplicate, err)
	}
	if err = s.ArchiveDestination(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	existing := ingest(t, s, d.ID, "accepted")
	if !existing.Duplicate || existing.Event.ID != original.Event.ID || existing.Delivery.ID != original.Delivery.ID {
		t.Fatal("archival lost ingestion result", existing)
	}
	again, duplicate, err := s.Replay(ctx, original.Delivery.ID, "accepted-replay")
	if err != nil || !duplicate || again.ID != replay.ID || again.Status != "canceled" {
		t.Fatal("archival lost replay result", again, duplicate, err)
	}
	if _, err = s.Ingest(ctx, IngestInput{DestinationID: d.ID, Type: "test.created", IdempotencyKey: "new-key", Payload: []byte(`{}`)}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("archived destination accepted new key", err)
	}
	if _, _, err = s.Replay(ctx, original.Delivery.ID, "new-key"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("archived destination accepted new replay", err)
	}
	if _, err = s.Ingest(ctx, IngestInput{DestinationID: d.ID, Type: "test.created", IdempotencyKey: "accepted", Payload: []byte(`{}`)}); !errors.Is(err, ErrConflict) {
		t.Fatal("archived destination accepted mismatched idempotent content", err)
	}
}

func TestDestinationRevisionPreventsLostUpdates(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	original := createDestination(t, s, true)
	updated, err := s.UpdateDestination(ctx, original.ID, DestinationInput{Name: original.Name, URL: "https://example.com/new", Enabled: true, Revision: original.Revision})
	if err != nil {
		t.Fatal(err)
	}
	paused, err := s.SetDestinationEnabled(ctx, original.ID, false)
	if err != nil || paused.URL != updated.URL || paused.Enabled || paused.Revision != updated.Revision+1 {
		t.Fatalf("pause lost new configuration: %+v %v", paused, err)
	}
	if _, err = s.UpdateDestination(ctx, original.ID, DestinationInput{Name: "Stale", URL: original.URL, Enabled: true, Revision: original.Revision}); !errors.Is(err, ErrDestinationConflict) {
		t.Fatalf("stale update: %v", err)
	}
	current, err := s.GetDestination(ctx, original.ID)
	if err != nil || current != paused {
		t.Fatalf("stale update mutated destination: %+v %v", current, err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, name := range []string{"First", "Second"} {
		wg.Go(func() {
			_, err := s.UpdateDestination(ctx, original.ID, DestinationInput{Name: name, URL: paused.URL, Enabled: false, Revision: paused.Revision})
			results <- err
		})
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrDestinationConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent saves: success=%d conflict=%d", successes, conflicts)
	}
}

func TestReplayEligibilityAndDescendantRecovery(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	dest := createDestination(t, s, true)
	original := ingest(t, s, dest.ID, "lineage")
	detail, err := s.GetDelivery(ctx, original.Delivery.ID)
	if err != nil || detail.Replay.Eligible || detail.Replay.Reason == nil || *detail.Replay.Reason != "delivery_not_terminal" {
		t.Fatalf("active eligibility: %+v %v", detail, err)
	}
	if _, _, err = s.Replay(ctx, original.Delivery.ID, "active"); !errors.Is(err, ErrDeliveryNotTerminal) {
		t.Fatalf("active replay: %v", err)
	}
	finish(t, s, claim(t, s, 3), "succeeded")
	failed, _, err := s.Replay(ctx, original.Delivery.ID, "failed-replay")
	if err != nil {
		t.Fatal(err)
	}
	finish(t, s, claim(t, s, 3), "dead")
	detail, err = s.GetDelivery(ctx, failed.ID)
	if err != nil || detail.RecoveredBy != nil || !detail.Replay.Eligible {
		t.Fatalf("older ancestor success is not recovery: %+v %v", detail, err)
	}
	intermediate, _, err := s.Replay(ctx, failed.ID, "intermediate")
	if err != nil {
		t.Fatal(err)
	}
	finish(t, s, claim(t, s, 3), "dead")
	recovered, _, err := s.Replay(ctx, intermediate.ID, "recovered")
	if err != nil {
		t.Fatal(err)
	}
	finish(t, s, claim(t, s, 3), "succeeded")
	detail, err = s.GetDelivery(ctx, failed.ID)
	if err != nil || detail.RecoveredBy == nil || *detail.RecoveredBy != recovered.ID || detail.Delivery.Status != "dead" || len(detail.Attempts) != 1 || detail.Attempts[0].Status != "dead" {
		t.Fatalf("descendant recovery lost history: %+v %v", detail, err)
	}
	event, err := s.GetEvent(ctx, original.Event.ID)
	if err != nil || event.RecoveredBy == nil || *event.RecoveredBy != recovered.ID {
		t.Fatalf("event recovery: %+v %v", event, err)
	}
	if err = s.Redact(ctx, original.Event.ID); err != nil {
		t.Fatal(err)
	}
	detail, err = s.GetDelivery(ctx, failed.ID)
	if err != nil || detail.Replay.Eligible || detail.Replay.Reason == nil || *detail.Replay.Reason != "payload_redacted" {
		t.Fatalf("redacted eligibility: %+v %v", detail, err)
	}
	if _, _, err = s.Replay(ctx, failed.ID, "redacted"); !errors.Is(err, ErrPayloadRedacted) {
		t.Fatalf("redacted replay: %v", err)
	}
	if err = s.ArchiveDestination(ctx, dest.ID); err != nil {
		t.Fatal(err)
	}
	detail, err = s.GetDelivery(ctx, failed.ID)
	if err != nil || detail.Replay.Eligible || detail.Replay.Reason == nil || *detail.Replay.Reason != "destination_archived" {
		t.Fatalf("archived eligibility: %+v %v", detail, err)
	}
}

func TestAttemptRevisionAndSchedulingDiagnostics(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	dest := createDestination(t, s, false)
	event := ingest(t, s, dest.ID, "paused")
	detail, err := s.GetDelivery(ctx, event.Delivery.ID)
	if err != nil || detail.SchedulingState != "waiting_for_resume" || detail.MaxAttempts != 3 || detail.Destination.Enabled {
		t.Fatalf("paused diagnostics: %+v %v", detail, err)
	}
	dest, err = s.SetDestinationEnabled(ctx, dest.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	job := claim(t, s, 3)
	oldRevision := dest.Revision
	dest, err = s.UpdateDestination(ctx, dest.ID, DestinationInput{Name: dest.Name, URL: "https://example.com/changed", Enabled: true, Revision: dest.Revision})
	if err != nil {
		t.Fatal(err)
	}
	next := time.Now().Add(time.Hour)
	if ok, err := s.Finish(ctx, Completion{DeliveryID: job.DeliveryID, ClaimToken: job.ClaimToken, Status: "retrying", NextAttemptAt: &next}); err != nil || !ok {
		t.Fatalf("retry: %v %v", ok, err)
	}
	detail, err = s.GetDelivery(ctx, event.Delivery.ID)
	if err != nil || detail.SchedulingState != "scheduled" || len(detail.Attempts) != 1 || detail.Attempts[0].DestinationRevision == nil || *detail.Attempts[0].DestinationRevision != oldRevision || detail.Destination.Revision != dest.Revision {
		t.Fatalf("historical revision: %+v %v", detail, err)
	}
	// A legacy attempt without a revision remains unknown rather than claiming
	// that today's configuration was used historically.
	if _, err = s.pool.Exec(ctx, `UPDATE attempts SET destination_revision=NULL WHERE delivery_id=$1`, job.DeliveryID); err != nil {
		t.Fatal(err)
	}
	detail, err = s.GetDelivery(ctx, event.Delivery.ID)
	if err != nil || detail.Attempts[0].DestinationRevision != nil {
		t.Fatalf("unknown historical revision: %+v %v", detail, err)
	}
}

func TestQueueStatsSeparateEligibilityFromPausedAndFutureWork(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	enabled := createDestination(t, s, true)
	paused := createDestination(t, s, false)
	oldest := ingest(t, s, enabled.ID, "due")
	future := ingest(t, s, enabled.ID, "future")
	exhausted := ingest(t, s, enabled.ID, "exhausted")
	blocked := ingest(t, s, paused.ID, "paused")
	if _, err := s.pool.Exec(ctx, `UPDATE deliveries SET next_attempt_at=now()-interval '2 hours' WHERE id=$1`, oldest.Delivery.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE deliveries SET next_attempt_at=now()+interval '1 hour' WHERE id=$1`, future.Delivery.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE deliveries SET next_attempt_at=now()-interval '1 day',attempt_count=3 WHERE id=$1`, exhausted.Delivery.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE deliveries SET next_attempt_at=now()-interval '2 days' WHERE id=$1`, blocked.Delivery.ID); err != nil {
		t.Fatal(err)
	}
	stats, err := s.Stats(ctx)
	if err != nil || stats.Events != 4 || stats.Pending != 4 || stats.Eligible != 1 || stats.Scheduled != 1 || stats.Paused != 1 || stats.OldestEligibleQueuedAgeSeconds < 7200 || stats.OldestEligibleQueuedAgeSeconds > 7210 {
		t.Fatalf("queue stats: %+v %v", stats, err)
	}
	detail, err := s.GetDelivery(ctx, exhausted.Delivery.ID)
	if err != nil || detail.SchedulingState != "attempts_exhausted" {
		t.Fatalf("exhausted diagnostics: %+v %v", detail, err)
	}
	active, err := s.ListDeliveries(ctx, DeliveryFilter{Status: "active"})
	if err != nil || len(active) != 4 {
		t.Fatalf("active list: %d %v", len(active), err)
	}
	if _, err = s.SetDestinationEnabled(ctx, enabled.ID, false); err != nil {
		t.Fatal(err)
	}
	stats, err = s.Stats(ctx)
	if err != nil || stats.Eligible != 0 || stats.Scheduled != 0 || stats.Paused != 3 || stats.OldestEligibleQueuedAgeSeconds != 0 {
		t.Fatalf("all paused stats: %+v %v", stats, err)
	}
}
