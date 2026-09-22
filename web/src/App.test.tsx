import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { EventComposer } from './forms';

const date = '2026-09-23T10:00:00Z';
const destination = {
  id: 'destination-1',
  name: 'Billing service',
  url: 'https://example.com/hook',
  enabled: true,
  archived: false,
  revision: 1,
  created_at: date,
  updated_at: date,
};
const event = {
  id: 'event-1',
  destination_id: destination.id,
  type: 'invoice.paid',
  payload_bytes: 20,
  payload_sha256: 'abcd1234',
  redacted: false,
  created_at: date,
};
const delivery = {
  id: 'delivery-1',
  event_id: event.id,
  destination_id: destination.id,
  status: 'pending',
  attempt_count: 0,
  next_attempt_at: date,
  last_status_code: 0,
  last_error: '',
  created_at: date,
  updated_at: date,
};
const stats = {
  destinations: 1,
  events: 1,
  pending: 1,
  retrying: 0,
  delivering: 0,
  succeeded: 0,
  dead: 0,
  canceled: 0,
  paused: 0,
  eligible: 1,
  scheduled: 0,
  oldest_eligible_queued_age_seconds: 0,
};
const detailContext = {
  destination,
  max_attempts: 8,
  scheduling_state: 'eligible',
  replay: { eligible: false, reason: 'delivery_not_terminal' },
  recovered_by: null,
};
const list = (items: unknown[]) => Response.json({ items, next_cursor: null });
function mockAPI(
  override?: (
    url: string,
    options: RequestInit,
  ) => Response | undefined | Promise<Response>,
) {
  return vi.fn(async (url: string, options: RequestInit = {}) => {
    const overridden = override?.(url, options);
    if (overridden) return overridden;
    if (url === '/api/v1/session')
      return Response.json({ authenticated: true });
    if (url === '/api/v1/stats') return Response.json(stats);
    if (url === '/api/v1/destinations/destination-1')
      return Response.json(destination);
    if (url.startsWith('/api/v1/destinations')) return list([destination]);
    if (url === '/api/v1/deliveries/delivery-1')
      return Response.json({ ...detailContext, delivery, attempts: [] });
    if (url.startsWith('/api/v1/deliveries')) return list([delivery]);
    if (url.startsWith('/api/v1/events')) return list([event]);
    throw new Error(`Unexpected test route: ${url}`);
  });
}
beforeEach(() => {
  window.location.hash = '#/';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('workspace authentication', () => {
  it('signs in with a cookie session and clears the admin token', async () => {
    const fetchMock = mockAPI((url, options) => {
      if (url === '/api/v1/session' && options.method !== 'POST')
        return Response.json(
          { error: { code: 'unauthorized' } },
          { status: 401 },
        );
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const input = await screen.findByLabelText('Admin token');
    fireEvent.change(input, { target: { value: 'admin-token-keep-private' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(
      await screen.findByRole('heading', { name: 'Overview' }),
    ).toBeVisible();
    expect(
      screen.queryByDisplayValue('admin-token-keep-private'),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'admin-token-keep-private' }),
      }),
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('returns to sign-in after an expired session', async () => {
    vi.stubGlobal('fetch', mockAPI());
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Overview' }),
    ).toBeVisible();
    act(() => window.dispatchEvent(new Event('hooklane:unauthorized')));
    expect(await screen.findByLabelText('Admin token')).toBeVisible();
  });
  it('recovers after a connection failure', async () => {
    let failed = true;
    vi.stubGlobal(
      'fetch',
      mockAPI((url) => {
        if (url === '/api/v1/session' && failed) {
          failed = false;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return undefined;
      }),
    );
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach Hooklane',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Overview' }),
    ).toBeVisible();
  });
  it('cancels the initial session request when unmounted', async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        signal = options.signal;
        return new Promise<Response>(() => {});
      }),
    );
    const { unmount } = render(<App />);
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
describe('operational flows', () => {
  it('submits and clears the event type filter through the beUI controls', async () => {
    window.location.hash = '#/events';
    const fetchMock = mockAPI();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Event type'), {
      target: { value: 'invoice.paid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url.startsWith('/api/v1/events?') &&
            url.includes('type=invoice.paid'),
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Event type')).toHaveValue(''),
    );
    expect(
      screen.queryByRole('button', { name: 'Clear filters' }),
    ).not.toBeInTheDocument();
  });

  it('creates a destination without showing its signing secret afterward', async () => {
    window.location.hash = '#/destinations';
    const fetchMock = mockAPI((url, options) =>
      url === '/api/v1/destinations' && options?.method === 'POST'
        ? Response.json(destination, { status: 201 })
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add destination' }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Billing service' },
    });
    fireEvent.change(within(dialog).getByLabelText('Endpoint URL'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.change(within(dialog).getByLabelText('Signing secret'), {
      target: { value: 'a-strong-signing-secret-with-32-characters' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create destination' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByText('Destination “Billing service” saved.'),
      ).toBeVisible(),
    );
    expect(
      screen.queryByDisplayValue('a-strong-signing-secret-with-32-characters'),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/destinations',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe(
        '#/destinations?destination_id=destination-1',
      ),
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Send a test event to Billing service',
      }),
    ).toBeVisible();
  });
  it('requires explicit confirmation before archiving a destination', async () => {
    window.location.hash = '#/destinations';
    const fetchMock = mockAPI((url, options) =>
      url === '/api/v1/destinations/destination-1' &&
      options?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Archive Billing service' }),
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === 'DELETE'),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Archive destination' }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, options]) => options?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByText('Destination archived.')).toBeVisible(),
    );
  });
  it('replays a terminal delivery only after confirmation and preserves the source history', async () => {
    window.location.hash = '#/deliveries/delivery-1';
    const fetchMock = mockAPI((url, options) => {
      if (url === '/api/v1/deliveries/delivery-1')
        return Response.json({
          ...detailContext,
          scheduling_state: 'terminal',
          replay: { eligible: true, reason: null },
          delivery: {
            ...delivery,
            status: 'dead',
            attempt_count: 1,
            last_status_code: 400,
          },
          attempts: [
            {
              id: 'attempt-1',
              number: 1,
              destination_revision: 1,
              status: 'dead',
              status_code: 400,
              error_code: 'http_status',
              duration_ms: 42,
              started_at: date,
              finished_at: date,
            },
          ],
        });
      if (
        url === '/api/v1/deliveries/delivery-1/replay' &&
        options?.method === 'POST'
      )
        return Response.json(
          {
            delivery: {
              ...delivery,
              id: 'delivery-2',
              replay_of: 'delivery-1',
            },
            duplicate: false,
          },
          { status: 202 },
        );
      if (url === '/api/v1/deliveries/delivery-2')
        return Response.json({
          ...detailContext,
          delivery: { ...delivery, id: 'delivery-2', replay_of: 'delivery-1' },
          attempts: [],
        });
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Replay delivery' }),
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === 'POST'),
    ).toBe(false);
    expect(screen.getByRole('heading', { name: 'Attempt 1' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Queue replay' }));
    await waitFor(() =>
      expect(window.location.hash).toBe(
        '#/deliveries/delivery-2?return_to=%2Fdeliveries',
      ),
    );
    const replay = fetchMock.mock.calls.find(([url]) =>
      url.endsWith('/replay'),
    );
    expect(replay?.[1]?.headers).toEqual(
      expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === 'DELETE'),
    ).toBe(false);
  });
  it('keeps redaction unavailable while an event has active deliveries', async () => {
    window.location.hash = '#/events/event-1';
    vi.stubGlobal(
      'fetch',
      mockAPI((url) =>
        url === '/api/v1/events/event-1'
          ? Response.json({ event, deliveries: [delivery], recovered_by: null })
          : undefined,
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole('button', { name: 'Redact payload' }),
    ).toBeDisabled();
    expect(screen.getByText('abcd1234')).toBeVisible();
  });
  it('redacts terminal event payloads with a confirmation and keeps metadata visible', async () => {
    window.location.hash = '#/events/event-1';
    let redacted = false;
    const fetchMock = mockAPI((url, options) => {
      if (url === '/api/v1/events/event-1')
        return Response.json({
          recovered_by: null,
          event: { ...event, redacted },
          deliveries: [{ ...delivery, status: 'succeeded' }],
        });
      if (
        url === '/api/v1/events/event-1/payload' &&
        options?.method === 'DELETE'
      ) {
        redacted = true;
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Redact payload' }),
    );
    expect(redacted).toBe(false);
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Redact payload',
      }),
    );
    expect(
      await screen.findByRole('button', { name: 'Payload redacted' }),
    ).toBeDisabled();
    expect(screen.getByText('abcd1234')).toBeVisible();
  });
  it('validates JSON locally and preserves idempotency on an uncertain retry', async () => {
    let calls = 0;
    const fetchMock = mockAPI((url, options) => {
      if (url === '/api/v1/events' && options?.method === 'POST') {
        calls++;
        if (calls === 1)
          return Promise.reject(new TypeError('Failed to fetch'));
        return Response.json(
          { event, delivery, duplicate: true },
          { status: 200 },
        );
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const notify = vi.fn();
    const close = vi.fn();
    render(<EventComposer notify={notify} onClose={close} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Destination' }));
    fireEvent.click(
      await screen.findByRole('option', { name: /Billing service/ }),
    );
    fireEvent.change(screen.getByLabelText('Event type'), {
      target: { value: 'invoice.paid' },
    });
    fireEvent.change(screen.getByLabelText('JSON payload'), {
      target: { value: '{broken}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('valid JSON');
    expect(calls).toBe(0);
    fireEvent.change(screen.getByLabelText('JSON payload'), {
      target: { value: '{"invoice_id":"private-123"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach Hooklane',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry same event' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    const posts = fetchMock.mock.calls.filter(
      ([, options]) => options?.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]?.[1]?.headers).toEqual(posts[1]?.[1]?.headers);
    expect(posts[0]?.[1]?.body).toEqual(posts[1]?.[1]?.body);
    expect(
      screen.queryByDisplayValue('{"invoice_id":"private-123"}'),
    ).not.toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith('Event already accepted.');
  });
});

describe('audit regression flows', () => {
  it('pauses from an old destination row using only the enabled flag', async () => {
    window.location.hash = '#/destinations';
    let current = destination;
    const fetchMock = mockAPI((url) => {
      if (url === '/api/v1/destinations/destination-1/enabled') {
        current = {
          ...destination,
          url: 'https://example.com/new-endpoint',
          enabled: false,
          revision: 3,
        };
        return Response.json(current);
      }
      if (url.startsWith('/api/v1/destinations?')) return list([current]);
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Pause Billing service' }),
    );
    expect(
      await screen.findByText('https://example.com/new-endpoint'),
    ).toBeVisible();
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/enabled'));
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it('preserves a stale edit and requires review of the latest revision before another save', async () => {
    window.location.hash = '#/destinations';
    const latest = {
      ...destination,
      url: 'https://example.com/new-endpoint',
      revision: 2,
    };
    let saves = 0;
    const fetchMock = mockAPI((url, options) => {
      if (url === '/api/v1/destinations/destination-1') {
        if (options?.method === 'PUT') {
          saves++;
          return saves === 1
            ? Response.json(
                { error: { code: 'destination_conflict' } },
                { status: 412 },
              )
            : Response.json({ ...latest, name: 'My draft', revision: 3 });
        }
        return Response.json(latest);
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit Billing service' }),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'My draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your draft is preserved',
    );
    expect(screen.getByLabelText('Name')).toHaveValue('My draft');
    expect(screen.getByLabelText('Endpoint URL')).toHaveValue(destination.url);
    expect(screen.getByText(/Latest configuration · revision 2/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Use latest revision and keep my draft',
      }),
    );
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: latest.url },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    const puts = fetchMock.mock.calls.filter(
      ([, options]) => options?.method === 'PUT',
    );
    expect(puts[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ 'If-Match': '"1"' }),
    );
    expect(puts[1]?.[1]?.headers).toEqual(
      expect.objectContaining({ 'If-Match': '"2"' }),
    );
    expect(puts[1]?.[1]?.body).toContain('new-endpoint');
  });

  it('offers destination-specific setup and a retryable curl without exposing credentials', async () => {
    window.location.hash = '#/guide?destination_id=destination-1';
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
    vi.stubGlobal('fetch', mockAPI());
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy setup' }));
    const setup = copy.mock.calls[0]?.[0] as string;
    expect(setup).toContain(`HOOKLANE_URL='${window.location.origin}'`);
    expect(setup).toContain("HOOKLANE_INGEST_TOKEN='<INGEST_TOKEN>'");
    expect(setup).toMatch(/IDEMPOTENCY_KEY='[0-9a-f-]+'/);
    const requestButton = screen.getByRole('button', { name: 'Copy request' });
    fireEvent.click(requestButton);
    const request = copy.mock.calls[1]?.[0] as string;
    expect(request).toContain('"destination_id": "destination-1"');
    expect(request).toContain('Idempotency-Key: $IDEMPOTENCY_KEY');
    expect(request).not.toContain('uuidgen');
    expect(request).toContain(' \\\n  --header');
    fireEvent.click(requestButton);
    expect(copy.mock.calls[2]?.[0]).toBe(request);
    expect(
      screen.getByRole('link', { name: 'signing protocol' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/gregorsternat/hooklane/blob/main/docs/api.md#receiving-and-verifying',
    );
    expect(
      screen.getByRole('link', {
        name: 'signature-verifying receiver example',
      }),
    ).toHaveAttribute(
      'href',
      'https://github.com/gregorsternat/hooklane/blob/main/examples/receiver/README.md',
    );
  });

  it.each([
    ['payload_redacted', 'permanently redacted'],
    ['destination_archived', 'destination is archived'],
  ])(
    'explains the permanent %s replay blocker before a request',
    async (reason, message) => {
      window.location.hash = '#/deliveries/delivery-1';
      const fetchMock = mockAPI((url) =>
        url === '/api/v1/deliveries/delivery-1'
          ? Response.json({
              ...detailContext,
              delivery: { ...delivery, status: 'dead' },
              attempts: [],
              replay: { eligible: false, reason },
              scheduling_state: 'terminal',
            })
          : undefined,
      );
      vi.stubGlobal('fetch', fetchMock);
      render(<App />);
      expect(
        await screen.findByRole('button', { name: 'Replay delivery' }),
      ).toBeDisabled();
      expect(screen.getByText(new RegExp(message))).toBeVisible();
      expect(
        fetchMock.mock.calls.some(([, options]) => options?.method === 'POST'),
      ).toBe(false);
    },
  );

  it('explains a replay redaction race without suggesting that refresh restores the payload', async () => {
    window.location.hash = '#/deliveries/delivery-1';
    vi.stubGlobal(
      'fetch',
      mockAPI((url) => {
        if (url === '/api/v1/deliveries/delivery-1')
          return Response.json({
            ...detailContext,
            delivery: { ...delivery, status: 'dead' },
            attempts: [],
            replay: { eligible: true, reason: null },
            scheduling_state: 'terminal',
          });
        if (url.endsWith('/replay'))
          return Response.json(
            {
              error: {
                code: 'payload_redacted',
                message: 'private server diagnostics',
              },
            },
            { status: 409 },
          );
        return undefined;
      }),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Replay delivery' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Queue replay' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'permanently redacted',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Refresh');
    expect(
      screen.queryByText('private server diagnostics'),
    ).not.toBeInTheDocument();
  });

  it('distinguishes recovered history and preserves the attempt configuration revision', async () => {
    window.location.hash = '#/deliveries/delivery-1';
    vi.stubGlobal(
      'fetch',
      mockAPI((url) =>
        url === '/api/v1/deliveries/delivery-1'
          ? Response.json({
              ...detailContext,
              destination: { ...destination, revision: 3 },
              recovered_by: 'recovery-1',
              delivery: {
                ...delivery,
                status: 'dead',
                attempt_count: 1,
                last_error: 'attempts_exhausted',
              },
              scheduling_state: 'terminal',
              attempts: [
                {
                  id: 'attempt-1',
                  number: 1,
                  destination_revision: 1,
                  status: 'dead',
                  status_code: 0,
                  error_code: 'tls_error',
                  duration_ms: 13,
                  started_at: date,
                  finished_at: date,
                },
              ],
            })
          : undefined,
      ),
    );
    render(<App />);
    expect(await screen.findByText(/Recovered by replay/)).toBeVisible();
    expect(screen.getByText('Failed')).toBeVisible();
    expect(
      screen.getByRole('link', { name: /View successful replay/ }),
    ).toHaveAttribute(
      'href',
      expect.stringContaining('/deliveries/recovery-1'),
    );
    expect(screen.getByText('1 of 8')).toBeVisible();
    expect(screen.getByText('Destination revision: 1')).toBeVisible();
    expect(screen.getByText(/TLS verification/)).toBeVisible();
    expect(screen.getByText(/exhausted its attempt budget/)).toBeVisible();
  });

  it('explains exhaustion when the last attempt retains its actual HTTP failure', async () => {
    window.location.hash = '#/deliveries/delivery-1';
    vi.stubGlobal(
      'fetch',
      mockAPI((url) =>
        url === '/api/v1/deliveries/delivery-1'
          ? Response.json({
              ...detailContext,
              delivery: {
                ...delivery,
                status: 'dead',
                attempt_count: 8,
                last_error: 'http_error',
                last_status_code: 503,
              },
              attempts: [],
              scheduling_state: 'terminal',
            })
          : undefined,
      ),
    );
    render(<App />);
    expect(
      await screen.findByText(/used its current attempt budget/),
    ).toBeVisible();
    expect(screen.getByText('8 of 8')).toBeVisible();
    expect(screen.getByText('HTTP 503')).toBeVisible();
    expect(
      screen.getByText('The endpoint returned an unsuccessful HTTP response.'),
    ).toBeVisible();
  });

  it('identifies paused work and links directly to the destination settings', async () => {
    window.location.hash = '#/deliveries/delivery-1';
    vi.stubGlobal(
      'fetch',
      mockAPI((url) =>
        url === '/api/v1/deliveries/delivery-1'
          ? Response.json({
              ...detailContext,
              destination: { ...destination, enabled: false },
              delivery,
              attempts: [],
              scheduling_state: 'waiting_for_resume',
            })
          : undefined,
      ),
    );
    render(<App />);
    expect(
      (await screen.findAllByText(/Waiting for destination resume/))[0],
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Billing service · Paused' }),
    ).toHaveAttribute('href', '#/destinations?destination_id=destination-1');
    expect(screen.getByText('0 of 8')).toBeVisible();
  });

  it('restores shared delivery filters and pagination through a detail return link', async () => {
    const route =
      '/deliveries?status=dead&destination_id=destination-1&event_id=event-1&page=cursor-1';
    window.location.hash = `#${route}`;
    const fetchMock = mockAPI();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const inspect = await screen.findByRole('link', {
      name: 'Inspect delivery delivery-1',
    });
    expect(inspect).toHaveAttribute(
      'href',
      `#/deliveries/delivery-1?return_to=${encodeURIComponent(route)}`,
    );
    expect(screen.getByText('Page 2')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent(
      'Failed',
    );
    fireEvent.click(inspect);
    const back = await screen.findByRole('link', { name: '← Back to results' });
    expect(back).toHaveAttribute('href', `#${route}`);
    fireEvent.click(back);
    expect(await screen.findByText('Page 2')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent(
      'Failed',
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url]) =>
          url.includes('before=cursor-1') &&
          url.includes('status=dead') &&
          url.includes('destination_id=destination-1') &&
          url.includes('event_id=event-1'),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('puts changed delivery filters in the route and resets pagination', async () => {
    window.location.hash = '#/deliveries?page=cursor-1';
    vi.stubGlobal('fetch', mockAPI());
    render(<App />);
    fireEvent.click(await screen.findByRole('combobox', { name: 'Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/deliveries?status=dead'),
    );
    expect(
      await screen.findByRole('combobox', { name: 'Status' }),
    ).toHaveTextContent('Failed');
  });

  it('opens an event by its full ID without developer tools', async () => {
    window.location.hash = '#/deliveries?status=dead';
    vi.stubGlobal(
      'fetch',
      mockAPI((url) =>
        url === '/api/v1/events/event-1'
          ? Response.json({ event, deliveries: [delivery], recovered_by: null })
          : undefined,
      ),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('combobox', { name: 'Record' }));
    fireEvent.click(screen.getByRole('option', { name: 'Event ID' }));
    fireEvent.change(screen.getByLabelText('Full record ID'), {
      target: { value: 'event-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }));
    expect(
      await screen.findByRole('heading', { name: 'invoice.paid' }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: '← Back to results' }),
    ).toHaveAttribute('href', '#/deliveries?status=dead');
  });
});

async function fillComposer() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Destination' }));
  fireEvent.click(
    await screen.findByRole('option', { name: /Billing service/ }),
  );
  fireEvent.change(screen.getByLabelText('Event type'), {
    target: { value: 'invoice.paid' },
  });
  fireEvent.change(screen.getByLabelText('JSON payload'), {
    target: { value: '{"invoice_id":"draft"}' },
  });
}
describe('composer rejection recovery', () => {
  it('allows correction after a definitive first validation rejection without losing the draft', async () => {
    let posts = 0;
    const fetchMock = mockAPI((url, options) => {
      if (url === '/api/v1/events' && options?.method === 'POST') {
        posts++;
        return posts === 1
          ? Response.json({ error: { code: 'invalid_event' } }, { status: 400 })
          : Response.json(
              { event, delivery, duplicate: false },
              { status: 202 },
            );
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const close = vi.fn();
    render(<EventComposer notify={vi.fn()} onClose={close} />);
    await fillComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Send event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check your input',
    );
    expect(screen.getByLabelText('Event type')).toBeEnabled();
    expect(screen.getByLabelText('JSON payload')).toHaveValue(
      '{"invoice_id":"draft"}',
    );
    fireEvent.change(screen.getByLabelText('Event type'), {
      target: { value: 'invoice.updated' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send event' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    const calls = fetchMock.mock.calls.filter(
      ([, options]) => options?.method === 'POST',
    );
    expect(calls[1]?.[1]?.body).toContain('invoice.updated');
  });

  it('keeps content and identity frozen after ambiguity even when a later retry is rejected', async () => {
    let posts = 0;
    const fetchMock = mockAPI((url, options) => {
      if (url === '/api/v1/events' && options?.method === 'POST') {
        posts++;
        if (posts === 1) return Promise.reject(new TypeError('Lost response'));
        if (posts === 2)
          return Response.json(
            { error: { code: 'payload_too_large' } },
            { status: 413 },
          );
        return Response.json({ event, delivery, duplicate: true });
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const close = vi.fn();
    render(<EventComposer notify={vi.fn()} onClose={close} />);
    await fillComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Send event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry same event' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('payload limit'),
    );
    expect(screen.getByLabelText('Event type')).toBeDisabled();
    expect(screen.getByLabelText('JSON payload')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same event' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    const calls = fetchMock.mock.calls.filter(
      ([, options]) => options?.method === 'POST',
    );
    expect(calls).toHaveLength(3);
    expect(calls[1]?.[1]?.body).toBe(calls[0]?.[1]?.body);
    expect(calls[2]?.[1]?.body).toBe(calls[0]?.[1]?.body);
    expect(calls[2]?.[1]?.headers).toEqual(calls[0]?.[1]?.headers);
  });
});
