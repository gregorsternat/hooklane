import { lazy, Suspense, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Menu } from 'lucide-react';
import { APIError, noContent, request, session } from './api';
import {
  Brand,
  Button,
  ButtonLink,
  ErrorBox,
  Icon,
  Input,
  Loading,
} from './components';
import {
  AnimatedSidebarProvider,
  AnimatedSidebar,
  AnimatedSidebarHeader,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuItem,
  AnimatedSidebarMenuButton,
  AnimatedSidebarTrigger,
  AnimatedSidebarInset,
} from '@/components/motion/animated-sidebar';
import {
  AnimatedToastStack,
  useAnimatedToastStack,
} from '@/components/motion/animated-toast-stack';
import { useMutation, useRoute } from './hooks';
const Dashboard = lazy(() =>
  import('./pages').then((module) => ({ default: module.Dashboard })),
);
const Destinations = lazy(() =>
  import('./pages').then((module) => ({ default: module.Destinations })),
);
const Events = lazy(() =>
  import('./pages').then((module) => ({ default: module.Events })),
);
const EventView = lazy(() =>
  import('./pages').then((module) => ({ default: module.EventView })),
);
const Deliveries = lazy(() =>
  import('./pages').then((module) => ({ default: module.Deliveries })),
);
const DeliveryView = lazy(() =>
  import('./pages').then((module) => ({ default: module.DeliveryView })),
);
const Guide = lazy(() =>
  import('./pages').then((module) => ({ default: module.Guide })),
);

export function App() {
  const [auth, setAuth] = useState<
    'checking' | 'signed-in' | 'signed-out' | 'error'
  >('checking');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request('/session', session, { signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) setAuth('signed-in');
      })
      .catch((problem: unknown) => {
        if (controller.signal.aborted) return;
        if (problem instanceof APIError && problem.status === 401)
          setAuth('signed-out');
        else {
          setError(
            problem instanceof Error
              ? problem.message
              : 'Unable to reach Hooklane.',
          );
          setAuth('error');
        }
      });
    const unauthorized = () => setAuth('signed-out');
    window.addEventListener('hooklane:unauthorized', unauthorized);
    return () => {
      controller.abort();
      window.removeEventListener('hooklane:unauthorized', unauthorized);
    };
  }, [revision]);
  if (auth === 'checking')
    return (
      <div className="boot">
        <Brand dark />
        <Loading label="Connecting…" />
      </div>
    );
  if (auth !== 'signed-in')
    return (
      <Login
        onLogin={() => setAuth('signed-in')}
        connectionError={auth === 'error' ? error : ''}
        onRetry={() => {
          setAuth('checking');
          setRevision((n) => n + 1);
        }}
      />
    );
  return <Workspace onLogout={() => setAuth('signed-out')} />;
}
function Login({
  onLogin,
  connectionError,
  onRetry,
}: {
  onLogin: () => void;
  connectionError: string;
  onRetry: () => void;
}) {
  const [token, setToken] = useState('');
  const mutation = useMutation();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = await mutation.run((signal) =>
      request('/session', session, {
        method: 'POST',
        body: JSON.stringify({ token }),
        signal,
      }),
    );
    setToken('');
    if (result) onLogin();
  }
  return (
    <main className="login-layout">
      <section className="login-card">
        <Brand dark />
        <h1>Sign in</h1>
        <ErrorBox message={connectionError} retry={onRetry} />
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="admin-token">Admin token</label>
          <Input
            id="admin-token"
            type="password"
            value={token}
            onChange={setToken}
            required
            autoComplete="current-password"
            autoFocus
            disabled={mutation.pending}
          />
          <ErrorBox
            message={
              mutation.error
                ? 'Sign-in failed. Check your token and connection.'
                : ''
            }
          />
          <Button
            type="submit"
            className="button primary full-width"
            disabled={mutation.pending}
          >
            {mutation.pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </section>
    </main>
  );
}

function Workspace({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const pathname = route.split('?')[0] ?? '/';
  const section = pathname.split('/')[1] || 'overview';
  const id = pathname.split('/')[2];
  const logout = useMutation();
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({
    defaultDuration: 7000,
    limit: 3,
  });
  const notify = (title: string) => {
    showToast({ title, status: 'success' });
  };
  const links = [
    { path: '/', name: 'Overview', icon: 'overview' },
    { path: '/destinations', name: 'Destinations', icon: 'destinations' },
    { path: '/events', name: 'Events', icon: 'events' },
    { path: '/deliveries', name: 'Deliveries', icon: 'deliveries' },
  ] as const;
  async function signOut() {
    const completed = await logout.run(async (signal) => {
      await request('/session', noContent, { method: 'DELETE', signal });
      return true;
    });
    if (completed) onLogout();
  }
  let page;
  if (section === 'overview') page = <Dashboard />;
  else if (section === 'destinations') page = <Destinations notify={notify} />;
  else if (section === 'events' && id)
    page = <EventView id={id} notify={notify} />;
  else if (section === 'events') page = <Events notify={notify} />;
  else if (section === 'deliveries' && id)
    page = <DeliveryView id={id} notify={notify} />;
  else if (section === 'deliveries') page = <Deliveries />;
  else if (section === 'guide') page = <Guide />;
  else
    page = (
      <div className="not-found">
        <h1>Page not found</h1>
        <ButtonLink className="button" href="#/">
          Go to overview
        </ButtonLink>
      </div>
    );
  return (
    <AnimatedSidebarProvider
      className="app-layout"
      style={{ '--sidebar-width': '240px' }}
    >
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <AnimatedSidebar
        className="app-sidebar"
        collapsible="none"
        ariaLabel="Main navigation"
      >
        <AnimatedSidebarHeader>
          <Brand dark />
        </AnimatedSidebarHeader>
        <AnimatedSidebarContent>
          <nav aria-label="Main navigation">
            <AnimatedSidebarMenu>
              {links.map((link) => (
                <AnimatedSidebarMenuItem key={link.path}>
                  <AnimatedSidebarMenuButton
                    href={`#${link.path}`}
                    icon={<Icon name={link.icon} />}
                    isActive={section === (link.path.slice(1) || 'overview')}
                  >
                    {link.name}
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              ))}
            </AnimatedSidebarMenu>
          </nav>
        </AnimatedSidebarContent>
        <AnimatedSidebarFooter>
          <AnimatedSidebarMenu>
            <AnimatedSidebarMenuItem>
              <AnimatedSidebarMenuButton
                href="#/guide"
                icon={<Icon name="guide" />}
                isActive={section === 'guide'}
              >
                Integration guide
              </AnimatedSidebarMenuButton>
            </AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuItem>
              <AnimatedSidebarMenuButton
                icon={<Icon name="logout" />}
                disabled={logout.pending}
                onSelect={() => void signOut()}
              >
                {logout.pending ? 'Signing out…' : 'Sign out'}
              </AnimatedSidebarMenuButton>
            </AnimatedSidebarMenuItem>
          </AnimatedSidebarMenu>
        </AnimatedSidebarFooter>
      </AnimatedSidebar>
      <AnimatedSidebarInset className="main-shell">
        <div className="mobile-toolbar">
          <AnimatedSidebarTrigger aria-label="Open navigation">
            <Menu size={20} aria-hidden="true" />
          </AnimatedSidebarTrigger>
          <Brand dark />
        </div>
        <div id="main-content" tabIndex={-1}>
          <ErrorBox message={logout.error} />
          <Suspense fallback={<Loading />}>
            <div key={route}>{page}</div>
          </Suspense>
        </div>
      </AnimatedSidebarInset>
      <AnimatedToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        placement="fixed"
      />
    </AnimatedSidebarProvider>
  );
}
