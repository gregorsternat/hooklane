export function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  if (seconds < 0)
    return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
      Math.ceil(-seconds / 60),
      'minute',
    );
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function shortID(value: string): string {
  return value.length > 16 ? `${value.slice(0, 4)}…${value.slice(-8)}` : value;
}
