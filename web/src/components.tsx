import { relativeTime } from './format';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ComponentProps, ReactNode } from 'react';
import type { DeliveryStatus } from './api';
import {
  Button as BeButton,
  ButtonLink as BeButtonLink,
} from '@/components/motion/button/base';
import { Input as BeInput } from '@/components/motion/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/motion/select';
import { Switch } from '@/components/motion/switch';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import type { AnimatedBadgeStatus } from '@/components/motion/animated-badge';
import { Loader } from '@/components/motion/loader';
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from '@/components/motion/center-morph-modal';
export { Textarea } from '@/components/ui/textarea';

function buttonStyle(className = '') {
  const classes = new Set(className.split(/\s+/));
  return {
    variant:
      classes.has('primary') || classes.has('danger')
        ? ('primary' as const)
        : classes.has('icon-button')
          ? ('ghost' as const)
          : ('secondary' as const),
    size: classes.has('small')
      ? ('sm' as const)
      : classes.has('icon-button')
        ? ('icon' as const)
        : ('md' as const),
    className: `rounded-lg ${className}`,
  };
}
export function Button({
  className,
  ...props
}: ComponentProps<typeof BeButton>) {
  return <BeButton {...buttonStyle(className)} {...props} />;
}
export function ButtonLink({
  className,
  ...props
}: ComponentProps<typeof BeButtonLink>) {
  return <BeButtonLink {...buttonStyle(className)} {...props} />;
}
export function Input(props: ComponentProps<typeof BeInput>) {
  return (
    <BeInput
      classNames={{ root: 'field', field: 'input-field', input: 'text-input' }}
      {...props}
    />
  );
}
export function SelectField({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  required,
  className = '',
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  'aria-label'?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Select
      id={id}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      className={`select-field ${open ? 'select-open' : ''} ${className}`}
    >
      <SelectTrigger
        className="select-trigger"
        aria-label={ariaLabel}
        aria-required={required}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="select-options">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function SwitchField({
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  ...props
}: Omit<ComponentProps<typeof Switch>, 'ariaLabel' | 'ariaDescribedBy'> & {
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <Switch
      ariaLabel={ariaLabel}
      ariaDescribedBy={ariaDescribedBy}
      {...props}
    />
  );
}
export function Icon({
  name,
  size = 20,
}: {
  name:
    | 'overview'
    | 'destinations'
    | 'events'
    | 'deliveries'
    | 'guide'
    | 'arrow'
    | 'refresh'
    | 'plus'
    | 'logout'
    | 'check'
    | 'close';
  size?: number;
}) {
  const paths = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    destinations: (
      <>
        <path d="M5 5h14v14H5z" />
        <path d="M2 9h6m8 6h6M12 2v6m0 8v6" />
      </>
    ),
    events: (
      <>
        <path d="m13 2-9 12h7l-1 8 10-13h-8z" />
      </>
    ),
    deliveries: (
      <>
        <path d="M3 12h17m-6-6 6 6-6 6" />
        <path d="M3 5h5M3 19h5" />
      </>
    ),
    guide: (
      <>
        <path d="M4 3h12a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3zM4 17h15M8 7h7M8 11h5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    logout: (
      <>
        <path d="M9 4H4v16h5m-1-8h13m-5-5 5 5-5 5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Brand({ dark = false }: { dark?: boolean }) {
  return (
    <a
      href="#/"
      className={`brand ${dark ? 'brand-dark' : ''}`}
      aria-label="Hooklane home"
    >
      <span className="brand-mark">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 4v9a6 6 0 0 0 12 0V9M13 9h8"
            stroke="currentColor"
            strokeWidth="2.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="m17 5 4 4-4 4"
            stroke="currentColor"
            strokeWidth="2.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      hooklane
    </a>
  );
}
export function Badge({
  status,
}: {
  status: DeliveryStatus | 'active' | 'paused' | 'archived' | 'redacted';
}) {
  const names = {
    pending: 'Queued',
    delivering: 'Delivering',
    retrying: 'Retrying',
    succeeded: 'Delivered',
    dead: 'Failed',
    canceled: 'Canceled',
    active: 'Active',
    paused: 'Paused',
    archived: 'Archived',
    redacted: 'Redacted',
  };
  const tones: Record<typeof status, AnimatedBadgeStatus> = {
    pending: 'neutral',
    delivering: 'info',
    retrying: 'warning',
    succeeded: 'success',
    dead: 'danger',
    canceled: 'neutral',
    active: 'success',
    paused: 'warning',
    archived: 'neutral',
    redacted: 'neutral',
  };
  return (
    <AnimatedBadge status={tones[status]} size="sm" pulse={false}>
      {names[status]}
    </AnimatedBadge>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message?: string;
  retry?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      {retry && (
        <Button className="button small" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <Loader variant="spinner" size={18} label={label} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}
export function Panel({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {(title || description || action) && (
        <header className="panel-heading">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
export function Pager({
  next,
  history,
  change,
}: {
  next: string | null;
  history: string[];
  change: (history: string[]) => void;
}) {
  if (history.length === 1 && !next) return null;
  return (
    <div className="pagination">
      <span>Page {history.length}</span>
      <div>
        <Button
          className="button small"
          disabled={history.length <= 1}
          onClick={() => change(history.slice(0, -1))}
        >
          Previous
        </Button>
        <Button
          className="button small"
          disabled={!next}
          onClick={() => next && change([...history, next])}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const closeRef = useRef({ busy, onClose });
  useLayoutEffect(() => {
    closeRef.current = { busy, onClose };
  });
  const [opener] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    },
    [opener],
  );
  const changeOpen = useCallback((open: boolean) => {
    if (!open && !closeRef.current.busy) closeRef.current.onClose();
  }, []);
  return (
    <CenterMorphModal open onOpenChange={changeOpen}>
      <CenterMorphModalContent
        ariaLabel={title}
        dismissible={!busy}
        showCloseButton={false}
        className="modal"
        backdropClassName="modal-backdrop"
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <Button
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </header>
        {children}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
export function Confirm({
  title,
  description,
  label,
  busy,
  error,
  onConfirm,
  onClose,
  destructive = false,
}: {
  title: string;
  description: string;
  label: string;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
  destructive?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <div className="modal-body">
        <p className="muted">{description}</p>
        <ErrorBox message={error} />
      </div>
      <footer className="modal-footer">
        <Button className="button" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          className={`button ${destructive ? 'danger' : 'primary'}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : label}
        </Button>
      </footer>
    </Modal>
  );
}
export function Timestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {relativeTime(value)}
    </time>
  );
}
export function DateValue({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    <>—</>
  );
}
