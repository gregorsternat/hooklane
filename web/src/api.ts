export type DeliveryStatus =
  'pending' | 'delivering' | 'retrying' | 'succeeded' | 'dead' | 'canceled';
export interface Destination {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}
export interface WebhookEvent {
  id: string;
  destination_id: string;
  type: string;
  payload_bytes: number;
  payload_sha256: string;
  redacted: boolean;
  created_at: string;
}
export interface Delivery {
  id: string;
  event_id: string;
  destination_id: string;
  replay_of?: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_status_code: number;
  last_error: string;
  created_at: string;
  updated_at: string;
}
export interface Attempt {
  id: string;
  number: number;
  status: string;
  status_code: number;
  error_code: string;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
}
export interface Stats {
  destinations: number;
  events: number;
  pending: number;
  retrying: number;
  delivering: number;
  succeeded: number;
  dead: number;
  canceled: number;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface EventDetail {
  event: WebhookEvent;
  deliveries: Delivery[];
}
export interface DeliveryDetail {
  delivery: Delivery;
  attempts: Attempt[];
}
export type Decoder<T> = (value: unknown) => T;

function invalid(): never {
  throw new Error(
    'The server returned an unexpected response. Try refreshing.',
  );
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function str(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  return value;
}
function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function date(value: unknown): string {
  const result = str(value);
  if (!Number.isFinite(Date.parse(result))) return invalid();
  return result;
}
function nullableDate(value: unknown): string | null {
  return value === null ? null : date(value);
}
function array<T>(value: unknown, decoder: Decoder<T>): T[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(decoder);
}
export const statuses: DeliveryStatus[] = [
  'pending',
  'delivering',
  'retrying',
  'succeeded',
  'dead',
  'canceled',
];
export function terminal(status: DeliveryStatus): boolean {
  return status === 'succeeded' || status === 'dead' || status === 'canceled';
}
export function destination(value: unknown): Destination {
  const r = record(value);
  return {
    id: str(r.id),
    name: str(r.name),
    url: str(r.url),
    enabled: bool(r.enabled),
    archived: bool(r.archived),
    created_at: date(r.created_at),
    updated_at: date(r.updated_at),
  };
}
export function event(value: unknown): WebhookEvent {
  const r = record(value);
  return {
    id: str(r.id),
    destination_id: str(r.destination_id),
    type: str(r.type),
    payload_bytes: num(r.payload_bytes),
    payload_sha256: str(r.payload_sha256),
    redacted: bool(r.redacted),
    created_at: date(r.created_at),
  };
}
export function delivery(value: unknown): Delivery {
  const r = record(value);
  const status = str(r.status);
  if (!statuses.some((known) => known === status)) return invalid();
  return {
    id: str(r.id),
    event_id: str(r.event_id),
    destination_id: str(r.destination_id),
    ...(r.replay_of === undefined ? {} : { replay_of: str(r.replay_of) }),
    status: status as DeliveryStatus,
    attempt_count: num(r.attempt_count),
    next_attempt_at: nullableDate(r.next_attempt_at),
    last_status_code: num(r.last_status_code),
    last_error: str(r.last_error),
    created_at: date(r.created_at),
    updated_at: date(r.updated_at),
  };
}
export function attempt(value: unknown): Attempt {
  const r = record(value);
  return {
    id: str(r.id),
    number: num(r.number),
    status: str(r.status),
    status_code: num(r.status_code),
    error_code: str(r.error_code),
    duration_ms: num(r.duration_ms),
    started_at: date(r.started_at),
    finished_at: nullableDate(r.finished_at),
  };
}
export function page<T>(decoder: Decoder<T>): Decoder<Page<T>> {
  return (value) => {
    const r = record(value);
    return {
      items: array(r.items, decoder),
      next_cursor: r.next_cursor === null ? null : str(r.next_cursor),
    };
  };
}
export function stats(value: unknown): Stats {
  const r = record(value);
  return {
    destinations: num(r.destinations),
    events: num(r.events),
    pending: num(r.pending),
    retrying: num(r.retrying),
    delivering: num(r.delivering),
    succeeded: num(r.succeeded),
    dead: num(r.dead),
    canceled: num(r.canceled),
  };
}
export function eventDetail(value: unknown): EventDetail {
  const r = record(value);
  return { event: event(r.event), deliveries: array(r.deliveries, delivery) };
}
export function deliveryDetail(value: unknown): DeliveryDetail {
  const r = record(value);
  return {
    delivery: delivery(r.delivery),
    attempts: array(r.attempts, attempt),
  };
}
export function session(value: unknown): boolean {
  if (record(value).authenticated !== true) return invalid();
  return true;
}
export function replayResult(value: unknown): {
  delivery: Delivery;
  duplicate: boolean;
} {
  const r = record(value);
  return { delivery: delivery(r.delivery), duplicate: bool(r.duplicate) };
}
export function ingestResult(value: unknown): {
  event: WebhookEvent;
  delivery: Delivery;
  duplicate: boolean;
} {
  const r = record(value);
  return {
    event: event(r.event),
    delivery: delivery(r.delivery),
    duplicate: bool(r.duplicate),
  };
}
export function noContent(): undefined {
  return undefined;
}
export class APIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
// Keep server diagnostics and proxy error bodies out of the interface.
function errorMessage(status: number, code: string): string {
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403)
    return 'This action is not allowed. Check the server configuration.';
  if (status === 404) return 'This record could not be found.';
  if (status === 409)
    return 'This record changed or the action is no longer available. Refresh and try again.';
  if (status === 413)
    return 'This event exceeds the server payload limit. Use a smaller payload.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (code === 'invalid_destination' || code === 'invalid_url')
    return 'The destination is not allowed. Check its URL and server network policy.';
  if (status === 400 || status === 422)
    return 'Check your input. The server could not accept this request.';
  return 'The service is temporarily unavailable. Try again in a moment.';
}
export async function request<T>(
  path: string,
  decoder: Decoder<T>,
  options: RequestInit = {},
): Promise<T> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), 15000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  try {
    const response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (!response.ok) {
      let code = '';
      try {
        const body: unknown = await response.json();
        const error = record(record(body).error);
        if (typeof error.code === 'string') code = error.code;
      } catch {
        /* A proxy may return a non-JSON error. */
      }
      if (response.status === 401 && path !== '/session')
        window.dispatchEvent(new window.Event('hooklane:unauthorized'));
      throw new APIError(response.status, errorMessage(response.status, code));
    }
    if (response.status === 204) return decoder(undefined);
    const data: unknown = await response.json();
    return decoder(data);
  } catch (error) {
    if (timeout.signal.aborted)
      throw new Error(
        'The request timed out. Check your connection and try again.',
        { cause: error },
      );
    if (error instanceof SyntaxError)
      throw new Error(
        'The server returned an unexpected response. Try refreshing.',
        { cause: error },
      );
    if (error instanceof TypeError)
      throw new Error(
        'Unable to reach Hooklane. Check your connection and try again.',
        { cause: error },
      );
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}
export function queryString(values: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value) params.set(key, value);
  return params.size ? `?${params.toString()}` : '';
}
export function safeURL(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'Invalid endpoint';
  }
}
