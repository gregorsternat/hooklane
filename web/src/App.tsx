import { useEffect, useState } from 'react';

type Status = 'checking' | 'ready' | 'unavailable' | 'unreachable';

const messages: Record<Status, { title: string; detail: string }> = {
  checking: {
    title: 'Checking connection',
    detail: 'Connecting to the application and database…',
  },
  ready: {
    title: 'Connected',
    detail: 'The application and PostgreSQL are ready.',
  },
  unavailable: {
    title: 'Database unavailable',
    detail: 'The application is reachable. PostgreSQL is not ready yet.',
  },
  unreachable: {
    title: 'Unable to connect',
    detail: 'The application did not return a valid readiness response.',
  },
};

async function checkReadiness(signal: AbortSignal): Promise<Status> {
  const response = await fetch('/readyz', { signal, cache: 'no-store' });
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || !('status' in data)) {
    throw new Error('Invalid readiness response');
  }
  if (response.status === 200 && data.status === 'ok') return 'ready';
  if (response.status === 503 && data.status === 'unavailable')
    return 'unavailable';
  throw new Error('Unexpected readiness response');
}

export function App() {
  const [status, setStatus] = useState<Status>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // Bound the browser request as well as the server-side database probe.
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    let active = true;
    void checkReadiness(controller.signal)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setStatus('unreachable');
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  return (
    <main className="shell">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true">
          ↗
        </span>{' '}
        Hooklane
      </header>
      <section className="intro" aria-labelledby="title">
        <p className="eyebrow">Self-hosted · Open source</p>
        <h1 id="title">
          A reliable home
          <br />
          for your webhooks.
        </h1>
        <p className="description">
          Webhook delivery and replay, under your control.
        </p>
      </section>
      <section className="connection" aria-labelledby="connection-title">
        <div role="status" aria-live="polite" className="connection-status">
          <span className={`status-dot ${status}`} aria-hidden="true" />
          <div>
            <h2 id="connection-title">{messages[status].title}</h2>
            <p>{messages[status].detail}</p>
          </div>
        </div>
        <button
          type="button"
          disabled={status === 'checking'}
          onClick={() => {
            setStatus('checking');
            setAttempt((current) => current + 1);
          }}
        >
          Check again <span aria-hidden="true">↻</span>
        </button>
      </section>
      <footer>
        Early development. Webhook delivery and replay are not available yet.
      </footer>
    </main>
  );
}
