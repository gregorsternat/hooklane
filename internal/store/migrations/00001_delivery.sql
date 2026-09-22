-- +goose Up
CREATE TABLE destinations (
 id text PRIMARY KEY,
 name text NOT NULL,
 url text NOT NULL,
 secret_cipher bytea NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
 id text PRIMARY KEY,
 destination_id text NOT NULL REFERENCES destinations(id),
 event_type text NOT NULL,
 idempotency_key text,
 payload bytea,
 payload_bytes integer NOT NULL CHECK (payload_bytes >= 0),
 payload_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (destination_id, idempotency_key)
);
CREATE INDEX events_destination_page ON events(destination_id, id DESC);
CREATE INDEX events_retention ON events(created_at);
CREATE TABLE deliveries (
 id text PRIMARY KEY,
 event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 destination_id text NOT NULL REFERENCES destinations(id),
 replay_of text REFERENCES deliveries(id) ON DELETE CASCADE,
 replay_key text,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retrying','delivering','succeeded','dead','canceled')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
 next_attempt_at timestamptz,
 last_status_code integer NOT NULL DEFAULT 0,
 last_error text NOT NULL DEFAULT '',
 claim_token text,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (replay_of, replay_key)
);
CREATE INDEX deliveries_due ON deliveries(next_attempt_at, id) WHERE status IN ('pending','retrying');
CREATE INDEX deliveries_expired ON deliveries(lease_until) WHERE status = 'delivering';
CREATE INDEX deliveries_event ON deliveries(event_id, id DESC);
CREATE INDEX deliveries_destination_page ON deliveries(destination_id, id DESC);
CREATE INDEX deliveries_status_page ON deliveries(status, id DESC);
CREATE TABLE attempts (
 id text PRIMARY KEY,
 delivery_id text NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
 number integer NOT NULL,
 status text NOT NULL CHECK (status IN ('delivering','succeeded','retrying','dead','abandoned')),
 status_code integer NOT NULL DEFAULT 0,
 error_code text NOT NULL DEFAULT '',
 duration_ms bigint NOT NULL DEFAULT 0,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE (delivery_id, number)
);
-- +goose Down
DROP TABLE attempts;
DROP TABLE deliveries;
DROP TABLE events;
DROP TABLE destinations;
