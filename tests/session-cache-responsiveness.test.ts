import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Homes, SessionTurnCacheSchema } from '../packages/core/dist/index.js';
import { ProjectLedger, ProjectPaths, cacheRecords } from '../packages/projects/dist/index.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
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
