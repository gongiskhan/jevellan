import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Homes, SessionTurnCacheSchema } from '../packages/core/dist/index.js';
import { ProjectLedger, ProjectPaths, cacheRecords, sessionCacheSummaries } from '../packages/projects/dist/index.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
test('session day summaries reuse formatters within a batch and retain time zone boundaries', () => {
  const at = '2026-10-23T23:30:00.000Z', zones = ['UTC', 'Pacific/Kiritimati'];
  const days = zones.map(timeZone => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)));
  const records = Array.from({ length: 300 }, (_, n) => SessionTurnCacheSchema.parse({ schema: 'session-turn-cache-v1', owner: { kind: 'coordinator', id: 'project' }, sessionId: 'a'.repeat(64),
    runtime: 'codex', model: 'model', accountId: 'account', turn: n + 1, at, idleSeconds: null, startedCold: false, cacheWindowMinutes: 10,
    contextTokensBefore: null, cacheReadTokens: 2, cacheWriteTokens: 0, uncachedInputTokens: 3, outputTokens: 1, activityAt: at,
    activitySource: 'usage', contextTokensAfter: 5, usageKnown: true, cacheWritesKnown: true, timezone: zones[n % 2] }));
  const formatter = vi.spyOn(Intl, 'DateTimeFormat'); let constructions: number;
  try {
    const rows = sessionCacheSummaries(records); constructions = formatter.mock.calls.filter(([, options]) => options?.year === 'numeric').length;
    expect(rows.map(row => ({ day: row.day, timezone: row.timezone, turns: row.turns, read: row.cacheReadTokens })))
      .toEqual(zones.map((timezone, n) => ({ day: days[n], timezone, turns: 150, read: 300 })));
  } finally { formatter.mockRestore(); }
  const rows = sessionCacheSummaries(records, 'UTC'); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ turns: 300, cacheReadTokens: 600, day: days[0] });
  expect(constructions!, 'One batch must construct at most one day formatter per distinct time zone.').toBeLessThanOrEqual(2);
});

test('cache summaries read a large history without copying unrelated message payloads', () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-cache-response-')); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'data'), join(root, 'user')), paths = new ProjectPaths(homes), ledger = new ProjectLedger(paths, 'project');
  mkdirSync(join(ledger.dir, 'ledger'), { recursive: true });
  const rows = Array.from({ length: 13000 }, (_, n) => JSON.stringify({ schema: 'project-ledger-event-v1', id: n + 1, t: '2026-10-23T10:00:00.000Z',
    type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Simulated history. '.repeat(65) } }));
  const file = join(ledger.dir, 'ledger', '000001.jsonl'); writeFileSync(file, rows.join('\n') + '\n');
  const cache = SessionTurnCacheSchema.parse({ schema: 'session-turn-cache-v1', owner: { kind: 'coordinator', id: 'project' }, sessionId: 'a'.repeat(64),
    runtime: 'codex', model: 'model', accountId: 'account', turn: 1, at: '2026-10-23T10:00:00.000Z', idleSeconds: null, startedCold: false, cacheWindowMinutes: 10,
    contextTokensBefore: null, cacheReadTokens: 2, cacheWriteTokens: 0, uncachedInputTokens: 3, outputTokens: 1, activityAt: '2026-10-23T10:00:00.000Z',
    activitySource: 'usage', contextTokensAfter: 5, usageKnown: true, cacheWritesKnown: true, timezone: 'UTC' });
  ledger.append({ type: 'session-turn-cache', data: cache }); expect(cacheRecords(ledger)).toEqual([cache]);
  const started = process.cpuUsage();
  for (let n = 0; n < 12; n++) expect(cacheRecords(ledger)).toEqual([cache]);
  const elapsed = process.cpuUsage(started);
  expect((elapsed.user + elapsed.system) / 1000, 'Small cache summaries must not repeatedly clone the complete project history.').toBeLessThan(120);
  const exposed = cacheRecords(ledger); exposed[0]!.outputTokens = 999; expect(cacheRecords(ledger)).toEqual([cache]);
  const other = new ProjectLedger(paths, 'project'); other.append({ type: 'session-turn-cache', data: { ...cache, turn: 2, outputTokens: 7 } });
  expect(cacheRecords(ledger).map(row => row.outputTokens)).toEqual([1, 7]);
  const before = statSync(file), original = readFileSync(file, 'utf8'); writeFileSync(file, original.replace('"id":1,', '"id":2,')); utimesSync(file, before.atime, before.mtime);
  expect(() => cacheRecords(ledger)).toThrow('sequence');
}, 60000);
