import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { SessionCacheSummarySchema, SessionTurnCacheSchema, type Homes, type SessionCacheSummary, type SessionTurnCache } from '@jevellan/core';
import type { RuntimeEvent, StretchRun, TurnInput } from '@jevellan/runtime-contract';
import type { ProjectLedger } from './ledger.js';

export const defaultCacheWindow = (runtime: string): number => runtime === 'claude' ? 60 : 10;
export function cacheWindowMinutes(configured: number, homes: Homes, environment: NodeJS.ProcessEnv = process.env): number {
  const override = environment.JEVELLAN_TEST_CACHE_WINDOW_MINUTES;
  if (override === undefined) return configured;
  if (environment.NODE_ENV !== 'test' || existsSync(homes.at('install.json'))) throw new Error('JEVELLAN_TEST_CACHE_WINDOW_MINUTES is refused in production installations.');
  if (!/^[1-5]$/u.test(override)) throw new Error('JEVELLAN_TEST_CACHE_WINDOW_MINUTES must be an integer from 1 to 5.');
  return Number(override);
}
export function cacheRecords(ledger: ProjectLedger): SessionTurnCache[] {
  return ledger.events().flatMap(event => event.type === 'session-turn-cache' ? [ledger.payload(event as typeof event & { type: 'session-turn-cache' })] : []);
}
const privateSessionKey = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex');
export function sameCacheSession(record: SessionTurnCache, owner: TurnInput['owner'], sessionId: string, runtime: string, accountId: string): boolean {
  return record.owner.kind === owner.kind && record.owner.id === owner.id && record.sessionId === privateSessionKey(sessionId) && record.runtime === runtime && record.accountId === accountId;
}
const storedCacheKey = (owner: Pick<TurnInput['owner'], 'kind' | 'id'>, runtime: string, accountId: string, storedSessionId: string): string =>
  createHash('sha256').update(JSON.stringify([{ kind: owner.kind, id: owner.id }, runtime, accountId, storedSessionId])).digest('hex');
export const sessionCacheKey = (owner: Pick<TurnInput['owner'], 'kind' | 'id'>, runtime: string, accountId: string, sessionId: string): string =>
  storedCacheKey(owner, runtime, accountId, privateSessionKey(sessionId));

/** Observes the existing stream once; it neither makes requests nor changes the native run's lifecycle. */
export function measureSession(run: StretchRun, o: {
  ledger: ProjectLedger; owner: TurnInput['owner']; runtime: string; model: string; accountId: string; turn: number;
  windowMinutes: number; resume?: string | undefined; contextTokensBefore?: number | null | undefined; now(): number;
  timezone?: string | undefined;
}): StretchRun {
  const at = new Date(o.now()).toISOString();
  const previous = o.resume ? cacheRecords(o.ledger).findLast(row => sameCacheSession(row, o.owner, o.resume!, o.runtime, o.accountId)) : undefined;
  let input = 0, output = 0, read = 0, write = 0, known = false, writesKnown = true;
  let activityAt = at, activitySource: SessionTurnCache['activitySource'] = 'launch';
  let contextTokensAfter = o.contextTokensBefore ?? previous?.contextTokensAfter ?? null;
  const observe = (event: RuntimeEvent) => {
    if (event.type === 'context') { contextTokensAfter = event.tokens; activityAt = new Date(o.now()).toISOString(); activitySource = 'context'; }
    else if (event.type === 'compacted') contextTokensAfter = event.afterTokens;
    else if (event.type === 'usage') {
      input += event.inputTokens; output += event.outputTokens; read += event.cacheReadTokens ?? 0; write += event.cacheWriteTokens ?? 0;
      known = true; writesKnown &&= event.cacheWriteTokens !== undefined;
      if (activitySource !== 'context') { activityAt = new Date(o.now()).toISOString(); activitySource = 'usage'; }
    }
  };
  return {
    get native() { return run.native; }, done: run.done,
    events: (async function* () {
      try { for await (const event of run.events) { observe(event); yield event; } }
      finally {
        const sessionId = run.native.sessionId;
        // A setup failure that never obtained a native session is not a model request; do not invent an identity.
        if (sessionId) {
          const prior = previous?.sessionId === privateSessionKey(sessionId) ? previous : undefined;
          const idleSeconds = prior ? Math.max(0, (Date.parse(at) - Date.parse(prior.activityAt)) / 1000) : null;
          const data = SessionTurnCacheSchema.parse({ schema: 'session-turn-cache-v1', owner: { kind: o.owner.kind, id: o.owner.id }, sessionId: privateSessionKey(sessionId),
            runtime: o.runtime, model: o.model, accountId: o.accountId, turn: o.turn, at, idleSeconds,
            startedCold: idleSeconds !== null && idleSeconds > o.windowMinutes * 60, cacheWindowMinutes: o.windowMinutes,
            contextTokensBefore: o.resume === sessionId ? o.contextTokensBefore ?? prior?.contextTokensAfter ?? null : null,
            cacheReadTokens: read, cacheWriteTokens: write, uncachedInputTokens: o.runtime === 'claude' ? input : Math.max(0, input - read - write), outputTokens: output,
            activityAt, activitySource, contextTokensAfter, usageKnown: known, cacheWritesKnown: known && writesKnown, timezone: o.timezone ?? 'UTC' });
          o.ledger.append({ type: 'session-turn-cache', turn: o.turn, data });
        }
      }
    })(),
    interrupt: reason => run.interrupt(reason), continue: (message, timeout) => run.continue(message, timeout), terminate: () => run.terminate(),
  };
}

export function sessionCacheSummaries(records: SessionTurnCache[], timezone?: string): SessionCacheSummary[] {
  const rows = new Map<string, SessionCacheSummary>();
  for (const record of records) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone ?? record.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(record.at));
    const key = storedCacheKey(record.owner, record.runtime, record.accountId, record.sessionId);
    const id = `${day}:${key}`;
    const row = rows.get(id) ?? SessionCacheSummarySchema.parse({ schema: 'session-cache-summary-v1', key, owner: record.owner, runtime: record.runtime,
      model: record.model, accountId: record.accountId, day, timezone: timezone ?? record.timezone, turns: 0, cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0,
      outputTokens: 0, coldStarts: 0, coldWriteTokens: 0, contextTokens: null, usageKnown: true });
    row.turns++; row.cacheReadTokens += record.cacheReadTokens; row.cacheWriteTokens += record.cacheWriteTokens;
    row.uncachedInputTokens += record.uncachedInputTokens; row.outputTokens += record.outputTokens; row.contextTokens = record.contextTokensAfter;
    row.usageKnown &&= record.usageKnown;
    if (record.startedCold) { row.coldStarts++; row.coldWriteTokens = row.coldWriteTokens !== null && record.cacheWritesKnown ? row.coldWriteTokens + record.cacheWriteTokens : null; }
    rows.set(id, row);
  }
  return [...rows.values()];
}

/** Stable publication: retain the latest recorded project day, never a wall-clock-dependent index. */
export function sessionCacheSnapshot(records: SessionTurnCache[]): SessionCacheSummary[] {
  const rows = sessionCacheSummaries(records), day = rows.map(row => row.day).sort().at(-1);
  return rows.filter(row => row.day === day).slice(-500);
}
