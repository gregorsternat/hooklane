import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('application readiness', () => {
  it('shows loading until the server responds', async () => {
    let respond!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      ),
    );
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking connection');
    expect(screen.getByRole('button')).toBeDisabled();
    respond(Response.json({ status: 'ok' }));
    expect(await screen.findByText('Connected')).toBeVisible();
  });

  it('recovers after a database outage when checked again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ status: 'unavailable' }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('Database unavailable')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText('Connected')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['network', 'html', 'invalid payload'])(
    'reports an unreachable service for %s failures',
    async (failure) => {
      const fetchMock = vi.fn();
      if (failure === 'network')
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      else if (failure === 'html')
        fetchMock.mockResolvedValue(
          new Response('<html>Proxy error</html>', { status: 502 }),
        );
      else fetchMock.mockResolvedValue(Response.json({ status: 'unknown' }));
      vi.stubGlobal('fetch', fetchMock);
      render(<App />);
      expect(await screen.findByText('Unable to connect')).toBeVisible();
      expect(screen.getByRole('button')).toBeEnabled();
    },
  );

  it('bounds an unresponsive request and allows another check', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText('Unable to connect')).toBeVisible();
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('cancels an in-flight check when unmounted', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        signal = options.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    const { unmount } = render(<App />);
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
