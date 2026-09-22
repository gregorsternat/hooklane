// Package config validates the process environment before the server starts.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	HTTPAddr         string
	DatabaseURL      string
	WebDir           string
	LogLevel         slog.Level
	ReadinessTimeout time.Duration
	ShutdownTimeout  time.Duration
}

func Load() (Config, error) {
	c := Config{
		HTTPAddr:    value("HTTP_ADDR", "127.0.0.1:8088"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		WebDir:      os.Getenv("WEB_DIR"),
	}
	_, port, err := net.SplitHostPort(c.HTTPAddr)
	if err != nil {
		return Config{}, errors.New("HTTP_ADDR must be a host:port address")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return Config{}, errors.New("HTTP_ADDR port must be between 1 and 65535")
	}
	if c.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if _, err := pgxpool.ParseConfig(c.DatabaseURL); err != nil {
		// Driver errors may contain the connection string, including credentials.
		return Config{}, errors.New("DATABASE_URL is invalid")
	}
	if err := c.LogLevel.UnmarshalText([]byte(value("LOG_LEVEL", "info"))); err != nil {
		return Config{}, errors.New("LOG_LEVEL must be debug, info, warn, or error")
	}
	if c.ReadinessTimeout, err = duration("READINESS_TIMEOUT", "2s"); err != nil {
		return Config{}, err
	}
	if c.ShutdownTimeout, err = duration("SHUTDOWN_TIMEOUT", "10s"); err != nil {
		return Config{}, err
	}
	if c.ReadinessTimeout >= 10*time.Second {
		return Config{}, errors.New("READINESS_TIMEOUT must be less than the 10s HTTP write timeout")
	}
	if c.WebDir != "" {
		info, err := os.Stat(filepath.Join(c.WebDir, "index.html"))
		if err != nil || !info.Mode().IsRegular() {
			return Config{}, errors.New("WEB_DIR must contain a readable index.html file")
		}
	}
	return c, nil
}

func value(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func duration(key, fallback string) (time.Duration, error) {
	d, err := time.ParseDuration(value(key, fallback))
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", key)
	}
	return d, nil
}
