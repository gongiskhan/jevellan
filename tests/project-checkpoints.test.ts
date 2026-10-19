import { expect, test } from 'vitest';
import { SessionCheckpointSettingsSchema, StoredProjectWorkSettingsSchema, defaultProjectWorkSettings, SessionTurnCacheSchema } from '../packages/core/dist/index.js';
import { coldCheckpoint, coordinatorRestart, threadRestart } from '../packages/projects/dist/index.js';
const row = SessionTurnCacheSchema.parse({ schema: 'session-turn-cache-v1', owner: { kind: 'thread', id: 'thread' }, sessionId: 'a'.repeat(64), runtime: 'codex', model: 'model', accountId: 'account', turn: 1,
  at: '2026-10-14T00:00:00Z', activityAt: '2026-10-14T00:00:00Z', activitySource: 'context', contextTokensBefore: null, contextTokensAfter: 50000, idleSeconds: null, startedCold: false, cacheWindowMinutes: 10,
  cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0, outputTokens: 0, usageKnown: false, cacheWritesKnown: false });
test('unknown timing/context and single-run roles never manufacture a checkpoint', () => {
  const settings = { enabled: true, checkpointMinTokens: 40000 }, now = Date.parse(row.at) + 11 * 60000;
  expect(coldCheckpoint(settings, undefined, 'native', 10, now)).toBeUndefined();
  expect(coldCheckpoint(settings, row, undefined, 10, now)).toBeUndefined();
  expect(coldCheckpoint(settings, { ...row, contextTokensAfter: null }, 'native', 10, now)).toBeUndefined();
  for (const kind of ['review', 'verification', 'memory'] as const) expect(coldCheckpoint(settings, { ...row, owner: { kind, id: 'aux' } }, 'native', 10, now)).toBeUndefined();
});
test('checkpoint settings migrate additively with defaults off, validate limits, and preserve unrelated fields', () => {
  const old = { ...defaultProjectWorkSettings('project'), autoLand: true, compactAtPercent: 65, riskyAreas: 'Data' };
  const { sessionCheckpoints: _checkpoints, ...stored } = old; void _checkpoints;
  expect(StoredProjectWorkSettingsSchema.parse(stored)).toMatchObject({ sessionCheckpoints: { enabled: false, checkpointMinTokens: 40000 }, autoLand: true, compactAtPercent: 65, riskyAreas: 'Data' });
  for (const n of [19999, 200001, 40000.5]) expect(SessionCheckpointSettingsSchema.safeParse({ enabled: true, checkpointMinTokens: n }).success).toBe(false);
});
test('restart copy remains exact', () => {
  expect(coordinatorRestart).toBe('This is a fresh coordinator session: the previous one was idle long enough for its cache to expire. Continue from the notebook, the open state and the journal index below.');
  expect(threadRestart('/journal/thread.md')).toBe('You are continuing this task in a fresh session: the previous one was idle long enough for its cache to expire. Everything you reported and every message you received is in /journal/thread.md; the most recent part is below. Check git log and git diff in your worktree for the work already done, and continue from there.');
});
