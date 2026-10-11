import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EkoaStateSchema, ProjectWindowSchema, Homes, ProjectSchema, ProjectDecisionSchema, ProjectWorkTaskSchema, PullRequestReviewSchema, ThreadIndexSchema } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { EkoaMirrorService } from '../apps/daemon/dist/ekoa-mirror.js';
import { connectEkoa } from '../apps/daemon/dist/ekoa-client.js';
import { startEkoaFixture } from './fixtures/ekoa-server.mjs';
let root: string, hub: HubDatabase, service: EkoaMirrorService, remote: Awaited<ReturnType<typeof startEkoaFixture>>;
let clock: number; const at = '2026-10-11T12:00:00Z';
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-ekoa-')); hub = new HubDatabase(new Homes(join(root, 'home'), join(root, 'native')), 'hub'); remote = await startEkoaFixture(); clock = Date.parse(at);
  hub.put('projects', 'project', ProjectSchema, { schema: 'project-v1', id: 'project', name: 'App', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
  hub.vault.put('ekoa', remote.token); service = new EkoaMirrorService(hub, () => 'https://fixture.example', undefined, () => clock);
  hub.put('ekoa-settings', 'current', EkoaStateSchema.shape.settings, { schema: 'ekoa-settings-v1', revision: 1, url: remote.url, enabled: true }, 0);
});
afterEach(async () => { await service.close(); await remote.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
function decision(id = 'choice') { hub.put('project-decisions', id, ProjectDecisionSchema, { schema: 'project-decision-v1', revision: 1, id, projectId: 'project', from: 'coordinator', question: 'Which empty state?', options: [{ label: 'Short' }, { label: 'Detailed' }], createdAt: at }, 0); }
function draft(id: string) { hub.put('project-work-tasks', id, ProjectWorkTaskSchema, { schema: 'project-work-task-v1', id, projectId: 'project', revision: 1, title: id, brief: 'Inspect a regression.', kind: 'session', type: 'fix', goalId: null, source: 'finding', state: 'draft', rank: id, ownerRanked: false, now: false, after: [], needs: [], dailyId: null, jobId: null, threadId: null, jobRunId: null, fixed: {}, createdAt: at, updatedAt: at }, 0); }
function pull(state: 'open' | 'merged' = 'open', commit = 'a'.repeat(40)) {
  const old = hub.get('project-threads', 'thread', ThreadIndexSchema);
  hub.put('project-threads', 'thread', ThreadIndexSchema, { schema: 'project-thread-index-v1', revision: (old?.revision ?? 0) + 1, id: 'thread', projectId: 'project', title: 'Handle empty input', state: 'in-review', isolation: 'worktree', ownerDeviceId: 'pro', runtime: 'codex', modelLabel: 'Model', effort: 'high', accountLabel: 'Account', turns: 1, createdAt: at, updatedAt: at,
    pr: { number: 1, url: 'https://github.com/fixture/repo/pull/1', state, headSha: commit, checks: 'passing', mergeable: 'clean', updatedAt: at } }, old?.revision ?? 0);
}
test('LJ8 decisions complete, ask-owner pulls mirror once and drafts update one aggregate then reopen it', async () => {
  decision(); pull(); for (const id of ['one', 'two', 'three']) draft(id);
  await service.tick(); expect(remote.tasks.size).toBe(2); expect(remote.labels).toEqual(new Set(['Jevellan']));
  hub.put('project-decisions', 'merge_choice', ProjectDecisionSchema, { schema: 'project-decision-v1', revision: 1, id: 'merge_choice', projectId: 'project', threadId: 'thread', from: 'thread', question: 'Merge #1 Handle empty input?', options: [{ label: 'Merge' }, { label: 'Send back with a note' }, { label: 'Close' }], createdAt: at, merge: { commit: 'a'.repeat(40), prNumber: 1 } }, 0);
  await service.tick(); await service.tick(); expect(remote.tasks.size).toBe(3);
  const choice = hub.get('project-decisions', 'choice', ProjectDecisionSchema)!; hub.put('project-decisions', 'choice', ProjectDecisionSchema, { ...choice.document, answeredAt: at, answer: { text: 'Short.' } }, choice.revision);
  const first = hub.get('project-work-tasks', 'one', ProjectWorkTaskSchema)!; hub.put('project-work-tasks', 'one', ProjectWorkTaskSchema, { ...first.document, state: 'queued' }, first.revision);
  pull('merged'); await service.tick();
  expect([...remote.tasks.values()].filter(task => task.status === 'done')).toHaveLength(2);
  const aggregate = [...remote.tasks.values()].find(task => task.title.includes('proposed tasks'))!; expect(aggregate.title).toBe('Jevellan · App: 2 proposed tasks');
  for (const id of ['two', 'three']) { const row = hub.get('project-work-tasks', id, ProjectWorkTaskSchema)!; hub.put('project-work-tasks', id, ProjectWorkTaskSchema, { ...row.document, state: 'cancelled' }, row.revision); }
  await service.tick(); expect(aggregate.status).toBe('done'); draft('four'); await service.tick(); expect(aggregate.status).toBe('open'); expect(aggregate.title).toContain('1 proposed tasks'); expect(remote.tasks.size).toBe(3);
  expect(JSON.stringify(service.state())).not.toContain(remote.token);
});
test('lost create receipts recover the owned task after backoff and restart without duplicate creation', async () => {
  decision(); remote.loseCreate(); await service.tick(); expect(remote.tasks.size).toBe(1); expect(service.state().mirrors[0]!.error).toContain('lost create');
  const creates = () => remote.calls.filter(call => call.name === 'task_create').length;
  await service.tick(); expect(creates()).toBe(1); await service.close(); clock += 16_000;
  service = new EkoaMirrorService(hub, () => 'https://fixture.example', undefined, () => clock); await service.tick();
  expect(creates()).toBe(1); expect(service.state().mirrors[0]).toMatchObject({ state: 'open', attempts: 0 }); expect(service.state().mirrors[0]!.error).toBeUndefined();
});
test('an ownership marker removed by the owner prevents completion or modification', async () => {
  decision(); await service.tick(); const task = [...remote.tasks.values()][0]!; task.notes = 'The owner replaced this task.';
  const row = hub.get('project-decisions', 'choice', ProjectDecisionSchema)!; hub.put('project-decisions', 'choice', ProjectDecisionSchema, { ...row.document, withdrawnAt: at }, row.revision);
  await service.tick(); expect(task.status).toBe('open'); expect(service.state().mirrors[0]!.error).toContain('ownership marker'); expect(remote.calls.some(call => call.name === 'task_complete')).toBe(false);
});
test('historical reviews do not create merge items and global failures back off without blocking Projects', async () => {
  pull(); hub.put('project-pr-reviews', 'thread', PullRequestReviewSchema, { schema: 'pull-request-review-v1', revision: 1, projectId: 'project', threadId: 'thread', deviceId: 'pro', commit: 'b'.repeat(40), verdict: 'approve', note: 'Old head.', reviewedAt: at }, 0);
  await service.tick(); expect(remote.tasks.size).toBe(0); remote.failLabels(true); await service.tick();
  const count = remote.calls.length; await service.tick(); expect(remote.calls.length).toBe(count); expect(service.state().connection?.status).toBe('blocked');
  clock += 16_000; remote.failLabels(false); await service.tick(); expect(service.state().connection?.status).toBe('connected');
});
test('real MCP discovery requires token auth and required recovery tools; URLs reject credentials and plain remote HTTP', async () => {
  expect(EkoaStateSchema.shape.settings.parse({ schema: 'ekoa-settings-v1', revision: 0, url: '', enabled: false }).url).toBe('');
  const connected = await connectEkoa(remote.url, remote.token); expect(connected.tools.has('task_create')).toBe(true); await connected.close();
  await expect(connectEkoa(remote.url, 'wrong-token')).rejects.toThrow();
  for (const url of ['http://remote.example/mcp', 'https://user:secret@example.test/mcp', 'https://example.test/mcp?token=private']) await expect(connectEkoa(url, remote.token)).rejects.toThrow();
});

test('a server without ownership recovery tools is blocked before it can create any task', async () => {
  const incomplete = await startEkoaFixture({ omitTool: 'task_get' });
  try { await expect(connectEkoa(incomplete.url, incomplete.token)).rejects.toThrow('missing task_get'); expect(incomplete.tasks.size).toBe(0); }
  finally { await incomplete.close(); }
});


test('one failed night creates one durable report mirror and respects the owner completing it', async () => {
  hub.put('project-windows', 'night', ProjectWindowSchema, { schema: 'project-window-v1', id: 'night', projectId: 'project', revision: 1, date: '2026-10-11', closingProjectDay: '2026-10-10', state: 'finished', mergesHeld: false, openedAt: at, finishedAt: at, taskIds: [], plans: [], failed: true, outcome: 'Full suite: failed\nDeploy: skipped' }, 0);
  await service.tick(); await service.tick(); expect(remote.tasks.size).toBe(1);
  const report = [...remote.tasks.values()][0]!; expect(report.title).toBe('Jevellan · App: night report'); expect(report.notes).toContain('Deploy: skipped');
  report.status = 'done'; await service.tick(); expect(report.status).toBe('done'); expect(service.state().mirrors[0]).toMatchObject({ kind: 'night-report', state: 'completed' });
  expect(remote.calls.filter(call => call.name === 'task_create')).toHaveLength(1); expect(remote.calls.some(call => call.name === 'task_reopen')).toBe(false);
});
