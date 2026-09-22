// Package store persists Hooklane's durable delivery state in PostgreSQL.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	ErrNotFound            = errors.New("not found")
	ErrConflict            = errors.New("conflict")
	ErrUnavailable         = errors.New("destination unavailable")
	ErrDestinationConflict = errors.New("destination revision conflict")
	ErrPayloadRedacted     = fmt.Errorf("payload redacted: %w", ErrConflict)
	ErrDeliveryNotTerminal = fmt.Errorf("delivery is not terminal: %w", ErrConflict)
)

type Destination struct {
	ID        string    `json:"id"`
	Revision  int64     `json:"revision"`
	Name      string    `json:"name"`
	URL       string    `json:"url"`
	Enabled   bool      `json:"enabled"`
	Archived  bool      `json:"archived"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
type DestinationInput struct {
	Name, URL, SigningSecret string
	Enabled                  bool
	Revision                 int64
}
type Event struct {
	ID            string    `json:"id"`
	DestinationID string    `json:"destination_id"`
	Type          string    `json:"type"`
	PayloadBytes  int       `json:"payload_bytes"`
	PayloadSHA256 string    `json:"payload_sha256"`
	Redacted      bool      `json:"redacted"`
	CreatedAt     time.Time `json:"created_at"`
}
type IngestInput struct {
	DestinationID, Type, IdempotencyKey string
	Payload                             []byte
}
type IngestResult struct {
	Event     Event    `json:"event"`
	Delivery  Delivery `json:"delivery"`
	Duplicate bool     `json:"duplicate"`
}
type Delivery struct {
	ID             string     `json:"id"`
	EventID        string     `json:"event_id"`
	DestinationID  string     `json:"destination_id"`
	ReplayOf       string     `json:"replay_of,omitempty"`
	Status         string     `json:"status"`
	AttemptCount   int        `json:"attempt_count"`
	NextAttemptAt  *time.Time `json:"next_attempt_at"`
	LastStatusCode int        `json:"last_status_code"`
	LastError      string     `json:"last_error"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}
type Attempt struct {
	ID                  string     `json:"id"`
	DestinationRevision *int64     `json:"destination_revision"`
	Number              int        `json:"number"`
	Status              string     `json:"status"`
	StatusCode          int        `json:"status_code"`
	ErrorCode           string     `json:"error_code"`
	DurationMS          int64      `json:"duration_ms"`
	StartedAt           time.Time  `json:"started_at"`
	FinishedAt          *time.Time `json:"finished_at"`
}
type EventDetail struct {
	Event       Event      `json:"event"`
	Deliveries  []Delivery `json:"deliveries"`
	RecoveredBy *string    `json:"recovered_by"`
}
type DeliveryDetail struct {
	Delivery        Delivery          `json:"delivery"`
	Attempts        []Attempt         `json:"attempts"`
	Destination     Destination       `json:"destination"`
	MaxAttempts     int               `json:"max_attempts"`
	SchedulingState string            `json:"scheduling_state"`
	Replay          ReplayEligibility `json:"replay"`
	RecoveredBy     *string           `json:"recovered_by"`
}
type ReplayEligibility struct {
	Eligible bool    `json:"eligible"`
	Reason   *string `json:"reason"`
}
type Page struct {
	Limit  int
	Before string
}
type EventFilter struct {
	Page
	DestinationID, Type string
}
type DeliveryFilter struct {
	Page
	DestinationID, EventID, Status string
}
type Stats struct {
	Destinations                   int64   `json:"destinations"`
	Events                         int64   `json:"events"`
	Pending                        int64   `json:"pending"`
	Retrying                       int64   `json:"retrying"`
	Delivering                     int64   `json:"delivering"`
	Succeeded                      int64   `json:"succeeded"`
	Dead                           int64   `json:"dead"`
	Canceled                       int64   `json:"canceled"`
	Paused                         int64   `json:"paused"`
	Eligible                       int64   `json:"eligible"`
	Scheduled                      int64   `json:"scheduled"`
	OldestEligibleQueuedAgeSeconds float64 `json:"oldest_eligible_queued_age_seconds"`
}

// Job is internal worker material. Never serialize it or log it.
type Job struct {
	DeliveryID, EventID, DestinationID, URL, SigningSecret, EventType, ClaimToken string
	Payload                                                                       []byte
	AttemptNumber                                                                 int
}
type Completion struct {
	DeliveryID, ClaimToken, Status, ErrorCode string
	StatusCode                                int
	DurationMS                                int64
	NextAttemptAt                             *time.Time
}

// WorkerStore is the persistence boundary required by the delivery engine.
type WorkerStore interface {
	Claim(context.Context, time.Duration, int) (*Job, error)
	Finish(context.Context, Completion) (bool, error)
	Retain(context.Context, time.Duration) (int64, error)
}
