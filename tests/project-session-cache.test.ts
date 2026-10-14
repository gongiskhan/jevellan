import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, ConfigurationSchema, seedConfiguration } from '../packages/core/dist/index.js';
import { ProjectLedgers, ProjectPaths, cacheRecords, cacheWindowMinutes, measureSession, sessionCacheSnapshot, sessionCacheSummaries } from '../packages/projects/dist/index.js';
import type { RuntimeEvent, StretchRun } from '../packages/runtime-contract/dist/index.js';
let root: string, homes: Homes;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-session-cache-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const owner = { kind: 'thread' as const, id: 'thread_cache', projectId: 'project_cache' };
function native(events: RuntimeEvent[], sessionId = 'native-private-session'): StretchRun {
  return { native: { pid: 1, pgid: 1, sessionId }, events: (async function* () { yield* events; })(), done: Promise.resolve({ status: 'completed' }),
    interrupt: async () => undefined, continue: () => { throw new Error('No additional request is permitted.'); }, terminate: async () => undefined };
}
test.each(['claude', 'codex'])('%s records provider input semantics, cold time and persistent context without additional requests', async runtime => {
  const ledgers = new ProjectLedgers(new ProjectPaths(homes)), ledger = ledgers.thread(owner.projectId, owner.id); let now = Date.parse('2026-10-14T23:30:00Z');
  const observe = async (turn: number, events: RuntimeEvent[], accountId = 'account_cache', resume?: string) => {
    const original = native(events), measured = measureSession(original, { ledger, owner, runtime, accountId, model: 'model_cache', turn, windowMinutes: 10, now: () => now, resume, timezone: 'Europe/Lisbon' });
    expect(measured.done).toBe(original.done); for await (const _event of measured.events) { void _event; } await measured.done;
  };
  await observe(1, [{ type: 'context', tokens: 450, contextWindow: 1000 }, { type: 'usage', inputTokens: runtime === 'claude' ? 100 : 450, outputTokens: 4, cacheReadTokens: 300, cacheWriteTokens: 50 }]);
  expect(cacheRecords(ledger)[0]).toMatchObject({ idleSeconds: null, startedCold: false, contextTokensBefore: null, contextTokensAfter: 450, cacheReadTokens: 300, cacheWriteTokens: 50, uncachedInputTokens: 100, usageKnown: true });
  now += 11 * 60_000;
  await observe(2, [{ type: 'context', tokens: 500 }, { type: 'usage', inputTokens: runtime === 'claude' ? 20 : 70, outputTokens: 2, cacheReadTokens: 50, cacheWriteTokens: 0 }], 'account_cache', 'native-private-session');
  expect(cacheRecords(ledger)[1]).toMatchObject({ idleSeconds: 660, startedCold: true, contextTokensBefore: 450, contextTokensAfter: 500 });
  // A restart reads the same immutable receipts, rather than a daemon-only clock.
  const reopened = new ProjectLedgers(new ProjectPaths(homes)).thread(owner.projectId, owner.id);
  expect(cacheRecords(reopened)).toEqual(cacheRecords(ledger));
  expect(JSON.stringify(cacheRecords(reopened))).not.toContain('native-private-session');
  const rows = sessionCacheSummaries(cacheRecords(reopened)); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ day: '2026-10-15', turns: 2, cacheReadTokens: 350, cacheWriteTokens: 50, uncachedInputTokens: 120, coldStarts: 1, coldWriteTokens: 0, contextTokens: 500 });
  expect(JSON.stringify(rows)).not.toContain('native-private-session');
  now += 60_000; await observe(3, [{ type: 'usage', inputTokens: 1, outputTokens: 1 }], 'other_account', 'native-private-session');
  expect(cacheRecords(ledger).at(-1)).toMatchObject({ idleSeconds: null, startedCold: false, contextTokensBefore: null });
});
test('the last observed model activity, rather than process lifetime, bounds idle; warm boundary is inclusive', async () => {
  const ledger = new ProjectLedgers(new ProjectPaths(homes)).coordinator(owner.projectId); let now = Date.parse('2026-10-14T10:00:00Z');
  const stream: StretchRun = { ...native([]), events: (async function* () { now += 5 * 60_000; yield { type: 'context' as const, tokens: 123 }; now += 1000; yield { type: 'usage' as const, inputTokens: 10, outputTokens: 1 }; })() };
  for await (const _event of measureSession(stream, { ledger, owner, runtime: 'codex', model: 'm', accountId: 'acc', turn: 1, windowMinutes: 10, now: () => now }).events) { void _event; }
  now = Date.parse(cacheRecords(ledger)[0]!.activityAt) + 10 * 60_000;
  for await (const _event of measureSession(native([{ type: 'usage', inputTokens: 2, outputTokens: 1 }]), { ledger, owner, runtime: 'codex', model: 'm', accountId: 'acc', turn: 2, windowMinutes: 10, resume: 'native-private-session', now: () => now }).events) { void _event; }
  const row = cacheRecords(ledger).at(-1)!; expect(row.idleSeconds).toBe(600); expect(row.startedCold).toBe(false); expect(row.cacheWritesKnown).toBe(false);
});
test('unreported writes and empty usage stay unknown in cold totals', async () => {
  const ledger = new ProjectLedgers(new ProjectPaths(homes)).coordinator(owner.projectId); let now = 0;
  for (const turn of [1, 2]) {
    for await (const _event of measureSession(native(turn === 1 ? [] : [{ type: 'usage', inputTokens: 5, outputTokens: 1 }]), { ledger, owner, runtime: 'codex', model: 'm', accountId: 'acc', turn, windowMinutes: 1, ...(turn === 2 ? { resume: 'native-private-session' } : {}), now: () => now }).events) { void _event; }
    now += 2 * 60_000;
  }
  expect(cacheRecords(ledger)[0]!.usageKnown).toBe(false);
  expect(sessionCacheSummaries(cacheRecords(ledger))[0]).toMatchObject({ coldStarts: 1, coldWriteTokens: null, usageKnown: false });
});
test('cache window settings preserve unrelated runtime fields and test overrides are refused in installed homes', () => {
  const configuration = seedConfiguration(); configuration['x-jevellan'].runtimes.claude = { enabled: true, useOwnSetup: false, cacheWindowMinutes: 17 };
  expect(ConfigurationSchema.parse(configuration)['x-jevellan'].runtimes.claude).toEqual({ enabled: true, useOwnSetup: false, cacheWindowMinutes: 17 });
  expect(cacheWindowMinutes(17, homes, {})).toBe(17);
  expect(cacheWindowMinutes(17, homes, { NODE_ENV: 'test', JEVELLAN_TEST_CACHE_WINDOW_MINUTES: '1' })).toBe(1);
  for (const value of ['0', '6', '1.5', '01']) expect(() => cacheWindowMinutes(17, homes, { NODE_ENV: 'test', JEVELLAN_TEST_CACHE_WINDOW_MINUTES: value })).toThrow();
  expect(() => cacheWindowMinutes(17, homes, { JEVELLAN_TEST_CACHE_WINDOW_MINUTES: '1' })).toThrow('refused');
  writeFileSync(homes.at('install.json'), '{}'); expect(() => cacheWindowMinutes(17, homes, { NODE_ENV: 'test', JEVELLAN_TEST_CACHE_WINDOW_MINUTES: '1' })).toThrow('refused');
});

test('published counters retain only the latest recorded day while the ledger keeps prior days', async () => {
  const ledger = new ProjectLedgers(new ProjectPaths(homes)).coordinator(owner.projectId); let now = Date.parse('2026-10-14T10:00:00Z');
  for (const turn of [1, 2]) {
    for await (const event of measureSession(native([{ type: 'usage', inputTokens: 10, outputTokens: 1 }]), { ledger, owner, runtime: 'claude', model: 'm', accountId: 'acc', turn,
      windowMinutes: 60, now: () => now, timezone: 'Europe/Lisbon', ...(turn === 2 ? { resume: 'native-private-session' } : {}) }).events) void event;
    now += 86400000;
  }
  expect(sessionCacheSummaries(cacheRecords(ledger))).toHaveLength(2);
  expect(sessionCacheSnapshot(cacheRecords(ledger))).toMatchObject([{ day: '2026-10-15', turns: 1 }]);
});
