#!/usr/bin/env python3
"""Real authenticated API and signed receiver smoke tests (stdlib only)."""
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1]
ADMIN = os.environ['ADMIN_TOKEN']
INGEST = os.environ['INGEST_TOKEN']
SECRET = 'smoke-signing-secret-at-least-32-characters'
# Local smoke traffic must not inherit operating-system or environment proxies.
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))


def request(method, path, data=None, expected=200, token=ADMIN, key=None):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if key:
        headers['Idempotency-Key'] = key
    body = None
    if data is not None:
        body = json.dumps(data, separators=(',', ':')).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, body, headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=8)
    except urllib.error.HTTPError as exc:
        response = exc
    raw = response.read()
    assert response.status == expected, f'{method} {path}: expected {expected}, got {response.status}: {raw[:300]!r}'
    assert SECRET.encode() not in raw, 'signing secret leaked in API response'
    if not raw:
        return None
    if response.headers.get('Content-Type', '').startswith('application/json'):
        return json.loads(raw)
    return raw.decode()


def wait_delivery(delivery_id, expected='succeeded'):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        detail = request('GET', '/api/v1/deliveries/' + delivery_id)
        if detail['delivery']['status'] == expected:
            return detail
        if detail['delivery']['status'] in ('dead', 'canceled') and expected == 'succeeded':
            raise AssertionError(f'Delivery ended unexpectedly: {detail}')
        time.sleep(0.2)
    raise AssertionError('Delivery did not finish within 30 seconds')


def main():
    request('GET', '/api/v1/stats', expected=401, token=None)
    request('GET', '/api/v1/stats', expected=401, token=INGEST)
    request('GET', '/api/v1/metrics', expected=401, token=None)
    jar = http.cookiejar.CookieJar()
    browser = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    sign_in = urllib.request.Request(BASE + '/api/v1/session', json.dumps({'token': ADMIN}).encode(),
                                    {'Content-Type': 'application/json', 'Origin': BASE}, method='POST')
    with browser.open(sign_in, timeout=8) as response:
        assert json.load(response)['authenticated']
    assert any(cookie.name == 'hooklane_session' for cookie in jar)
    with browser.open(BASE + '/api/v1/stats', timeout=8) as response:
        assert response.status == 200
    try:
        browser.open(urllib.request.Request(BASE + '/api/v1/session', method='DELETE'), timeout=8)
        raise AssertionError('Cookie mutation without Origin accepted')
    except urllib.error.HTTPError as exc:
        assert exc.code == 403
    with browser.open(urllib.request.Request(BASE + '/api/v1/session', headers={'Origin': BASE}, method='DELETE'), timeout=8) as response:
        assert response.status == 204
    destination = {'name': 'Smoke receiver', 'url': 'http://receiver:8099/webhook', 'signing_secret': SECRET, 'enabled': True}
    request('POST', '/api/v1/destinations', dict(destination, url='http://169.254.169.254/latest/meta-data'), expected=400)
    created = request('POST', '/api/v1/destinations', destination, expected=201)
    did = created['id']
    event = {'destination_id': did, 'type': 'smoke.created', 'payload': {'private': 'smoke-payload-never-returned'}}
    request('POST', '/api/v1/events', event, expected=400, token=INGEST)
    accepted = request('POST', '/api/v1/events', event, expected=202, token=INGEST, key='smoke-event-1')
    assert not accepted['duplicate']
    assert 'payload' not in accepted['event']
    eid, delivery_id = accepted['event']['id'], accepted['delivery']['id']
    duplicate = request('POST', '/api/v1/events', event, token=INGEST, key='smoke-event-1')
    assert duplicate['duplicate'] and duplicate['event']['id'] == eid
    request('POST', '/api/v1/events', dict(event, type='conflicting.type'), expected=409, token=INGEST, key='smoke-event-1')
    delivered = wait_delivery(delivery_id)
    assert delivered['delivery']['attempt_count'] == 2, delivered
    assert sorted(a['status_code'] for a in delivered['attempts']) == [204, 503]
    replay = request('POST', f'/api/v1/deliveries/{delivery_id}/replay', expected=202, key='smoke-replay-1')
    replay_again = request('POST', f'/api/v1/deliveries/{delivery_id}/replay', key='smoke-replay-1')
    assert replay_again['duplicate'] and replay_again['delivery']['id'] == replay['delivery']['id']
    assert replay['delivery']['replay_of'] == delivery_id
    wait_delivery(replay['delivery']['id'])
    assert len(request('GET', '/api/v1/events/' + eid)['deliveries']) == 2
    first = request('GET', '/api/v1/deliveries?limit=1')
    assert len(first['items']) == 1 and first['next_cursor']
    second = request('GET', '/api/v1/deliveries?limit=1&before=' + first['next_cursor'])
    assert len(second['items']) == 1 and first['items'][0]['id'] != second['items'][0]['id']
    request('DELETE', f'/api/v1/events/{eid}/payload', expected=204)
    assert request('GET', '/api/v1/events/' + eid)['event']['redacted']
    request('POST', f'/api/v1/deliveries/{delivery_id}/replay', expected=409, key='after-redaction')
    request('PUT', '/api/v1/destinations/' + did, dict(destination, enabled=False, signing_secret=''))
    paused = request('POST', '/api/v1/events', event, expected=202, token=INGEST, key='paused-event')
    time.sleep(0.5)
    pending_id = paused['delivery']['id']
    assert request('GET', '/api/v1/deliveries/' + pending_id)['delivery']['status'] == 'pending'
    request('DELETE', '/api/v1/events/' + paused['event']['id'] + '/payload', expected=409)
    request('POST', f'/api/v1/deliveries/{pending_id}/cancel', expected=204)
    request('DELETE', '/api/v1/destinations/' + did, expected=204)
    request('POST', '/api/v1/events', event, expected=409, token=INGEST, key='archived-event')
    assert request('POST', '/api/v1/events', event, token=INGEST, key='smoke-event-1')['duplicate']
    assert request('POST', f'/api/v1/deliveries/{delivery_id}/replay', key='smoke-replay-1')['duplicate']
    assert 'hooklane_deliveries' in request('GET', '/api/v1/metrics')
    print('Authenticated API, signed retry, idempotency, pagination, replay, redaction, pause, cancel and archive passed.')


if __name__ == '__main__':
    main()
