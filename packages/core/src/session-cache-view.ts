import { z } from 'zod';
import { IdSchema } from './schemas.js';
import type { SessionCacheSummary } from './session-cache-schemas.js';

const count = z.number().int().nonnegative();
export const SessionCacheViewSchema = z.strictObject({ schema: z.literal('session-cache-view-v1'), projectId: IdSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), timezone: z.string().min(1).max(120),
  line: z.strictObject({ ariaLabel: z.string(), prefix: z.string(), ratio: z.string(), coldStarts: count, coldStartsLabel: z.string(), coldWriteTokens: count.nullable(), coldWritesLabel: z.string() }),
  table: z.strictObject({ summary: z.string(), caption: z.string(), columns: z.array(z.string()).length(6), empty: z.string(),
    rows: z.array(z.strictObject({ key: z.string(), title: z.string(), subtitle: z.string(), turns: count, ratio: z.string(), coldStarts: count, coldWriteTokens: count.nullable(), contextTokens: count.nullable() })) }) });
export type SessionCacheView = z.infer<typeof SessionCacheViewSchema>;
export const SESSION_CACHE_UNAVAILABLE = 'Session cache is unavailable.';

export function sessionCacheDay(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function cacheHit(row: SessionCacheSummary): string {
  const total = row.cacheReadTokens + row.cacheWriteTokens + row.uncachedInputTokens;
  return row.usageKnown && total > 0 ? `${Math.round(row.cacheReadTokens / total * 100)}%` : 'Unknown';
}
export const cacheTokens = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString();

/** Calendar-day read model; nightly work keeps its separate project-day boundary. No moving timestamp enters the model. */
export function sessionCacheView(input: { projectId: string; rows?: readonly SessionCacheSummary[] | undefined; sessionKey?: string | undefined;
  timezone: string; titles?: Readonly<Record<string, string>> | undefined; now?: Date | undefined }): SessionCacheView {
  const rows = input.rows ?? [], titles = input.titles ?? {}, day = sessionCacheDay(input.timezone, input.now);
  const current = rows.find(row => row.key === input.sessionKey && row.day === day);
  return SessionCacheViewSchema.parse({ schema: 'session-cache-view-v1', projectId: input.projectId, day, timezone: input.timezone,
    line: { ariaLabel: 'Session cache today', prefix: 'Cache today', ratio: current ? cacheHit(current) : 'Unknown', coldStarts: current?.coldStarts ?? 0,
      coldStartsLabel: 'cold starts', coldWriteTokens: current?.coldWriteTokens ?? null, coldWritesLabel: 'tokens written cold' },
    table: { summary: 'Sessions and cache · today', caption: `Today in ${input.timezone}`, columns: ['Session', 'Turns', 'Hit ratio', 'Cold starts', 'Tokens written cold', 'Context'],
      empty: 'No session usage recorded today.', rows: rows.filter(row => row.day === day).map(row => ({ key: row.key, title: titles[row.owner.id] ?? row.owner.kind,
        subtitle: `${row.runtime} · ${row.model} · ${row.key.slice(0, 8)}`, turns: row.turns, ratio: cacheHit(row), coldStarts: row.coldStarts,
        coldWriteTokens: row.coldWriteTokens, contextTokens: row.contextTokens })) } });
}
