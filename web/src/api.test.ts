import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APIError,
  delivery,
  deliveryDetail,
  destination,
  event,
  page,
  request,
  safeURL,
  session,
} from './api';

const sampleEvent = {
  id: 'event-1',
  destination_id: 'destination-1',
  type: 'invoice.paid',
  payload_bytes: 20,
  payload_sha256: 'abc123',
  redacted: false,
  created_at: '2026-09-23T10:00:00Z',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('response boundary', () => {
  it('keeps payloads and unrecognized secret fields out of parsed records', () => {
    expect(
      event({
        ...sampleEvent,
        payload: { secret: 'private' },
        signing_secret: 'private',
      }),
    ).toEqual(sampleEvent);
  });
  it('rejects malformed metadata and pagination rather than rendering unknown data', () => {
    expect(() => event({ ...sampleEvent, created_at: 'invalid' })).toThrow(
      'unexpected response',
    );
    expect(() => event({ ...sampleEvent, payload_bytes: '20' })).toThrow(
      'unexpected response',
    );
    expect(() => page(event)({ items: [sampleEvent], next_cursor: 7 })).toThrow(
      'unexpected response',
    );
    expect(() => session({ authenticated: false })).toThrow(
      'unexpected response',
    );
  });
  it('rejects unknown delivery states', () => {
    expect(() => delivery({ status: 'invented' })).toThrow(
      'unexpected response',
    );
  });
  it('removes credentials, fragments and query parameters from endpoint displays', () => {
    expect(
      safeURL('https://user:secret@example.com/webhook?token=private#secret'),
    ).toBe('https://example.com/webhook');
  });
});
describe('API transport', () => {
  it('uses same-origin sessions and not browser token storage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ authenticated: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await request('/session', session)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/session',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    );
    expect(localStorage.length).toBe(0);
  });
  it('invalidates authentication after a session expires without displaying server diagnostics', async () => {
    const listener = vi.fn();
    window.addEventListener('hooklane:unauthorized', listener);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 'unauthorized',
              message: 'private-token-internal',
            },
          },
          { status: 401 },
        ),
      ),
    );
    await expect(request('/stats', session)).rejects.toMatchObject({
      status: 401,
      message: 'Your session has expired. Sign in again.',
    });
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('hooklane:unauthorized', listener);
  });
  it('handles an HTML proxy failure without leaking its response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>secret backend address</html>', { status: 502 }),
        ),
    );
    await expect(request('/session', session)).rejects.toBeInstanceOf(APIError);
  });
  it('never displays a malformed successful response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret-response-body')),
    );
    await expect(request('/session', session)).rejects.toThrow(
      'unexpected response',
    );
  });
  it('bounds unresponsive requests', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            ),
          ),
      ),
    );
    const pending = expect(request('/session', session)).rejects.toThrow(
      'timed out',
    );
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
  });
  it('propagates unmount cancellation to the fetch signal', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        signal = options.signal;
        return new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        );
      }),
    );
    const pending = expect(
      request('/session', session, { signal: controller.signal }),
    ).rejects.toThrow('Aborted');
    controller.abort();
    await pending;
    expect(signal?.aborted).toBe(true);
  });
});

describe('investigation response boundary', () => {
  const sampleDestination = {
    id: 'destination-1',
    name: 'Receiver',
    url: 'https://example.com/hook',
    enabled: false,
    archived: false,
    revision: 2,
    created_at: sampleEvent.created_at,
    updated_at: sampleEvent.created_at,
  };
  const detail = {
    delivery: {
      id: 'delivery-1',
      event_id: sampleEvent.id,
      destination_id: sampleDestination.id,
      status: 'dead',
      attempt_count: 1,
      next_attempt_at: null,
      last_status_code: 0,
      last_error: 'tls_error',
      created_at: sampleEvent.created_at,
      updated_at: sampleEvent.created_at,
    },
    destination: sampleDestination,
    attempts: [
      {
        id: 'attempt-1',
        number: 1,
        destination_revision: null,
        status: 'dead',
        status_code: 0,
        error_code: 'tls_error',
        duration_ms: 20,
        started_at: sampleEvent.created_at,
        finished_at: sampleEvent.created_at,
      },
    ],
    max_attempts: 8,
    scheduling_state: 'terminal',
    replay: { eligible: true, reason: null },
    recovered_by: 'delivery-2',
  };
  it('rejects malformed concurrency and eligibility metadata', () => {
    expect(() => destination({ ...sampleDestination, revision: '2' })).toThrow(
      'unexpected response',
    );
    expect(() =>
      deliveryDetail({
        ...detail,
        replay: { eligible: 'false', reason: null },
      }),
    ).toThrow('unexpected response');
    expect(() =>
      deliveryDetail({
        ...detail,
        replay: { eligible: false, reason: 'private_raw_error' },
      }),
    ).toThrow('unexpected response');
    expect(() =>
      deliveryDetail({ ...detail, scheduling_state: 'invented' }),
    ).toThrow('unexpected response');
  });
  it('strips sensitive fields from expanded nested read data and preserves unknown historical revisions', () => {
    const parsed = deliveryDetail({
      ...detail,
      payload: 'private-event-body',
      destination: {
        ...sampleDestination,
        signing_secret: 'private-signing-secret',
      },
      attempts: [
        { ...detail.attempts[0], error_message: 'private-raw-transport-error' },
      ],
    });
    expect(parsed.attempts[0]?.destination_revision).toBeNull();
    expect(parsed.recovered_by).toBe('delivery-2');
    expect(JSON.stringify(parsed)).not.toContain('private-');
  });
});
