/** Project days close at a local wall-clock time, rather than after a fixed 24 hours. */
const formatters = new Map<string, Intl.DateTimeFormat>(), boundaries = new Map<string, number>();
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
export function shiftProjectDate(date: string, days: number): string {
  if (!dayPattern.test(date)) throw new Error('Invalid project date.');
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function localParts(at: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); if (formatters.size > 100) formatters.clear(); formatters.set(timezone, formatter); }
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}
/** Earliest repeated minute on fall-back; first existing minute after a spring-forward gap. */
export function projectBoundary(date: string, time: string, timezone: string): number {
  if (!dayPattern.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new Error('Invalid project boundary.');
  const key = `${date}:${time}:${timezone}`, saved = boundaries.get(key); if (saved !== undefined) return saved;
  const target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const centre = Date.parse(`${date}T00:00:00Z`);
  for (let at = centre - 14 * 3_600_000; at <= centre + 38 * 3_600_000; at += 60_000) {
    const local = localParts(at, timezone);
    if (local.date === date && local.minute >= target) { if (boundaries.size > 1024) boundaries.clear(); boundaries.set(key, at); return at; }
  }
  throw new Error('The project boundary has no instant in this time zone.');
}
export function projectDay(at: number, time = '02:00', timezone = 'Europe/Lisbon'): string {
  const local = localParts(at, timezone);
  return at < projectBoundary(local.date, time, timezone) ? shiftProjectDate(local.date, -1) : local.date;
}
