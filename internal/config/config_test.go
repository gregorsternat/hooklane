package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func cleanEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"HTTP_ADDR", "DATABASE_URL", "WEB_DIR", "LOG_LEVEL", "READINESS_TIMEOUT", "SHUTDOWN_TIMEOUT"} {
		t.Setenv(key, "")
	}
	t.Setenv("DATABASE_URL", "postgres://hooklane:local@localhost:5438/hooklane?sslmode=disable")
}

func TestDefaults(t *testing.T) {
	cleanEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPAddr != "127.0.0.1:8088" || cfg.ReadinessTimeout != 2*time.Second || cfg.ShutdownTimeout != 10*time.Second {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestInvalidConfiguration(t *testing.T) {
	for _, tt := range []struct{ key, value string }{
		{"DATABASE_URL", ""},
		{"DATABASE_URL", "postgres://user:secret@[invalid"},
		{"HTTP_ADDR", "localhost"},
		{"HTTP_ADDR", ":0"},
		{"HTTP_ADDR", ":65536"},
		{"LOG_LEVEL", "verbose"},
		{"READINESS_TIMEOUT", "0s"},
		{"READINESS_TIMEOUT", "10s"},
		{"READINESS_TIMEOUT", "soon"},
		{"SHUTDOWN_TIMEOUT", "-1s"},
		{"WEB_DIR", "/does-not-exist"},
	} {
		t.Run(tt.key+"="+tt.value, func(t *testing.T) {
			cleanEnv(t)
			t.Setenv(tt.key, tt.value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), tt.key) {
				t.Fatalf("expected validation error for %s, got %v", tt.key, err)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("configuration error leaked credentials")
			}
		})
	}
}

func TestWebDirectory(t *testing.T) {
	cleanEnv(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("Hooklane"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEB_DIR", dir)
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
