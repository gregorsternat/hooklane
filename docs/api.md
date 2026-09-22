# HTTP API and receiver protocol

Base path: `/api/v1`. Use JSON with `Content-Type: application/json`. Full machine
readable schemas are in [openapi.json](openapi.json). The service returns safe
errors as `{"error":{"code":"…","message":"…"}}`; no database or receiver error
text is reflected. All examples below assume environment variables are already
set without printing their values.

## Authentication

Use `Authorization: Bearer <ADMIN_TOKEN>` for management. A separate optional
`INGEST_TOKEN` only permits `POST /events`; it cannot list event metadata, create
destinations or replay work. Both tokens authorize the complete installation,
not individual destinations. Use HTTPS outside local development.

The UI signs in with `POST /session` and `{"token":"…"}`. Success sets a twelve-hour
HttpOnly SameSite=Strict cookie. `GET /session` validates it; `DELETE /session`
clears it. Session routes remain available while database initialization retries.
Cookie-authenticated mutations require a same-origin `Origin` header;
bearer-authenticated producers do not. Tokens/secrets never appear in responses.

## Create a destination

```sh
curl --fail-with-body http://localhost:8088/api/v1/destinations \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Orders","url":"https://receiver.example.com/webhooks","signing_secret":"replace-with-a-random-secret-of-at-least-32-characters","enabled":true}'
```

Supply your own random secret and configure the receiver with the same value.
Destination URLs require HTTPS/public addresses by default. They cannot contain
userinfo, query parameters or fragments. The create response is `201` and includes
`id`, `name`, `url`, `enabled`, `archived`, `revision`, `created_at` and `updated_at`.
The console exposes Copy ID and a destination-specific integration example using
the current instance URL. It never displays the token or signing secret.

`PUT /destinations/{id}` updates name/URL, optionally rotates the signing secret,
and changes `enabled`. Send `If-Match: "<revision>"` with the revision returned by
the last read. Missing preconditions return `428 precondition_required`; a stale
revision returns `412 destination_conflict` without changing configuration. Fetch
the destination again and reconcile the newer values with your draft before
retrying. Every configuration mutation advances the revision.
Empty/omitted secret preserves the current secret; omitted
`enabled` preserves the current state on update. Updates require both `name` and
`url`. Keeping the same URL permits editing during a DNS outage; changing it
revalidates destination policy.

`PATCH /destinations/{id}/enabled` accepts only `{"enabled":false}` (pause) or
`{"enabled":true}` (resume). It changes no other configuration and returns current
destination metadata. It needs no revision precondition: an older view can pause
without reverting a newer URL, name or signing secret. A disabled destination is paused:
new events persist but are not claimed. `DELETE /destinations/{id}` archives it,
cancels queued work and blocks new ingestion/replay. Already claimed work may finish.

## Accept an event

Assign the key once for a business occurrence, then reuse the same key and exact
content when retrying. A new occurrence requires a new key.

```sh
IDEMPOTENCY_KEY='order-481-created'
curl --fail-with-body http://localhost:8088/api/v1/events \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  --data '{"destination_id":"REPLACE_WITH_DESTINATION_ID","type":"order.created","payload":{"order_id":"481"}}'
```

`type` is 1–120 visible ASCII characters. `payload` is any JSON value (object,
array, string, number, boolean or null), limited to 1 MiB by default. Its exact
encoded bytes inside the envelope are stored and delivered; do not reformat it
between idempotent retries. The entire envelope also has a bounded size allowance.

A new event returns `202` with `{event, delivery, duplicate:false}` **after commit**.
Repeat the same key for that destination with the same type and exact payload bytes
to receive `200` with the original IDs and `duplicate:true`. Different content
returns `409`. An idempotent retry does not reset retries or create another delivery.
Matching committed requests can still be retrieved by retry after destination
archive; archive blocks requests with new keys.

`Idempotency-Key` is required, with 1–128 visible ASCII characters. A lost response
or timeout is ambiguous: retry the identical request with the same key. Keys remain
protected only while their event remains in retention. Event metadata contains
payload byte length and SHA-256, never payload contents.

## Receiving and verifying

Each attempt sends `POST` with the original JSON payload and these headers:

| Header | Meaning |
| --- | --- |
| `Content-Type` | `application/json` |
| `Webhook-Id` | Stable event ID, shared by retries and replays |
| `Webhook-Timestamp` | Unix seconds when this attempt was sent |
| `Webhook-Signature` | `v1,` followed by lowercase hex HMAC-SHA256 |
| `X-Hooklane-Delivery-Id` | Delivery ID; replay creates a new one |
| `X-Hooklane-Attempt` | Attempt number starting at 1 |
| `X-Hooklane-Event-Type` | Accepted event type |
| `User-Agent` | `Hooklane/1.0` |

The authenticated message is the concatenation:

```text
event_id + "." + timestamp + "." + exact_request_body_bytes
```

Compute HMAC-SHA256 with the **literal UTF-8 signing secret** as the key. Hex encode
the result and prefix it with `v1,`. Compare signatures in constant time. Reject
missing/invalid headers and timestamps more than five minutes from the receiver's
clock. Read the raw body before JSON parsing and maintain synchronized clocks.
This is Hooklane's documented protocol; it is not an assertion of interoperability
with every vendor's similarly named headers or secret encodings.

Persistently deduplicate `Webhook-Id` atomically with business changes. Return a
2xx for an already completed event without repeating its effects. A replay keeps
the same event ID; use it to recover missing processing, not to force repeated
business side effects. A new business occurrence should use a new ingestion key.
The [Go receiver](../examples/receiver) demonstrates verification and bounded
in-memory deduplication for development.

## Outcomes and retries

Any `2xx` succeeds. Network failures, timeouts, `408`, `425`, `429` and `5xx` retry.
Other `4xx` and all `3xx` are terminal; redirects are never followed. A blocked
destination is terminal. Eight attempts are allowed by default, including the
first and attempts abandoned by crashes. An exhausted delivery becomes `dead`.

The retry delay doubles from `RETRY_BASE` with equal jitter (half to full delay),
capped at one hour. Valid `Retry-After` seconds or HTTP dates can extend that delay
up to one hour. Attempts, their safe error codes/status, durations and next schedule
are persisted. Receiver bodies/headers are discarded and never shown in history.

States are `pending`, `delivering`, `retrying`, `succeeded`, `dead`, `canceled`.
Attempt history may additionally show `abandoned` for expired claims. Pause does
not change the persisted delivery state. Lowering the configured attempt budget
also exhausts previously queued work that has already reached the new budget.

Safe error codes describe actionable categories, never raw transport messages:

| Code | Next investigation step |
| --- | --- |
| `dns_error` | Check the destination hostname and DNS resolver availability |
| `tls_error` | Check certificate trust, validity and hostname matching |
| `connection_error` | Check receiver availability, listener and network routing |
| `timeout` | Check receiver latency and the configured delivery deadline |
| `network_error` | Check connectivity; a more precise safe category was unavailable |
| `destination_blocked` | Correct the URL or explicit outbound network policy before replay |
| `attempts_exhausted` | Resolve the underlying issue, then replay with a fresh attempt budget |
| `secret_decryption_failed` | Repair or rotate signing material with the correct installation key, then replay |
| `interrupted` | A process interruption canceled the request; receipt may be ambiguous |
| `lease_expired` | A claim expired before a result was recorded; a later attempt may duplicate receipt |
| `destination_archived` | The destination is permanently archived; queued work cannot resume |
| `http_error` | Inspect the HTTP status and the receiver's own logs |

New attempts retain `destination_revision`, captured when the worker claims the
request. Later destination edits do not change it. Pre-upgrade attempts return
`null`, since their historical revision is unknown. This is a configuration
identity, not a stored copy of the signing secret or event body.

## Inspect, replay and redact

| Endpoint | Result |
| --- | --- |
| `GET /stats` | Retained-record counts, queue categories and oldest eligible queued age from one snapshot |
| `GET /destinations` | Paginated destinations, including archived records |
| `GET /destinations/{id}` | Destination metadata |
| `GET /events` | Paginated metadata; `destination_id` and exact `type` filters |
| `GET /events/{id}` | `{event, deliveries, recovered_by}` with the latest 100 deliveries and successful replay recovery |
| `GET /deliveries` | Paginated deliveries; `destination_id`, `event_id`, `status` filters |
| `GET /deliveries/{id}` | Delivery/attempt metadata, destination, effective attempt budget, scheduling state, replay eligibility and recovery |
| `POST /deliveries/{id}/replay` | New work for a terminal delivery, preserving history |
| `POST /deliveries/{id}/cancel` | `204` for pending/retrying or already canceled work; delivering/succeeded/dead work conflicts |
| `DELETE /events/{id}/payload` | `204` for terminal-only redaction; keeps metadata and prevents new replay |
| `GET /metrics` | Protected Prometheus text exposition |

All lists accept `limit` (1–100, default 25) and `before` (the previous `next_cursor`).
Responses are `{items:[],next_cursor:null|string}` sorted by descending time-prefixed
ID. Reuse filters while paging. A null cursor means there are no more results in
that snapshot. Concurrent new arrivals belong on the first page. IDs contain a
millisecond prefix and random suffix, so ordering within one millisecond is not
insertion order. Replays beyond the event detail cap are available through
`GET /deliveries?event_id=…`.

The console keeps delivery filters and the `before` cursor in its hash route.
Browser Back, return links and a shared URL restore the investigation. Direct
event/delivery ID lookup opens the corresponding metadata view. Overview metrics
link to the related histories.

Statistics cover **all retained history**, not a time-window cohort. They count
delivery records, including replays. The console success rate is
`succeeded / (succeeded + dead)`; active and canceled records are excluded. A
successful replay does not remove a historical failure. `recovered_by` links a
failed source to a successful descendant, including replay of replay, while the
event view identifies a successful replay descending from a failure. These facts describe
recorded delivery outcomes, not a guarantee about receiver business processing.
Retention deletes event/delivery/attempt history and can reduce counts and change
the rate. All retained-row Prometheus series remain gauges.

Queue counts distinguish `paused`, `eligible` (due and claimable) and `scheduled`
(future due time); `oldest_eligible_queued_age_seconds` is time since the oldest
eligible due schedule, or zero if none. Paused work is excluded from that age.
The detail's `max_attempts` is the effective configured budget for this process,
and `scheduling_state` distinguishes pause, scheduled retry, eligible work,
in-flight work, terminal work and exhausted work awaiting finalization.

Replay requires its own `Idempotency-Key`. It returns `202` with
`{delivery,duplicate:false}`, or `200` for a matching previously committed replay.
For new replay work, the source must be terminal, the destination unarchived and
payload still retained. A paused destination accepts replay into its queue. A
previously committed replay key still returns its existing work after redaction or
archive, while that history remains retained. `replay_of` links the new delivery
to its source.

Delivery details include `replay: {eligible, reason}` before confirmation.
`payload_redacted` and `destination_archived` are permanent restrictions;
`delivery_not_terminal` may be resolved by a later state refresh. The POST checks
again under locks and returns distinct `409` codes (`payload_redacted`,
`destination_unavailable`, `delivery_not_terminal`) if eligibility changed
after the read. An eligibility snapshot never reserves replay rights.

Malformed inputs return `400`, unauthenticated access `401`, cookie-origin
violations `403`, missing resources `404`, state/idempotency conflicts `409`,
stale destination revisions `412`, oversized requests `413`, unsupported content
type `415`, missing destination preconditions `428`, sign-in throttling `429`,
and unavailable storage/initialization `503`. Safe error details and a request's
status should inform retries; never generate a new idempotency key merely because
a response was lost.

The composer keeps a rejected draft editable after a definitive validation
rejection. After an ambiguous outcome (including network failure or unavailable
storage), it preserves the submitted bytes and idempotency key for an identical
retry. Do not change content or switch keys to work around an uncertain result.
