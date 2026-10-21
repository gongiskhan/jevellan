import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SessionTurnCacheSchema, ThreadCreatedViewSchema, ProjectWorkViewSchema, ThreadViewSchema } from '../packages/core/dist/index.js';
import { cacheRecords, projectDay } from '../packages/projects/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
function record(at: number, owner: { kind: 'coordinator' | 'thread'; id: string }, sessionId = 'synthetic-cache-session', runtime = 'fake', accountId = 'account_cache') {
  return SessionTurnCacheSchema.parse({ schema: 'session-turn-cache-v1', owner, sessionId: createHash('sha256').update(sessionId).digest('hex'), runtime, model: 'Cache fixture', accountId,
    turn: 1, at: new Date(at).toISOString(), activityAt: new Date(at).toISOString(), activitySource: 'usage', idleSeconds: 601, startedCold: true, cacheWindowMinutes: 10,
    contextTokensBefore: 100, contextTokensAfter: 500, cacheReadTokens: 300, cacheWriteTokens: 50, uncachedInputTokens: 100, outputTokens: 8,
    usageKnown: true, cacheWritesKnown: true, timezone: 'Europe/Lisbon' });
}

test('project cache reader owns calendar-day rows, titles and ratios shared by status without extra work', async () => {
  const now = Date.parse('2026-10-20T23:30:00.000Z'), f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  const ledger = f.app.projectWork.ledgers.coordinator('project'); ledger.append({ type: 'session-turn-cache', turn: 1, data: record(now, { kind: 'coordinator', id: 'project' }) });
  const before = cacheRecords(ledger); const response = await f.request('/api/projects/project/work'); expect(response.status).toBe(200); const view = await response.json();
  expect(view.cacheView).toMatchObject({ schema: 'session-cache-view-v1', projectId: 'project', day: '2026-10-21', timezone: 'Europe/Lisbon',
    line: { ratio: 'Unknown', coldStarts: 0, coldWriteTokens: null }, table: { summary: 'Sessions and cache · today', caption: 'Today in Europe/Lisbon',
      columns: ['Session', 'Turns', 'Hit ratio', 'Cold starts', 'Tokens written cold', 'Context'], rows: [{ title: 'Coordinator', turns: 1, ratio: '67%', coldStarts: 1, coldWriteTokens: 50, contextTokens: 500 }] } });
  expect(projectDay(now, '02:00', 'Europe/Lisbon')).toBe('2026-10-20');
  expect(await f.app.ownerTools.call('status', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'status', args: { project: 'project' } })).toMatchObject({ ok: true, data: { cacheView: view.cacheView } });
  expect(cacheRecords(ledger)).toEqual(before); expect(f.fake.runs).toHaveLength(0);
  const older = { ...view }; delete older.cacheView; expect(ProjectWorkViewSchema.safeParse(older).success).toBe(true);
  expect(ProjectWorkViewSchema.safeParse({ ...view, cacheView: { ...view.cacheView, unexpected: true } }).success).toBe(false);
});

test('thread cache reader uses its current hashed session and keeps unknown usage explicit', async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated cache read ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'thread_cache_view', title: 'Cache reader fixture', task: 'Inspect simulated cache data.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle'); now = Date.parse('2050-10-20T23:30:00.000Z');
  const thread = f.thread(made.threadId); expect(thread.nativeSessionId).toBeTruthy();
  const ledger = f.app.projectWork.ledgers.thread('project', made.threadId);
  ledger.append({ type: 'session-turn-cache', turn: 1, data: record(now, { kind: 'thread', id: made.threadId }, thread.nativeSessionId!, thread.placement.runtime, thread.placement.accountId) });
  ledger.append({ type: 'session-turn-cache', turn: 1, data: { ...record(now, { kind: 'thread', id: made.threadId }, 'unknown-usage-session', thread.placement.runtime, thread.placement.accountId), usageKnown: false, cacheWritesKnown: false } });
  const response = await f.request(`/api/projects/project/threads/${made.threadId}`); expect(response.status).toBe(200); const view = await response.json();
  expect(view.cacheView).toMatchObject({ schema: 'session-cache-view-v1', day: '2050-10-21', line: { ratio: '67%', coldStarts: 1, coldWriteTokens: 50 } });
  expect(view.cacheView.table.rows).toEqual(expect.arrayContaining([expect.objectContaining({ ratio: 'Unknown', coldWriteTokens: null }), expect.objectContaining({ ratio: '67%', coldWriteTokens: 50 })]));
  const before = structuredClone(f.thread(made.threadId)); expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: made.threadId } })).toMatchObject({ ok: true, data: { cacheView: view.cacheView } }); expect(f.thread(made.threadId)).toEqual(before);
  const older = { ...view }; delete older.cacheView; expect(ThreadViewSchema.safeParse(older).success).toBe(true);
});

test('cache midnight rollover changes the normal page token without moving the nightly two-hour boundary', async () => {
  let now = Date.parse('2026-10-20T22:59:59.000Z'); const f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  const ledger = f.app.projectWork.ledgers.coordinator('project'); ledger.append({ type: 'session-turn-cache', turn: 1, data: record(now, { kind: 'coordinator', id: 'project' }) });
  const before = await f.app.projectWork.pageView('project'); expect(before.work).toMatchObject({ cacheView: { day: '2026-10-20', table: { rows: [{ ratio: '67%' }] } } });
  now += 2000; const after = await f.app.projectWork.pageView('project'); expect(after.work).toMatchObject({ cacheView: { day: '2026-10-21', table: { rows: [] }, line: { ratio: 'Unknown', coldStarts: 0 } } });
  expect(after.changeToken).not.toBe(before.changeToken); expect(projectDay(now, '02:00', 'Europe/Lisbon')).toBe('2026-10-20');
  now += 1000; expect((await f.app.projectWork.pageView('project')).work).toMatchObject({ cacheView: after.work.cacheView });
});
