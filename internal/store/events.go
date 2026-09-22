package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

func (s *Store) Ingest(ctx context.Context, in IngestInput) (IngestResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return IngestResult{}, err
	}
	defer rollback(ctx, tx)
	var archived bool
	if err = tx.QueryRow(ctx, `SELECT archived FROM destinations WHERE id=$1 FOR SHARE`, in.DestinationID).Scan(&archived); err != nil {
		return IngestResult{}, normalizeError(err)
	}
	sum := sha256.Sum256(in.Payload)
	digest := hex.EncodeToString(sum[:])
	id := newID("evt")
	payload := in.Payload
	if payload == nil {
		payload = []byte{}
	}
	var e Event
	duplicate := false
	// An accepted request remains discoverable after archival. Returning its
	// existing work cannot enqueue a new delivery, so eligibility is checked only
	// once we know this key has no committed result.
	if in.IdempotencyKey != "" {
		e, err = scanEvent(tx.QueryRow(ctx, `SELECT `+eventColumns+` FROM events WHERE destination_id=$1 AND idempotency_key=$2`, in.DestinationID, in.IdempotencyKey))
		duplicate = err == nil
		if err != nil && !errors.Is(err, ErrNotFound) {
			return IngestResult{}, err
		}
	}
	if !duplicate {
		if archived {
			return IngestResult{}, ErrUnavailable
		}
		e, err = scanEvent(tx.QueryRow(ctx, `INSERT INTO events(id,destination_id,event_type,idempotency_key,payload,payload_bytes,payload_sha256) VALUES($1,$2,$3,NULLIF($4,''),$5,$6,$7) ON CONFLICT (destination_id,idempotency_key) DO NOTHING RETURNING `+eventColumns, id, in.DestinationID, in.Type, in.IdempotencyKey, payload, len(payload), digest))
		duplicate = errors.Is(err, ErrNotFound)
		if duplicate {
			e, err = scanEvent(tx.QueryRow(ctx, `SELECT `+eventColumns+` FROM events WHERE destination_id=$1 AND idempotency_key=$2`, in.DestinationID, in.IdempotencyKey))
		}
		if err != nil {
			return IngestResult{}, err
		}
	}
	if duplicate && (e.Type != in.Type || e.PayloadSHA256 != digest || e.PayloadBytes != len(payload)) {
		return IngestResult{}, ErrConflict
	}
	var d Delivery
	if duplicate {
		d, err = scanDelivery(tx.QueryRow(ctx, `SELECT `+deliveryColumns+` FROM deliveries WHERE event_id=$1 AND replay_of IS NULL`, e.ID))
	} else {
		d, err = scanDelivery(tx.QueryRow(ctx, `INSERT INTO deliveries(id,event_id,destination_id,next_attempt_at) VALUES($1,$2,$3,now()) RETURNING `+deliveryColumns, newID("dlv"), e.ID, in.DestinationID))
	}
	if err != nil {
		return IngestResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return IngestResult{}, err
	}
	return IngestResult{Event: e, Delivery: d, Duplicate: duplicate}, nil
}

func (s *Store) Replay(ctx context.Context, id, key string) (Delivery, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Delivery{}, false, err
	}
	defer rollback(ctx, tx)
	// Lock in the same order as archive/ingest: destination, event, delivery.
	var destinationID, eventID string
	if err = tx.QueryRow(ctx, `SELECT destination_id,event_id FROM deliveries WHERE id=$1`, id).Scan(&destinationID, &eventID); err != nil {
		return Delivery{}, false, normalizeError(err)
	}
	var archived bool
	if err = tx.QueryRow(ctx, `SELECT archived FROM destinations WHERE id=$1 FOR SHARE`, destinationID).Scan(&archived); err != nil {
		return Delivery{}, false, normalizeError(err)
	}
	var available bool
	if err = tx.QueryRow(ctx, `SELECT payload IS NOT NULL FROM events WHERE id=$1 FOR UPDATE`, eventID).Scan(&available); err != nil {
		return Delivery{}, false, normalizeError(err)
	}
	// Return an existing replay even if retention/redaction subsequently changed
	// eligibility, so retrying a committed request remains idempotent.
	if key != "" {
		existing, e := scanDelivery(tx.QueryRow(ctx, `SELECT `+deliveryColumns+` FROM deliveries WHERE replay_of=$1 AND replay_key=$2`, id, key))
		if e == nil {
			return existing, true, tx.Commit(ctx)
		}
		if !errors.Is(e, ErrNotFound) {
			return Delivery{}, false, e
		}
	}
	if archived {
		return Delivery{}, false, ErrUnavailable
	}
	if !available {
		return Delivery{}, false, ErrConflict
	}
	original, err := scanDelivery(tx.QueryRow(ctx, `SELECT `+deliveryColumns+` FROM deliveries WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return Delivery{}, false, err
	}
	if !terminal(original.Status) {
		return Delivery{}, false, ErrConflict
	}
	d, err := scanDelivery(tx.QueryRow(ctx, `INSERT INTO deliveries(id,event_id,destination_id,replay_of,replay_key,next_attempt_at) VALUES($1,$2,$3,$4,NULLIF($5,''),now()) RETURNING `+deliveryColumns, newID("dlv"), eventID, destinationID, id, key))
	if err != nil {
		return Delivery{}, false, err
	}
	return d, false, tx.Commit(ctx)
}
func terminal(status string) bool {
	return status == "succeeded" || status == "dead" || status == "canceled"
}

func (s *Store) Cancel(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	var status string
	if err = tx.QueryRow(ctx, `SELECT status FROM deliveries WHERE id=$1 FOR UPDATE`, id).Scan(&status); err != nil {
		return normalizeError(err)
	}
	if status == "canceled" {
		return tx.Commit(ctx)
	}
	if status != "pending" && status != "retrying" {
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `UPDATE deliveries SET status='canceled',next_attempt_at=NULL,last_error='canceled',updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) Redact(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	var exists string
	if err = tx.QueryRow(ctx, `SELECT id FROM events WHERE id=$1 FOR UPDATE`, id).Scan(&exists); err != nil {
		return normalizeError(err)
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deliveries WHERE event_id=$1 AND status IN ('pending','retrying','delivering'))`, id).Scan(&active); err != nil {
		return err
	}
	if active {
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `UPDATE events SET payload=NULL WHERE id=$1`, id); err != nil {
		return fmt.Errorf("redact event: %w", err)
	}
	return tx.Commit(ctx)
}
