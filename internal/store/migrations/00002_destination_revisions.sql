-- +goose Up
ALTER TABLE destinations ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
-- Older attempts intentionally remain unknown: their historical configuration
-- cannot be reconstructed safely from the current destination.
ALTER TABLE attempts ADD COLUMN destination_revision bigint CHECK (destination_revision > 0);
CREATE INDEX deliveries_replay_lineage ON deliveries(replay_of) WHERE replay_of IS NOT NULL;

-- +goose Down
DROP INDEX deliveries_replay_lineage;
ALTER TABLE attempts DROP COLUMN destination_revision;
ALTER TABLE destinations DROP COLUMN revision;
