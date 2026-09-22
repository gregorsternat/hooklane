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
    if (url.startsWith('/api/v1/destinations')) return list([destination]);
    if (url === '/api/v1/deliveries/delivery-1')
      return Response.json({ delivery, attempts: [] });
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
      url === '/api/v1/destinations' && options.method === 'POST'
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
  });
  it('requires explicit confirmation before archiving a destination', async () => {
    window.location.hash = '#/destinations';
    const fetchMock = mockAPI((url, options) =>
      url === '/api/v1/destinations/destination-1' &&
      options.method === 'DELETE'
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
        options.method === 'POST'
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
      expect(window.location.hash).toBe('#/deliveries/delivery-2'),
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
          ? Response.json({ event, deliveries: [delivery] })
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
          event: { ...event, redacted },
          deliveries: [{ ...delivery, status: 'succeeded' }],
        });
      if (
        url === '/api/v1/events/event-1/payload' &&
        options.method === 'DELETE'
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
      if (url === '/api/v1/events' && options.method === 'POST') {
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
