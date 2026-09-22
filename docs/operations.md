# Operating Hooklane

## Configuration

`make setup` generates missing local secrets; production must inject stable secrets
through its secret manager or a protected environment file. Configuration is
validated before HTTP startup. No secret belongs in `VITE_*` browser variables.

| Variable | Default / bounds |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL URI or pgx keyword connection string |
| `ADMIN_TOKEN` | Required, 32–512 visible ASCII characters, no whitespace; full installation access |
| `INGEST_TOKEN` | Optional separate 32–512 visible ASCII characters, no whitespace; only `POST /api/v1/events`; must differ from admin |
| `ENCRYPTION_KEY` | Required 64 hex characters representing 32 random bytes |
| `HTTP_ADDR` | `127.0.0.1:8088` locally; `0.0.0.0:8088` inside Compose |
| `WEB_DIR` | Empty disables static files; `/app/web` in Docker |
| `LOG_LEVEL` | `info`; `debug`, `warn`, `error` also accepted |
| `SECURE_COOKIES` | `false` locally; **true behind HTTPS** |
| `READINESS_TIMEOUT` | `2s`, positive and below `10s` |
| `SHUTDOWN_TIMEOUT` | `10s`, positive; keep below Compose's `30s` stop grace period |
| `MAX_PAYLOAD_BYTES` | `1048576` (1 MiB), range 1 byte–10 MiB; JSON envelope has an additional bounded allowance |
| `WORKER_CONCURRENCY` | `4`, range 1–32 concurrent requests per process |
| `DELIVERY_TIMEOUT` | `10s`, range `1s`–`60s`, entire outbound request |
| `WORKER_POLL_INTERVAL` | `1s`, range `50ms`–`1m` |
| `RETRY_BASE` | `5s`, range `100ms`–`1h`; exponential equal jitter, capped at `1h` |
| `MAX_ATTEMPTS` | `8`, range 1–20, including the initial attempt; also limits lease recoveries |
| `RETENTION` | `720h` (30 days), range `1h`–`87600h`; terminal events only |
| `ALLOW_HTTP_DESTINATIONS` | `false`; deliberate opt-in for unencrypted local/internal receivers |
| `DESTINATION_ALLOWED_CIDRS` | Empty; comma-separated private/loopback CIDRs explicitly permitted for outbound requests |
| `API_PROXY_TARGET` | Vite only, `http://127.0.0.1:8088` |
| `APP_PORT` / `POSTGRES_PORT` | Compose loopback host ports `8088` / `5438` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Compose database settings; replace local sample values for deployment |

Compose constructs its database connection from `POSTGRES_*` and its internal DNS
name. It does not use your host's `DATABASE_URL` or `HTTP_ADDR`. Changing a volume's
initialization environment does not change its existing database credentials.
For local development, keep `DATABASE_URL`, ports and `API_PROXY_TARGET` aligned.

## HTTPS deployment

1. Provide strong unique database credentials, admin/ingestion tokens and a stable
   encryption key. Keep the encryption key with separately secured backup material.
2. Deploy the application and PostgreSQL with persistent storage. The runtime image
   is non-root and Compose enables a read-only filesystem and drops capabilities.
3. Put the loopback application behind a TLS reverse proxy. Preserve the original
   `Host` header and set `SECURE_COOKIES=true`. Cookie writes require an `Origin`
   matching HTTPS and that host; do not rewrite it to an internal hostname.
4. Configure the proxy's request body allowance to at least the payload limit plus
   16 KiB. Keep request timeouts above the API's bounded operation time and add
   installation-appropriate connection/rate limits at the edge.
5. Restrict the database to the private service network. Use verified TLS when
   PostgreSQL runs outside the same trusted host/network.
6. Probe `/healthz` for process liveness and `/readyz` for traffic readiness. Startup
   runs migrations and validates the encryption key before permitting data routes.
7. Restrict egress at the host/network layer. App-level URL and DNS controls are
   useful boundaries but cannot describe every private route in your environment.

For example, a Caddy reverse proxy on the host can use:

```caddyfile
hooks.example.com {
    reverse_proxy 127.0.0.1:8088
}
```

HTTPS termination alone does not change app configuration: enable secure cookies
and restrict direct access to its HTTP listener. The console is for trusted
administrators. v1 has no per-user roles or per-destination token scopes.

## Tokens and signing-key rotation

The admin token authorizes every management endpoint. An optional ingestion token
can only create events, for any active or paused destination. Producers should
never use the admin token when a separate ingestion token is configured.

Browser sessions last twelve hours, are signed with the admin token, and are held
in HttpOnly SameSite=Strict cookies. Logout clears that browser cookie; stateless
sessions are not individually revocable. Rotate `ADMIN_TOKEN` and restart all
replicas to invalidate all sessions. Rotate `INGEST_TOKEN` and update producers
when its access needs revocation; v1 accepts one current token of each kind.

Destination signing secrets are encrypted in PostgreSQL. A destination update
with a nonempty secret rotates it; an empty/omitted secret retains it. Allow both
old and new secrets on the receiver while already-claimed requests finish.
URL changes similarly affect future claims, including queued events and replays.

`ENCRYPTION_KEY` is a data-encryption key, not an access token. Do not regenerate it
on restart. v1 does not provide in-place master-key rotation. A wrong key keeps
the API unready and logs a safe diagnostic; recover the original key. A corrupted
individual secret encountered by a worker ends that delivery with
`secret_decryption_failed` and requires operator repair/rotation and replay. If the
corrupted record is the first destination checked at startup, initialization stays
unavailable; restore that signing material from a matching backup before restarting.

## Outbound destinations

Default destinations require HTTPS and public addresses. URLs cannot contain
credentials, query parameters or fragments. Signing secrets belong in the signing
configuration, never in URLs. Requests do not follow redirects or inherit HTTP
proxy environment variables. TLS certificates are verified against the original
hostname. Every new connection re-resolves and checks all returned addresses.

For an internal destination, permit only its necessary CIDR. Allowing a broad
private network gives administrators outbound access to it. Loopback CIDRs target
the application's own host/container. HTTP must be enabled separately. Link-local,
cloud metadata, multicast and reserved addresses remain blocked even with broad
CIDR configuration. Public IPs routed to privileged services by your own network
must also be denied through egress firewall policy.

## Retention, backups and restore

The payload is stored as exact bytes in PostgreSQL for delivery. It is excluded
from read APIs, logs and UI inspection, but **is not encrypted by Hooklane in the
database**. Use encrypted storage, restrict database/backups access and define an
appropriate retention period. Signing secrets are application-encrypted.

Each process runs cleanup at startup and waits one minute between passes. Each
pass deletes at most 500 expired terminal events with their associated
deliveries/attempts. The age is measured from event creation; an old
event may be removed soon after its final replay finishes. Active and paused
queued work is retained until terminal. Monitor backlog and disk space. Manual
redaction removes only the payload after all deliveries terminate. Retained
metadata/hash and existing backups remain subject to your privacy policy.
Idempotency keys expire with retention: old producer retries can then create new
work. Receiver deduplication should match your business requirements.

Create a consistent database backup (the following writes to a local file):

```sh
umask 077
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > hooklane.dump
```

Store the matching `ENCRYPTION_KEY` separately and securely. A database dump alone
cannot recover encrypted signing material. Back up deployment configuration and
record the application revision/migration version with each backup.

To rehearse restore, use a separate installation/database and its matching key;
keep its worker egress blocked or its destinations paused to avoid delivering
restored work to production. Start only PostgreSQL, then restore:

```sh
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < hooklane.dump
```

This assumes an empty target database and does not replace existing tables. Start
the corresponding application revision, verify readiness and historical counts,
and deliberately enable delivery only after checking the restored destinations.
Rehearse restore; merely creating a backup is not a recovery test.

## Upgrades

Back up the database and encryption key, review migration changes, then build and
start the new revision. Migrations are embedded, transactional and serialized
across replicas. Readiness stays false until migration/key validation completes.
On failure inspect safe application logs and PostgreSQL health, correct the cause
and restart/retry. Do not automatically run down migrations on a populated system;
rollback may require restoring the matching backup and previous application.

## Monitoring and practical limits

`GET /api/v1/metrics` exposes authenticated Prometheus gauges for destinations,
retained events and deliveries per state. Scrape with the admin bearer token over
HTTPS or a protected internal connection. Gauges describe current retained rows;
retention makes them decrease, so they are not lifetime counters. `/api/v1/stats`
backs the console with the same counts.

Alert on unready status, growing pending/retrying/dead counts, PostgreSQL disk
usage and repeated claim/result-persistence warnings. Logs include delivery IDs,
attempt numbers, status codes and elapsed time, never payloads, receiver bodies,
signing secrets or database connection strings. Expired claims leave abandoned
attempts in history; success followed by an unrecorded commit can be duplicated.

Defaults limit each process to four outbound requests and a pool of fourteen
connections (`WORKER_CONCURRENCY + 10`). Multiple processes can claim safely but
multiply database connections and outbound concurrency. Slow receivers can occupy
all workers. There is no per-destination rate limiter, fairness scheduling or
throughput SLA. Retained-history counts scan tables; benchmark representative
sizes and receiver latency before selecting capacity. Functional/concurrency
checks are described in [verification](verification.md); they are not load tests.
