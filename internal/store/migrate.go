package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Migrate serializes schema changes across replicas with a PostgreSQL session
// advisory lock. The migrations and version marker commit together.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	db := stdlib.OpenDBFromPool(pool)
	defer func() { _ = db.Close() }()
	source, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return fmt.Errorf("open migrations: %w", err)
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("initialize migration lock: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, source, goose.WithSessionLocker(locker), goose.WithDisableGlobalRegistry(true))
	if err != nil {
		return fmt.Errorf("initialize migrations: %w", err)
	}
	if _, err = provider.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}
