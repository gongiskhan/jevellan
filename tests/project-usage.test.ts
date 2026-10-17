import { afterEach, expect, test, vi } from 'vitest';
import { HubUnavailable, ProjectUsageDaySchema, ProjectUsageViewSchema, ThreadCreatedViewSchema, type ProjectUsageDay } from '../packages/core/dist/index.js';
import { ProjectUsage, emptyUsage, projectUsageView, usageDay } from '../packages/projects/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
test('usage follows a project time-zone change without counting the same turn twice', async () => {
  const now = Date.parse('2026-10-17T01:00:00Z'), f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  f.app.projectWork.ledgers.sessionEnd({ projectId: 'project', owner: { kind: 'memory', id: 'memory_zone' }, runtime: 'fake', model: 'Model', startedAt: new Date(now).toISOString(), endedAt: new Date(now).toISOString(), outcome: { status: 'completed', finalText: '', usage: { inputTokens: 12, outputTokens: 1, costSource: 'unknown' } } });
  await f.app.projectWork.idle();
  const zone = async (timezone: string) => { const settings = await f.app.projectWork.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, nightlyWindow: { ...settings.nightlyWindow, timezone } }, settings.revision); };
  await zone('Pacific/Honolulu'); expect((await f.json('/api/projects/project/usage?range=today', ProjectUsageViewSchema)).totals.inputTokens).toBe(12);
  await zone('UTC'); expect((await f.json('/api/projects/project/usage?range=7d', ProjectUsageViewSchema)).totals.inputTokens).toBe(12);
});
test('an unchanged usage sweep neither replays ledgers nor rewrites hub days', async () => {
  const f = fixture = await projectFixture();
  f.app.projectWork.ledgers.sessionEnd({ projectId: 'project', owner: { kind: 'memory', id: 'memory_once' }, runtime: 'fake', model: 'Model', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: { status: 'completed', finalText: '', usage: { inputTokens: 12, outputTokens: 1, costSource: 'unknown' } } });
  await f.app.projectWork.idle();
  const reads = vi.spyOn(f.app.projectWork.ledgers.coordinator('project'), 'events'), writes = vi.spyOn(f.app.projectHub, 'putUsageDay');
  await f.app.projectWork.usage.refresh('project'); await f.app.projectWork.usage.refresh('project');
  expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
});
test('usage rebuild tolerates an offline hub and publishes its preserved counters when it returns', async () => {
  const f = fixture = await projectFixture(); let offline = true;
  f.app.projectWork.ledgers.sessionEnd({ projectId: 'project', owner: { kind: 'memory', id: 'memory_offline' }, runtime: 'fake', model: 'Model', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: { status: 'completed', finalText: '', usage: { inputTokens: 11, outputTokens: 1, costSource: 'unknown' } } });
  await f.app.projectWork.idle(); const published: unknown[] = [];
  const usage = new ProjectUsage({ deviceId: f.app.device.deviceId, hub: { putUsageDay: async (document: ProjectUsageDay) => { if (offline) throw new HubUnavailable('usage'); published.push(document); } } as never,
    ledgers: f.app.projectWork.ledgers, store: f.app.projectWork.store, now: Date.now, timezone: async () => 'UTC' });
  try { await expect(usage.rebuild()).resolves.toBeUndefined(); offline = false; await usage.refresh('project'); expect(published).toHaveLength(1); expect(ProjectUsageDaySchema.parse(published[0]).rows[0]?.inputTokens).toBe(11); }
  finally { await usage.close(); }
});
test('usage sums two devices and groups only the project calendar days across a DST boundary', () => {
  const now = Date.parse('2026-11-01T04:30:00Z'), zone = 'America/New_York';
  expect(usageDay(now, zone)).toBe('2026-11-01'); expect(usageDay(now - 3600000, zone)).toBe('2026-10-31');
  const day = (deviceId: string, date: string, tokens: number) => ProjectUsageDaySchema.parse({ schema: 'project-usage-day-v1', revision: 0,
    id: `project:${deviceId}:${date}`, projectId: 'project', deviceId, day: date, updatedAt: new Date(now).toISOString(), rows: [{ ...emptyUsage(), kind: 'thread', ownerId: 'thread_a', title: 'A small task', runtime: 'fake', modelLabel: 'Model', accountLabel: 'Work', turns: 1, inputTokens: tokens, outputTokens: 20, costUsd: 0.1, costUnknownTurns: 1 }] });
  const docs = [day('dev_a', '2026-11-01', 100), day('dev_b', '2026-11-01', 200), day('dev_a', '2026-10-31', 300)];
  const today = projectUsageView('project', 'today', docs, now, zone); expect(today.totals).toMatchObject({ turns: 2, inputTokens: 300, outputTokens: 40, costUsd: 0.2, costUnknownTurns: 2 });
  expect(today.byThread).toHaveLength(1); expect(today.byModel[0]?.inputTokens).toBe(300); expect(today.byAccount[0]?.turns).toBe(2); expect(today.byKind[0]?.label).toBe('thread');
  expect(projectUsageView('project', '7d', docs, now, zone).totals.inputTokens).toBe(600);
});
test('turn ends publish usage, index totals and all session kinds; restart rebuild does not duplicate it', async () => {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(async turn => { turn.emit({ type: 'usage', inputTokens: 120, outputTokens: 30, cacheReadTokens: 70, cacheWriteTokens: 10, costUsd: 0.04 }); return reportStep({ status: 'progress', summary: 'Done for now.' })(turn); }, forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'usage_start', title: 'A small task', task: 'Do a small task.', modelId: 'fixture', isolation: 'worktree' });
  await f.app.projectWork.idle();
  for (const kind of ['review', 'verification', 'memory'] as const) f.app.projectWork.ledgers.sessionEnd({ projectId: 'project', owner: { kind, id: `${kind}_a` }, runtime: 'fake', model: 'scripted-model', accountLabel: 'Fixture', modelLabel: 'Fixture', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: { status: 'completed', finalText: '', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costSource: 'unknown' } } });
  await f.app.projectWork.idle();
  const view = await f.json('/api/projects/project/usage?range=today', ProjectUsageViewSchema);
  expect(view.totals).toMatchObject({ turns: 4, inputTokens: 150, outputTokens: 36, costUsd: 0.04, costUnknownTurns: 3 }); expect(view.byKind).toHaveLength(4);
  expect((await f.index(created.threadId))?.usage).toMatchObject({ turns: 1, inputTokens: 120, cacheReadTokens: 70, costUsd: 0.04 });
  await f.restart(); const rebuilt = await f.json('/api/projects/project/usage?range=today', ProjectUsageViewSchema); expect(rebuilt).toEqual(view);
});
