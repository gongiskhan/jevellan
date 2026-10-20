import { afterEach, expect, test } from 'vitest';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { ProjectPageViewSchema, ProjectWorkTaskSchema, ThreadIndexSchema, type ProjectWorkTask, type ThreadIndex } from '../packages/core/dist/index.js';
import { projectPageView, threadSections } from '../packages/projects/dist/page-view.js';
import { overviewBoard } from '../packages/projects/dist/owner-status.js';
import { sidebarView } from '../packages/projects/dist/views.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('sidebar view supplies ordered active and archived rows, waiting total and home target', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/project-work/sidebar');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ schema: 'project-sidebar-view-v1', activeIds: ['project'], archivedIds: [], waitingTotal: 0, defaultProject: 'project' });
});

test('sidebar archive split and default project use the same case-insensitive stable order', () => {
  const row = (projectId: string, name: string, waiting: number, status: 'active' | 'paused' | 'archived') => ({ projectId, name, waiting, status,
    running: 0, inReview: 0, coordinator: { deviceId: null, state: 'none' as const } });
  const view = sidebarView([row('z', 'Zeta', 1, 'active'), row('archive', 'Alpha', 99, 'archived'), row('a', 'alpha', 2, 'paused'), row('b', 'Beta', 3, 'active')]);
  expect(view.activeIds).toEqual(['a', 'b', 'z']); expect(view.archivedIds).toEqual(['archive']);
  expect(view.waitingTotal).toBe(6); expect(view.defaultProject).toBe('a');
  const archived = sidebarView([row('archive', 'Alpha', 99, 'archived')]);
  expect(archived.activeIds).toEqual([]); expect(archived.defaultProject).toBeNull(); expect(archived.waitingTotal).toBe(0);
});

test('status view combines the project page and derives its empty Overview on the engine', async () => {
  const f = fixture = await projectFixture();
  const settings = await f.app.projectWork.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, delivery: 'pull-request' }, settings.revision);
  const response = await f.request('/api/projects/project/status-view');
  expect(response.status).toBe(200);
  const view = ProjectPageViewSchema.parse(await response.json());
  expect(view).toMatchObject({ schema: 'project-page-view-v1', work: { project: { id: 'project' } },
    tasks: [], goals: [], daily: { projectId: 'project' },
    overview: { defaultSurface: 'chat', waiting: { label: 'Waiting for you', count: 0, isEmpty: true },
      queueCount: 0, goalCount: 0, nightlyCount: 0, pullRequests: [], recentlyMerged: [] } });
  expect(view.overview.sections.map(section => section.id)).toEqual(['review', 'working', 'landing', 'landed', 'idle', 'resolved']);
  expect(view.overview.sections.find(section => section.id === 'review')!.visible).toBe(true);
  expect(view.overview.sections.find(section => section.id === 'landed')!.visible).toBe(false);
  for (const query of ['resolvedDays=13', 'resolvedDays=14.5', 'resolvedDays=NaN', 'extra=true']) {
    expect((await f.request(`/api/projects/project/status-view?${query}`)).status, query).toBe(400);
  }
  expect((await f.request('/api/projects/project/status-view', 'POST', {})).status).toBe(405);
  expect((await f.request('/api/projects/missing/status-view')).status).toBe(404);
});

test('Overview preserves waiting totals, delivery visibility, resolved windows and PR eligibility', async () => {
  const f = fixture = await projectFixture();
  const base = await f.app.projectWork.pageView('project'), now = Date.parse('2026-10-20T12:00:00Z');
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const thread = (id: string, fields: Partial<ThreadIndex> = {}) => ThreadIndexSchema.parse({ schema: 'project-thread-index-v1',
    revision: 1, id, projectId: 'project', title: id, state: 'idle', isolation: 'worktree', ownerDeviceId: 'dev_a', runtime: 'fake',
    modelLabel: 'Fake', effort: 'medium', accountLabel: 'Test', turns: 1, createdAt: at(20), updatedAt: at(0), ...fields });
  const task = (id: string, state: ProjectWorkTask['state']) => ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id,
    projectId: 'project', revision: 1, title: id, brief: 'Fixture', kind: 'session', type: 'feature', source: 'owner', state,
    rank: id, ownerRanked: false, now: false, after: [], needs: [], fixed: {}, goalId: null, dailyId: null, jobId: null,
    threadId: id === 'task_review' ? 'review' : null, jobRunId: null, createdAt: at(0), updatedAt: at(0) });
  const pr = (number: number, state: 'open' | 'closed' | 'merged', updatedAt = at(0)): NonNullable<ThreadIndex['pr']> => ({ number, state, url: `https://github.com/fixture/repo/pull/${number}`,
    headSha: 'abc', checks: 'pending' as const, mergeable: 'clean' as const, updatedAt });
  const threads = [thread('waiting', { state: 'waiting-for-you' }), thread('failed', { state: 'failed' }), thread('review', { state: 'in-review', delivery: 'pull-request', pr: pr(1, 'open') }),
    thread('old', { state: 'stopped', endedAt: at(15) }), thread('edge', { state: 'done', endedAt: at(14) })];
  const input = { ...base, work: { ...base.work, threads, board: overviewBoard(threads), pullRequests: [
    { threadId: 'review', title: 'Review', pr: pr(1, 'open') }, { threadId: 'branch', title: 'Branch', branch: 'work', reason: 'No token' },
    { threadId: 'merged', title: 'Merged', pr: pr(2, 'merged', at(7)) }, { threadId: 'ancient', title: 'Ancient', pr: pr(3, 'merged', new Date(now - 7 * 86_400_000 - 1).toISOString()) },
    { threadId: 'closed', title: 'Closed', pr: pr(4, 'closed') } ] }, tasks: ['draft', 'queued', 'active', 'in-review', 'done', 'failed', 'cancelled'].map(state => task(`task_${state === 'in-review' ? 'review' : state}`, state as ProjectWorkTask['state'])) };
  const view = projectPageView(input, 14, now).overview;
  expect(view.waiting).toEqual({ label: 'Waiting on you', emptyText: 'Nothing needs you.', count: 3, isEmpty: false, draftIds: ['task_draft'], threadIds: ['waiting', 'failed'] });
  expect(view.defaultSurface).toBe('overview'); expect(view.queueCount).toBe(4); expect(view.showPullRequestsTab).toBe(true);
  expect(view.sections.filter(section => section.visible).map(section => section.id)).toEqual(['working', 'landing', 'landed', 'idle', 'resolved']);
  expect(view.sections.find(section => section.id === 'resolved')!.threadIds).toEqual(['edge']);
  expect(projectPageView(input, 28, now).overview.sections.find(section => section.id === 'resolved')!.threadIds).toEqual(['edge', 'old']);
  expect(view.pullRequests.map(row => row.entry.threadId)).toEqual(['review', 'branch']);
  expect(view.recentlyMerged.map(row => row.entry.threadId)).toEqual(['merged']);
  expect(view.pullRequests[0]).toMatchObject({ taskId: 'task_review', shadow: true, held: false, mergeRefusal: null, checks: { text: 'Checks running', tone: 'warn' } });
  const pull = input.work.pullRequests[0]!;
  if (!pull.pr) throw new Error('Missing test PR');
  pull.pr.checks = 'failing'; pull.pr.mergeable = 'conflict';
  expect(projectPageView(input, 14, now).overview.pullRequests[0]).toMatchObject({ conflicts: true,
    mergeRefusal: 'This pull request has conflicts. Ask the thread to resolve them first.', checks: { text: 'Checks failing', tone: 'danger' } });
  input.daily.mergesHeld = true;
  expect(projectPageView(input, 14, now).overview.pullRequests[0]!.mergeRefusal).toBe('Merges are held while the nightly window runs.');
  input.daily.mergeAllowedThreads = ['review'];
  expect(projectPageView(input, 14, now).overview.pullRequests[0]!.held).toBe(false);
  const first = projectPageView(input, 14, now + 1000), later = projectPageView(input, 14, now + 2000);
  expect(later.changeToken).toBe(first.changeToken); expect(later.at).not.toBe(first.at);
  input.tasks[0]!.title = 'Edited'; expect(projectPageView(input, 14, now + 1000).changeToken).not.toBe(first.changeToken);
});

test('legacy Running and Concluded projections keep their age window and deterministic order in the engine', () => {
  const now = Date.parse('2026-10-20T12:00:00Z'), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const thread = (id: string, state: ThreadIndex['state'], created = 60, ended?: number) => ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 1,
    id, projectId: 'project', title: id, state, isolation: 'worktree', ownerDeviceId: 'dev_a', runtime: 'fake', modelLabel: 'Fake', effort: 'medium',
    accountLabel: 'Test', turns: 1, createdAt: at(created), updatedAt: at(0), ...(ended === undefined ? {} : { endedAt: at(ended) }) });
  const rows = [thread('old', 'idle', 300), thread('waiting', 'waiting-for-you', 10), thread('queued', 'queued', 100), thread('attached', 'attached', 200),
    thread('review', 'in-review'), thread('done', 'done', 100, 60), thread('failed', 'failed', 60, 30), thread('stopped', 'stopped'), thread('ancient', 'done', 30_000, 15 * 24 * 60)];
  const sections = threadSections(rows, now);
  expect(sections.running.map(thread => thread.id)).toEqual(['waiting', 'queued', 'attached', 'old']);
  expect(sections.concluded.map(thread => thread.id)).toEqual(['stopped', 'failed', 'done']);
});
