package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	storedb "github.com/gregorsternat/hooklane/internal/store/sqlc"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store owns encrypted signing material and PostgreSQL delivery state.
type Store struct {
	pool        *pgxpool.Pool
	queries     *storedb.Queries
	cipher      cipher.AEAD
	maxAttempts int
}

func New(pool *pgxpool.Pool, key []byte, maxAttempts int) (*Store, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	if maxAttempts < 1 {
		return nil, errors.New("positive attempt limit is required")
	}
	if len(key) != 32 {
		return nil, errors.New("encryption key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("initialize encryption: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("initialize encryption: %w", err)
	}
	return &Store{pool: pool, queries: storedb.New(pool), cipher: aead, maxAttempts: maxAttempts}, nil
}

func newID(prefix string) string {
	return fmt.Sprintf("%s_%012x%s", prefix, time.Now().UnixMilli(), hex.EncodeToString(randBytes(12)))
}
func randBytes(n int) []byte { p := make([]byte, n); _, _ = rand.Read(p); return p }
func (s *Store) encrypt(id, secret string) []byte {
	nonce := randBytes(s.cipher.NonceSize())
	return s.cipher.Seal(nonce, nonce, []byte(secret), []byte(id))
}
func (s *Store) decrypt(id string, value []byte) (string, error) {
	n := s.cipher.NonceSize()
	if len(value) < n {
		return "", errors.New("invalid encrypted destination secret")
	}
	clear, err := s.cipher.Open(nil, value[:n], value[n:], []byte(id))
	if err != nil {
		return "", errors.New("cannot decrypt destination secret")
	}
	return string(clear), nil
}
func normalizeError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func limit(page Page) int32 {
	if page.Limit <= 0 {
		return 50
	}
	if page.Limit > 201 {
		return 201
	}
	return int32(page.Limit)
}
func rollback(ctx context.Context, tx pgx.Tx) { _ = tx.Rollback(ctx) }

type scanner interface{ Scan(...any) error }

const destinationColumns = `id,name,url,enabled,archived,created_at,updated_at,revision`
const deliveryColumns = `id,event_id,destination_id,COALESCE(replay_of,''),status,attempt_count,next_attempt_at,last_status_code,last_error,created_at,updated_at`
const eventColumns = `id,destination_id,event_type,payload_bytes,payload_sha256,payload IS NULL,created_at`

func scanDestination(row scanner) (Destination, error) {
	var d Destination
	err := row.Scan(&d.ID, &d.Name, &d.URL, &d.Enabled, &d.Archived, &d.CreatedAt, &d.UpdatedAt, &d.Revision)
	return d, normalizeError(err)
}
func scanDelivery(row scanner) (Delivery, error) {
	var d Delivery
	err := row.Scan(&d.ID, &d.EventID, &d.DestinationID, &d.ReplayOf, &d.Status, &d.AttemptCount, &d.NextAttemptAt, &d.LastStatusCode, &d.LastError, &d.CreatedAt, &d.UpdatedAt)
	return d, normalizeError(err)
}
func scanEvent(row scanner) (Event, error) {
	var e Event
	err := row.Scan(&e.ID, &e.DestinationID, &e.Type, &e.PayloadBytes, &e.PayloadSHA256, &e.Redacted, &e.CreatedAt)
	return e, normalizeError(err)
}

func (s *Store) CreateDestination(ctx context.Context, in DestinationInput) (Destination, error) {
	if in.SigningSecret == "" {
		return Destination{}, fmt.Errorf("signing secret is required")
	}
	id := newID("dst")
	return scanDestination(s.pool.QueryRow(ctx, `INSERT INTO destinations(id,name,url,secret_cipher,enabled) VALUES($1,$2,$3,$4,$5) RETURNING `+destinationColumns, id, in.Name, in.URL, s.encrypt(id, in.SigningSecret), in.Enabled))
}
func (s *Store) UpdateDestination(ctx context.Context, id string, in DestinationInput) (Destination, error) {
	var secret []byte
	if in.SigningSecret != "" {
		secret = s.encrypt(id, in.SigningSecret)
	}
	// A conditional update serializes concurrent editors without holding a lock
	// during URL validation at the HTTP boundary.
	d, err := scanDestination(s.pool.QueryRow(ctx, `UPDATE destinations SET name=$2,url=$3,secret_cipher=COALESCE($4,secret_cipher),enabled=$5,updated_at=now(),revision=revision+1 WHERE id=$1 AND NOT archived AND revision=$6 RETURNING `+destinationColumns, id, in.Name, in.URL, secret, in.Enabled, in.Revision))
	if errors.Is(err, ErrNotFound) {
		existing, e := s.GetDestination(ctx, id)
		if e != nil {
			return Destination{}, e
		}
		if existing.Archived {
			return Destination{}, ErrUnavailable
		}
		return Destination{}, ErrDestinationConflict
	}
	return d, err
}

func (s *Store) SetDestinationEnabled(ctx context.Context, id string, enabled bool) (Destination, error) {
	d, err := scanDestination(s.pool.QueryRow(ctx, `UPDATE destinations SET enabled=$2,updated_at=now(),revision=revision+1 WHERE id=$1 AND NOT archived RETURNING `+destinationColumns, id, enabled))
	if errors.Is(err, ErrNotFound) {
		existing, e := s.GetDestination(ctx, id)
		if e != nil {
			return Destination{}, e
		}
		if existing.Archived {
			return Destination{}, ErrUnavailable
		}
	}
	return d, err
}
func (s *Store) ArchiveDestination(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	tag, err := tx.Exec(ctx, `UPDATE destinations SET archived=true,enabled=false,updated_at=now(),revision=revision+1 WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, err = tx.Exec(ctx, `UPDATE deliveries SET status='canceled',next_attempt_at=NULL,last_error='destination_archived',updated_at=now() WHERE destination_id=$1 AND status IN ('pending','retrying')`, id)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ValidateKey catches accidental installation-key changes before workers claim
// queued events. It returns no ciphertext, plaintext, or database credentials.
func (s *Store) ValidateKey(ctx context.Context) error {
	var id string
	var encrypted []byte
	err := s.pool.QueryRow(ctx, `SELECT id,secret_cipher FROM destinations ORDER BY id LIMIT 1`).Scan(&id, &encrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return errors.New("cannot verify encryption key")
	}
	if _, err = s.decrypt(id, encrypted); err != nil {
		return errors.New("encryption key cannot decrypt stored destination secrets")
	}
	return nil
}
