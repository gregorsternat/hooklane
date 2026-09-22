import { useCallback, useEffect, useRef, useState } from 'react';
import { request, page, destination } from './api';
import type { Decoder, Destination } from './api';

export function useQuery<T>(
  path: string,
  decoder: Decoder<T>,
  interval = 15000,
) {
  const [state, setState] = useState<{
    path: string;
    data?: T;
    error?: string;
    loading: boolean;
  }>({ path, loading: true });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const decoderRef = useRef(decoder);
  useEffect(() => {
    decoderRef.current = decoder;
  }, [decoder]);
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    async function load() {
      if (controller) return;
      controller = new AbortController();
      try {
        const data = await request(path, decoderRef.current, {
          signal: controller.signal,
        });
        if (active) setState({ path, data, loading: false });
      } catch (error) {
        if (active)
          setState((prior) => ({
            ...prior,
            path,
            data: prior.path === path ? prior.data : undefined,
            error:
              error instanceof Error
                ? error.message
                : 'Unable to load this view.',
            loading: false,
          }));
      } finally {
        controller = undefined;
      }
    }
    void load();
    const timer =
      interval > 0
        ? window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
          }, interval)
        : undefined;
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [path, revision, interval]);
  return {
    ...(state.path === path
      ? state
      : { data: undefined, error: undefined, loading: true }),
    refresh,
  };
}
export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  async function run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError('');
    try {
      return await operation(current.signal);
    } catch (problem) {
      if (!current.signal.aborted)
        setError(
          problem instanceof Error
            ? problem.message
            : 'This action could not be completed.',
        );
      return undefined;
    } finally {
      if (!current.signal.aborted) setPending(false);
      controller.current = undefined;
    }
  }
  return { pending, error, run };
}
export function useRoute(): string {
  const read = () => window.location.hash.slice(1) || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const change = () => setRoute(read());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return route;
}
export function navigate(path: string) {
  window.location.hash = path;
}

export function useStableKey() {
  const key = useRef<string | undefined>(undefined);
  return () => {
    key.current ??= crypto.randomUUID();
    return key.current;
  };
}

export function useDestinationIndex() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const items: Destination[] = [];
      const visited = new Set<string>();
      let before = '';
      do {
        if (visited.has(before))
          throw new Error('The destination list could not be loaded.');
        visited.add(before);
        const result = await request(
          `/destinations?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`,
          page(destination),
          { signal: controller.signal },
        );
        items.push(...result.items);
        before = result.next_cursor ?? '';
      } while (before && !controller.signal.aborted);
      if (!controller.signal.aborted) setDestinations(items);
    }
    void load().catch((problem: unknown) => {
      if (!controller.signal.aborted)
        setError(
          problem instanceof Error
            ? problem.message
            : 'Unable to load destinations.',
        );
    });
    return () => controller.abort();
  }, []);
  return { destinations, error };
}

// Cursor history belongs in the URL so copied links and Back restore the same page.
export function useListRoute(path: string) {
  const route = useRoute();
  const params = new URLSearchParams(route.split('?')[1]);
  const history = ['', ...params.getAll('page')];
  function update(values: Record<string, string>, pages = ['']) {
    const next = new URLSearchParams(params);
    next.delete('page');
    next.delete('compose');
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    for (const cursor of pages.slice(1)) next.append('page', cursor);
    navigate(`${path}${next.size ? `?${next.toString()}` : ''}`);
  }
  return {
    params,
    history,
    update,
    setHistory: (pages: string[]) => update({}, pages),
  };
}
export function returnRoute(fallback: string): string {
  const value = new URLSearchParams(window.location.hash.split('?')[1]).get(
    'return_to',
  );
  return value && /^\/(events|deliveries)(\?|$)/.test(value) ? value : fallback;
}
export function detailLink(
  path: string,
  returnTo = returnRoute(window.location.hash.slice(1)),
) {
  return `#${path}?${new URLSearchParams({ return_to: returnTo })}`;
}
