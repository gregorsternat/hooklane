# Development receiver

This Go example verifies the exact-body HMAC signature and a five-minute timestamp
window, then acknowledges the event. It logs only event/delivery IDs. Its bounded
in-memory deduplication demonstrates the protocol; production receivers must
persist deduplication atomically with business effects.

From the repository root, set a random secret locally and run:

```sh
export HOOKLANE_SIGNING_SECRET="$(openssl rand -hex 32)"
go run ./examples/receiver
```

Use that same secret when creating the destination. The example listens on
`127.0.0.1:8099` at `/webhook`. For a **locally running Go API**, configure:

```dotenv
ALLOW_HTTP_DESTINATIONS=true
DESTINATION_ALLOWED_CIDRS=127.0.0.1/32
```

Restart the API and add `http://127.0.0.1:8099/webhook`. The web console has a
composer for sending a JSON event. `FAIL_FIRST=2` simulates two temporary failures;
`LISTEN_ADDR` changes the receiver's listen address. Never expose this diagnostic
receiver as a production business endpoint.

Inside Docker, `127.0.0.1` refers to the application container. Run the receiver
on the same Docker network, listen on `0.0.0.0:8099`, use its service hostname and
explicitly permit that network's private CIDR. `make smoke` builds this topology
in an isolated temporary Compose project and verifies signed retry/replay.

See the [API guide](../../docs/api.md) for the headers and signature format. Replays
preserve `Webhook-Id`; a receiver that already processed the event should return
a success without repeating its business effect.
