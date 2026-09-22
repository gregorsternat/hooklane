-- name: GetDestination :one
SELECT id,name,url,enabled,archived,created_at,updated_at,revision FROM destinations WHERE id=$1;

-- name: ListDestinations :many
SELECT id,name,url,enabled,archived,created_at,updated_at,revision FROM destinations WHERE (sqlc.arg(before_id)::text = '' OR id < sqlc.arg(before_id)) ORDER BY id DESC LIMIT sqlc.arg(page_limit);

-- name: GetEvent :one
SELECT id,destination_id,event_type,payload_bytes,payload_sha256,(payload IS NULL)::boolean AS redacted,created_at FROM events WHERE id=$1;

-- name: ListEvents :many
SELECT id,destination_id,event_type,payload_bytes,payload_sha256,(payload IS NULL)::boolean AS redacted,created_at FROM events
WHERE (sqlc.arg(before_id)::text = '' OR id < sqlc.arg(before_id))
AND (sqlc.arg(destination_id)::text = '' OR destination_id=sqlc.arg(destination_id))
AND (sqlc.arg(event_type)::text = '' OR event_type=sqlc.arg(event_type))
ORDER BY id DESC LIMIT sqlc.arg(page_limit);

-- name: GetDelivery :one
SELECT id,event_id,destination_id,COALESCE(replay_of,'')::text AS replay_of,status,attempt_count,next_attempt_at,last_status_code,last_error,created_at,updated_at FROM deliveries WHERE id=$1;

-- name: ListDeliveries :many
SELECT id,event_id,destination_id,COALESCE(replay_of,'')::text AS replay_of,status,attempt_count,next_attempt_at,last_status_code,last_error,created_at,updated_at FROM deliveries
WHERE (sqlc.arg(before_id)::text = '' OR id < sqlc.arg(before_id))
AND (sqlc.arg(destination_id)::text = '' OR destination_id=sqlc.arg(destination_id))
AND (sqlc.arg(event_id)::text = '' OR event_id=sqlc.arg(event_id))
AND (sqlc.arg(status)::text = '' OR status=sqlc.arg(status) OR (sqlc.arg(status)='active' AND status IN ('pending','retrying','delivering')))
ORDER BY id DESC LIMIT sqlc.arg(page_limit);

-- name: EventDeliveries :many
SELECT id,event_id,destination_id,COALESCE(replay_of,'')::text AS replay_of,status,attempt_count,next_attempt_at,last_status_code,last_error,created_at,updated_at FROM deliveries WHERE event_id=$1 ORDER BY id DESC LIMIT 100;

-- name: DeliveryAttempts :many
SELECT id,number,status,status_code,error_code,duration_ms,started_at,finished_at,destination_revision FROM attempts WHERE delivery_id=$1 ORDER BY number;

-- name: Stats :one
WITH work AS (
 SELECT d.*, t.enabled, t.archived, e.payload IS NOT NULL AS payload_available
 FROM deliveries d JOIN destinations t ON t.id=d.destination_id JOIN events e ON e.id=d.event_id
), queued AS (
 SELECT *, NOT archived AND payload_available AND attempt_count < sqlc.arg(max_attempts)::integer AS claimable
 FROM work WHERE status IN ('pending','retrying')
)
SELECT
 (SELECT count(*) FROM destinations WHERE NOT archived) AS destinations,
 (SELECT count(*) FROM events) AS events,
 count(*) FILTER (WHERE status='pending') AS pending,
 count(*) FILTER (WHERE status='retrying') AS retrying,
 count(*) FILTER (WHERE status='delivering') AS delivering,
 count(*) FILTER (WHERE status='succeeded') AS succeeded,
 count(*) FILTER (WHERE status='dead') AS dead,
 count(*) FILTER (WHERE status='canceled') AS canceled,
 (SELECT count(*) FROM queued WHERE claimable AND NOT enabled) AS paused,
 (SELECT count(*) FROM queued WHERE claimable AND enabled AND next_attempt_at<=now()) AS eligible,
 (SELECT count(*) FROM queued WHERE claimable AND enabled AND next_attempt_at>now()) AS scheduled,
 (SELECT COALESCE(max(EXTRACT(EPOCH FROM now()-next_attempt_at)),0)::double precision FROM queued WHERE claimable AND enabled AND next_attempt_at<=now()) AS oldest_eligible_queued_age_seconds
FROM work;

-- name: RecoveredDelivery :one
WITH RECURSIVE lineage AS (
 SELECT source.id,source.status FROM deliveries source WHERE source.replay_of=$1
 UNION ALL
 SELECT d.id,d.status FROM deliveries d JOIN lineage l ON d.replay_of=l.id
)
SELECT id FROM lineage WHERE status='succeeded' ORDER BY id DESC LIMIT 1;

-- name: RecoveredEvent :one
WITH RECURSIVE lineage AS (
 SELECT source.id,source.status FROM deliveries source WHERE source.event_id=$1 AND source.status='dead'
 UNION
 SELECT d.id,d.status FROM deliveries d JOIN lineage l ON d.replay_of=l.id
)
SELECT id FROM lineage WHERE status='succeeded' ORDER BY id DESC LIMIT 1;
