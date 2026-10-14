import { expect, test } from 'vitest';
import { cacheHitRatio, measuredWindows, CacheClockSchema, CacheCheckReceiptSchema } from '../scripts/live/cache-checks.mjs';
test('cache windows use observed follow-ups at80percent and do not invent an unmeasured provider', () => {
  expect(cacheHitRatio({ usageKnown: false, cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0 })).toBeNull();
  expect(cacheHitRatio({ usageKnown: true, cacheReadTokens: 80, cacheWriteTokens: 10, uncachedInputTokens: 10 })).toBe(.8);
  expect(measuredWindows([{ runtime: 'claude', idleMinutes: 3, hitRatio: .95 }, { runtime: 'claude', idleMinutes: 55, hitRatio: .8 }, { runtime: 'claude', idleMinutes: 70, hitRatio: .79 }, { runtime: 'codex', idleMinutes: 15, hitRatio: null }])).toEqual({ claude: 55, codex: null });
});
test('cache live evidence is versioned and retains the actual independent deadline and release', () => {
  const clock = CacheClockSchema.parse({ schema: 'cache-journal-clock-v1', release: '0.3.4', priorClosingCommit: 'a'.repeat(40), buildStartedAt: '2026-10-14T04:25:11.517Z', buildDeadlineAt: '2026-10-14T12:25:11.517Z', liveStartedAt: null, liveDeadlineAt: null, overallDeadlineAt: '2026-10-14T15:25:11.517Z', checkpointDefault: false });
  expect(clock.liveStartedAt).toBeNull(); expect(CacheClockSchema.safeParse({ ...clock, release: '0.3.2' }).success).toBe(false);
  expect(CacheCheckReceiptSchema.safeParse({ schema: 'cache-live-checks-v1', label: 'simulated' }).success).toBe(false);
});
