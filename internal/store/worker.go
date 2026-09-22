package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Claim commits ownership and the attempt before exposing any network material.
// Expired claims are fenced and recovered even when their destination is paused.
func (s *Store) Claim(ctx context.Context, lease time.Duration, maxAttempts int) (*Job, error) {
	if lease <= 0 || maxAttempts < 1 {
		return nil, errors.New("positive lease and attempt limit are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	if err = s.recover(ctx, tx, maxAttempts); err != nil {
		return nil, err
	}
	var job Job
	var encrypted []byte
	var destinationRevision int64
	err = tx.QueryRow(ctx, `SELECT d.id,d.event_id,d.destination_id,t.url,t.secret_cipher,e.event_type,e.payload,d.attempt_count+1,t.revision
 FROM deliveries d JOIN destinations t ON t.id=d.destination_id JOIN events e ON e.id=d.event_id
 WHERE d.status IN ('pending','retrying') AND d.next_attempt_at<=now() AND d.attempt_count<$1 AND t.enabled AND NOT t.archived AND e.payload IS NOT NULL
 ORDER BY d.next_attempt_at,d.id FOR UPDATE OF d SKIP LOCKED FOR SHARE OF t SKIP LOCKED LIMIT 1`, maxAttempts).Scan(&job.DeliveryID, &job.EventID, &job.DestinationID, &job.URL, &encrypted, &job.EventType, &job.Payload, &job.AttemptNumber, &destinationRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	job.ClaimToken = newID("clm")
	_, err = tx.Exec(ctx, `UPDATE deliveries SET status='delivering',attempt_count=$2,claim_token=$3,lease_until=now()+$4*interval '1 second',next_attempt_at=NULL,updated_at=now() WHERE id=$1`, job.DeliveryID, job.AttemptNumber, job.ClaimToken, lease.Seconds())
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO attempts(id,delivery_id,number,status,destination_revision) VALUES($1,$2,$3,'delivering',$4)`, newID("att"), job.DeliveryID, job.AttemptNumber, destinationRevision)
	if err != nil {
		return nil, err
	}
	job.SigningSecret, err = s.decrypt(job.DestinationID, encrypted)
	if err != nil {
		// A damaged row or mismatched installation key must not poison the queue.
		if _, err = tx.Exec(ctx, `UPDATE attempts SET status='dead',error_code='secret_decryption_failed',finished_at=now() WHERE delivery_id=$1 AND number=$2`, job.DeliveryID, job.AttemptNumber); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE deliveries SET status='dead',claim_token=NULL,lease_until=NULL,last_error='secret_decryption_failed',updated_at=now() WHERE id=$1`, job.DeliveryID); err != nil {
			return nil, err
		}
		return nil, tx.Commit(ctx)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &job, nil
}

func (s *Store) recover(ctx context.Context, tx pgx.Tx, maxAttempts int) error {
	rows, err := tx.Query(ctx, `SELECT d.id,d.attempt_count,t.archived FROM deliveries d JOIN destinations t ON t.id=d.destination_id WHERE d.status='delivering' AND d.lease_until<=now() ORDER BY d.lease_until,d.id FOR UPDATE OF d SKIP LOCKED FOR SHARE OF t SKIP LOCKED LIMIT 100`)
	if err != nil {
		return err
	}
	type expired struct {
		id       string
		count    int
		archived bool
	}
	expiredRows := make([]expired, 0)
	for rows.Next() {
		var r expired
		if err = rows.Scan(&r.id, &r.count, &r.archived); err != nil {
			rows.Close()
			return err
		}
		expiredRows = append(expiredRows, r)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, r := range expiredRows {
		if _, err = tx.Exec(ctx, `UPDATE attempts SET status='abandoned',error_code='lease_expired',finished_at=now() WHERE delivery_id=$1 AND number=$2 AND status='delivering'`, r.id, r.count); err != nil {
			return err
		}
		status, reason := "retrying", "lease_expired"
		if r.count >= maxAttempts {
			status, reason = "dead", "attempts_exhausted"
		}
		if r.archived {
			status, reason = "canceled", "destination_archived"
		}
		if _, err = tx.Exec(ctx, `UPDATE deliveries SET status=$2,last_error=$3,claim_token=NULL,lease_until=NULL,next_attempt_at=CASE WHEN $2='retrying' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`, r.id, status, reason); err != nil {
			return err
		}
	}
	// A lower configured attempt budget also applies to previously scheduled work.
	_, err = tx.Exec(ctx, `WITH exhausted AS (SELECT id FROM deliveries WHERE status IN ('pending','retrying') AND attempt_count >= $1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100)
 UPDATE deliveries SET status='dead',last_error='attempts_exhausted',next_attempt_at=NULL,updated_at=now() WHERE id IN (SELECT id FROM exhausted)`, maxAttempts)
	return err
}

// Finish returns false if the lease expired or another worker owns the row.
func (s *Store) Finish(ctx context.Context, c Completion) (bool, error) {
	if c.Status != "succeeded" && c.Status != "retrying" && c.Status != "dead" {
		return false, errors.New("invalid completion status")
	}
	if c.Status == "retrying" && c.NextAttemptAt == nil {
		return false, errors.New("retry completion needs a schedule")
	}
	if c.DurationMS < 0 || c.StatusCode < 0 || c.StatusCode > 599 {
		return false, errors.New("invalid completion metadata")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer rollback(ctx, tx)
	var attempt int
	var archived bool
	// Destination first matches archive's lock order and prevents scheduling a
	// retry after an archive transaction has already canceled the queued work.
	err = tx.QueryRow(ctx, `SELECT t.archived FROM destinations t JOIN deliveries d ON d.destination_id=t.id WHERE d.id=$1 FOR SHARE OF t`, c.DeliveryID).Scan(&archived)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = tx.QueryRow(ctx, `SELECT attempt_count FROM deliveries WHERE id=$1 AND status='delivering' AND claim_token=$2 AND lease_until>now() FOR UPDATE`, c.DeliveryID, c.ClaimToken).Scan(&attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	status, errorCode := c.Status, c.ErrorCode
	next := c.NextAttemptAt
	if c.Status != "retrying" {
		next = nil
	}
	if archived && c.Status == "retrying" {
		status, errorCode, next = "canceled", "destination_archived", nil
	}
	// Attempts retain the actual response result even when archival cancels retry.
	_, err = tx.Exec(ctx, `UPDATE attempts SET status=$3,status_code=$4,error_code=$5,duration_ms=$6,finished_at=now() WHERE delivery_id=$1 AND number=$2`, c.DeliveryID, attempt, c.Status, c.StatusCode, c.ErrorCode, c.DurationMS)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE deliveries SET status=$2,last_status_code=$3,last_error=$4,next_attempt_at=$5,claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, c.DeliveryID, status, c.StatusCode, errorCode, next)
	if err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// Retain deletes at most 500 expired events and their terminal history per call.
// Event locks serialize this operation with replay and manual redaction.
func (s *Store) Retain(ctx context.Context, retention time.Duration) (int64, error) {
	if retention <= 0 {
		return 0, fmt.Errorf("retention must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer rollback(ctx, tx)
	rows, err := tx.Query(ctx, `SELECT e.id FROM events e WHERE e.created_at<now()-$1*interval '1 second'
 AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.event_id=e.id AND d.status IN ('pending','retrying','delivering'))
 ORDER BY e.created_at,e.id FOR UPDATE OF e SKIP LOCKED LIMIT 500`, retention.Seconds())
	if err != nil {
		return 0, err
	}
	ids := make([]string, 0, 500)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	// A fresh READ COMMITTED statement snapshot is essential: replay may have
	// committed between candidate selection and acquiring the event row lock.
	// Held event locks prevent a new replay racing this second eligibility check.
	tag, err := tx.Exec(ctx, `DELETE FROM events e WHERE e.id=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.event_id=e.id AND d.status IN ('pending','retrying','delivering'))`, ids)
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
