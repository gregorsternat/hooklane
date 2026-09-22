// Package config validates the process environment before the server starts.
package config

import (
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	HTTPAddr              string
	DatabaseURL           string
	WebDir                string
	LogLevel              slog.Level
	ReadinessTimeout      time.Duration
	ShutdownTimeout       time.Duration
	AdminToken            string
	IngestToken           string
	EncryptionKey         []byte
	SecureCookies         bool
	AllowHTTPDestinations bool
	AllowedCIDRs          []netip.Prefix
	MaxPayloadBytes       int64
	WorkerConcurrency     int
	DeliveryTimeout       time.Duration
	PollInterval          time.Duration
	RetryBase             time.Duration
	MaxAttempts           int
	Retention             time.Duration
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
	if c.AdminToken = os.Getenv("ADMIN_TOKEN"); len(c.AdminToken) < 32 || len(c.AdminToken) > 512 || !tokenCharacters(c.AdminToken) {
		return Config{}, errors.New("ADMIN_TOKEN must contain 32 to 512 visible ASCII characters without whitespace")
	}
	c.IngestToken = os.Getenv("INGEST_TOKEN")
	if c.IngestToken != "" && (len(c.IngestToken) < 32 || len(c.IngestToken) > 512 || c.IngestToken == c.AdminToken || !tokenCharacters(c.IngestToken)) {
		return Config{}, errors.New("INGEST_TOKEN must contain 32 to 512 visible ASCII characters without whitespace and differ from ADMIN_TOKEN")
	}
	c.EncryptionKey, err = hex.DecodeString(os.Getenv("ENCRYPTION_KEY"))
	if err != nil || len(c.EncryptionKey) != 32 {
		return Config{}, errors.New("ENCRYPTION_KEY must be 64 hexadecimal characters")
	}
	if c.SecureCookies, err = boolean("SECURE_COOKIES", false); err != nil {
		return Config{}, err
	}
	if c.AllowHTTPDestinations, err = boolean("ALLOW_HTTP_DESTINATIONS", false); err != nil {
		return Config{}, err
	}
	for _, raw := range strings.Split(os.Getenv("DESTINATION_ALLOWED_CIDRS"), ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		prefix, e := netip.ParsePrefix(strings.TrimSpace(raw))
		if e != nil {
			return Config{}, errors.New("DESTINATION_ALLOWED_CIDRS must be a comma-separated list of CIDRs")
		}
		c.AllowedCIDRs = append(c.AllowedCIDRs, prefix.Masked())
	}
	var n int
	if n, err = integer("MAX_PAYLOAD_BYTES", 1048576, 1, 10485760); err != nil {
		return Config{}, err
	}
	c.MaxPayloadBytes = int64(n)
	if c.WorkerConcurrency, err = integer("WORKER_CONCURRENCY", 4, 1, 32); err != nil {
		return Config{}, err
	}
	if c.MaxAttempts, err = integer("MAX_ATTEMPTS", 8, 1, 20); err != nil {
		return Config{}, err
	}
	if c.DeliveryTimeout, err = boundedDuration("DELIVERY_TIMEOUT", "10s", time.Second, 60*time.Second); err != nil {
		return Config{}, err
	}
	if c.PollInterval, err = boundedDuration("WORKER_POLL_INTERVAL", "1s", 50*time.Millisecond, time.Minute); err != nil {
		return Config{}, err
	}
	if c.RetryBase, err = boundedDuration("RETRY_BASE", "5s", 100*time.Millisecond, time.Hour); err != nil {
		return Config{}, err
	}
	if c.Retention, err = boundedDuration("RETENTION", "720h", time.Hour, 3650*24*time.Hour); err != nil {
		return Config{}, err
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

func integer(key string, fallback, minValue, maxValue int) (int, error) {
	n, err := strconv.Atoi(value(key, strconv.Itoa(fallback)))
	if err != nil || n < minValue || n > maxValue {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minValue, maxValue)
	}
	return n, nil
}
func boolean(key string, fallback bool) (bool, error) {
	v, err := strconv.ParseBool(value(key, strconv.FormatBool(fallback)))
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return v, nil
}
func boundedDuration(key, fallback string, minValue, maxValue time.Duration) (time.Duration, error) {
	d, err := duration(key, fallback)
	if err != nil {
		return 0, err
	}
	if d < minValue || d > maxValue {
		return 0, fmt.Errorf("%s must be between %s and %s", key, minValue, maxValue)
	}
	return d, nil
}

func tokenCharacters(value string) bool {
	for _, c := range value {
		if c < 33 || c > 126 {
			return false
		}
	}
	return true
}
