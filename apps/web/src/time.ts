// Time helpers shared by the Projects pages. Copied from conversations.tsx (not moved, so conversation pages stay
// untouched); `now` is a parameter so tests can fix the clock.

/** Compact age of a timestamp: `now`, `5m`, `3h`, a weekday within a week, else a day and month. */
export const shortTime = (at: string, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10_080) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** A length of time in seconds: `45s`, `3m 20s`, `2h 5m 0s`. */
export const duration = (seconds: number): string =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;

/** Elapsed time from `from` to `to` in its two largest units, for list rows: `45s`, `12m`, `2h 5m`, `3d 4h`. */
export function relativeDuration(from: string, to: string | number = Date.now()): string {
  const end = typeof to === 'number' ? to : Date.parse(to);
  const seconds = Math.max(0, Math.floor((end - Date.parse(from)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A calendar date in the reader's locale, such as `Oct 4, 2026`. */
export const dateOnly = (value: string): string => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });

const stamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fullStamp = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'long' });
/** The conversation-page timestamp: a short local label and the full local time for its title, or null when unreadable. */
export function timeStamp(value: string): { label: string; title: string } | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { label: stamp.format(date), title: fullStamp.format(date) } : null;
}
