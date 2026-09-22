package store

import (
	"context"

	storedb "github.com/gregorsternat/hooklane/internal/store/sqlc"
	"github.com/jackc/pgx/v5"
)

func destination(row storedb.GetDestinationRow) Destination {
	return Destination{ID: row.ID, Name: row.Name, URL: row.Url, Enabled: row.Enabled, Archived: row.Archived, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func event(row storedb.GetEventRow) Event {
	return Event{ID: row.ID, DestinationID: row.DestinationID, Type: row.EventType, PayloadBytes: int(row.PayloadBytes), PayloadSHA256: row.PayloadSha256, Redacted: row.Redacted, CreatedAt: row.CreatedAt}
}
func delivery(row storedb.GetDeliveryRow) Delivery {
	return Delivery{ID: row.ID, EventID: row.EventID, DestinationID: row.DestinationID, ReplayOf: row.ReplayOf, Status: row.Status, AttemptCount: int(row.AttemptCount), NextAttemptAt: row.NextAttemptAt, LastStatusCode: int(row.LastStatusCode), LastError: row.LastError, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func (s *Store) GetDestination(ctx context.Context, id string) (Destination, error) {
	row, err := s.queries.GetDestination(ctx, id)
	return destination(row), normalizeError(err)
}
func (s *Store) ListDestinations(ctx context.Context, page Page) ([]Destination, error) {
	rows, err := s.queries.ListDestinations(ctx, storedb.ListDestinationsParams{BeforeID: page.Before, PageLimit: limit(page)})
	if err != nil {
		return nil, err
	}
	out := make([]Destination, 0, len(rows))
	for _, row := range rows {
		out = append(out, destination(storedb.GetDestinationRow(row)))
	}
	return out, nil
}
func (s *Store) ListEvents(ctx context.Context, f EventFilter) ([]Event, error) {
	rows, err := s.queries.ListEvents(ctx, storedb.ListEventsParams{BeforeID: f.Before, DestinationID: f.DestinationID, EventType: f.Type, PageLimit: limit(f.Page)})
	if err != nil {
		return nil, err
	}
	out := make([]Event, 0, len(rows))
	for _, row := range rows {
		out = append(out, event(storedb.GetEventRow(row)))
	}
	return out, nil
}
func (s *Store) ListDeliveries(ctx context.Context, f DeliveryFilter) ([]Delivery, error) {
	rows, err := s.queries.ListDeliveries(ctx, storedb.ListDeliveriesParams{BeforeID: f.Before, DestinationID: f.DestinationID, EventID: f.EventID, Status: f.Status, PageLimit: limit(f.Page)})
	if err != nil {
		return nil, err
	}
	out := make([]Delivery, 0, len(rows))
	for _, row := range rows {
		out = append(out, delivery(storedb.GetDeliveryRow(row)))
	}
	return out, nil
}
func (s *Store) GetEvent(ctx context.Context, id string) (EventDetail, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return EventDetail{}, err
	}
	defer rollback(ctx, tx)
	q := s.queries.WithTx(tx)
	e, err := q.GetEvent(ctx, id)
	if err != nil {
		return EventDetail{}, normalizeError(err)
	}
	rows, err := q.EventDeliveries(ctx, id)
	if err != nil {
		return EventDetail{}, err
	}
	out := EventDetail{Event: event(e), Deliveries: make([]Delivery, 0, len(rows))}
	for _, row := range rows {
		out.Deliveries = append(out.Deliveries, delivery(storedb.GetDeliveryRow(row)))
	}
	return out, tx.Commit(ctx)
}
func (s *Store) GetDelivery(ctx context.Context, id string) (DeliveryDetail, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return DeliveryDetail{}, err
	}
	defer rollback(ctx, tx)
	q := s.queries.WithTx(tx)
	d, err := q.GetDelivery(ctx, id)
	if err != nil {
		return DeliveryDetail{}, normalizeError(err)
	}
	rows, err := q.DeliveryAttempts(ctx, id)
	if err != nil {
		return DeliveryDetail{}, err
	}
	out := DeliveryDetail{Delivery: delivery(d), Attempts: make([]Attempt, 0, len(rows))}
	for _, a := range rows {
		out.Attempts = append(out.Attempts, Attempt{ID: a.ID, Number: int(a.Number), Status: a.Status, StatusCode: int(a.StatusCode), ErrorCode: a.ErrorCode, DurationMS: a.DurationMs, StartedAt: a.StartedAt, FinishedAt: a.FinishedAt})
	}
	return out, tx.Commit(ctx)
}
func (s *Store) Stats(ctx context.Context) (Stats, error) {
	row, err := s.queries.Stats(ctx)
	return Stats(row), err
}
