package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gregorsternat/hooklane/internal/config"
	"github.com/gregorsternat/hooklane/internal/delivery"
	"github.com/gregorsternat/hooklane/internal/httpserver"
	"github.com/gregorsternat/hooklane/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, logger); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("invalid database configuration")
	}
	poolConfig.MaxConns = int32(cfg.WorkerConcurrency + 10)
	poolConfig.ConnConfig.ConnectTimeout = cfg.ReadinessTimeout
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return errors.New("could not initialize database pool")
	}
	defer pool.Close()
	state, err := store.New(pool, cfg.EncryptionKey)
	if err != nil {
		return errors.New("could not initialize encrypted storage")
	}
	policy := delivery.Policy{AllowHTTP: cfg.AllowHTTPDestinations, AllowedCIDRs: cfg.AllowedCIDRs}
	worker := delivery.New(state, delivery.Config{Concurrency: cfg.WorkerConcurrency, MaxAttempts: cfg.MaxAttempts, Timeout: cfg.DeliveryTimeout, PollInterval: cfg.PollInterval, RetryBase: cfg.RetryBase, Retention: cfg.Retention}, policy, logger)
	var migrated atomic.Bool
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		for workerCtx.Err() == nil {
			migrationCtx, cancel := context.WithTimeout(workerCtx, 30*time.Second)
			err := store.Migrate(migrationCtx, pool)
			if err == nil {
				err = state.ValidateKey(migrationCtx)
				if err != nil && workerCtx.Err() == nil {
					logger.Warn("database encryption validation failed; check ENCRYPTION_KEY")
				}
			}
			cancel()
			if err == nil {
				migrated.Store(true)
				logger.Info("database schema ready")
				worker.Run(workerCtx)
				return
			}
			if workerCtx.Err() != nil {
				return
			}
			logger.Warn("database initialization unavailable; retrying")
			timer := time.NewTimer(3 * time.Second)
			select {
			case <-workerCtx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	defer func() { stopWorker(); <-workerDone }()
	// Liveness remains available during outages or migration; readiness gates traffic.
	probe := func(ctx context.Context) error {
		if !migrated.Load() {
			return errors.New("schema not ready")
		}
		return pool.Ping(ctx)
	}
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpserver.NewAPIHandler(probe, cfg.ReadinessTimeout, cfg.WebDir, state, httpserver.Options{AdminToken: cfg.AdminToken, IngestToken: cfg.IngestToken, SecureCookies: cfg.SecureCookies, MaxPayloadBytes: cfg.MaxPayloadBytes, ValidateURL: policy.ValidateURL, Ready: migrated.Load}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	result := make(chan error, 1)
	go func() { result <- server.ListenAndServe() }()
	logger.Info("HTTP server starting", "address", cfg.HTTPAddr)
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		logger.Info("HTTP server shutting down")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		_ = server.Close()
		return errors.New("HTTP shutdown deadline exceeded")
	}
	if err := <-result; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	logger.Info("HTTP server stopped")
	return nil
}
