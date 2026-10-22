import { openPullRequests, taskCardView, threadCardView, threadActionView } from '../packages/projects/dist/card-views.js';
import { afterEach, expect, test } from 'vitest';
import { ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { thread as makeThread, task as makeTask, at } from './helpers/owner-fixtures.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { commitStep, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('the combined page supplies card presentation from the engine', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/projects/project/status-view');
  expect(response.status).toBe(200);
  expect((await response.json()).cards).toEqual([]);
});

test('thread action presentation uses its owner base branch and preserves pending versus failing check guards', async () => {
  const f = fixture = await projectFixture();
  const settings = await f.app.projectWork.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, delivery: 'pull-request', prAutoFix: { checks: false, conflicts: false, comments: false, maxRounds: 3 } }, settings.revision);
  f.fake.enqueueTurn(commitStep({ 'card.txt': 'Fixture card\n' }, { status: 'done', summary: 'Ready for review.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1',
    clientRequestId: 'request_card_actions', title: 'Card task', task: 'Prepare the fixture card.' });
  await f.waitFor(() => f.thread(made.threadId), thread => thread.state === 'in-review');
  f.app.projectWork.store.update(made.threadId, thread => ({ ...thread, baseBranch: 'release-fixture' }));
  f.github.setChecks(1, 'pending'); await f.app.projectWork.pulse();
  const route = `/api/projects/project/threads/${made.threadId}/actions-view`, response = await f.request(route);
  expect(response.status).toBe(200);
  const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-thread-actions-view-v1', projectId: 'project', threadId: made.threadId,
    mergeConfirmation: { body: "Card task will be squashed into release-fixture. The thread's worktree is removed afterwards." } });
  expect(view.items.find((item: { id: string }) => item.id === 'merge')).toMatchObject({ enabled: true });
  f.github.setChecks(1, 'failing'); await f.app.projectWork.pulse();
  const failing = await (await f.request(route)).json();
  expect(failing.items.find((item: { id: string }) => item.id === 'merge')).toMatchObject({ enabled: false,
    refusal: 'Checks are failing. Ask the thread to fix them first.' });
});

test('a branch-only entry with a recorded empty reason remains visible for legacy parity', () => {
  const entry = { threadId: 'branch', title: 'Branch', branch: 'work', reason: '' };
  expect(openPullRequests([entry])).toEqual([entry]);
});


test('card models preserve state words, outcomes, placement, task operations and action eligibility', () => {
  const pr = { number: 42, url: 'https://github.com/fixture/repo/pull/42', state: 'open' as const, headSha: 'a'.repeat(40), checks: 'pending' as const, mergeable: 'clean' as const, updatedAt: at(0) };
  const options = { deviceName: () => 'Workstation', runtimeName: () => 'Claude Code', baseBranch: 'release' };
  const ready = makeThread('thread_card', 'Card', { state: 'in-review', delivery: 'pull-request', pr, fixable: { checks: true, conflicts: true, comments: 2, publish: false } });
  const card = threadCardView(ready, options);
  expect(card).toMatchObject({ label: 'Ready for review', stateLabel: 'In review', meta: 'opus-5.5 · high · main · Workstation',
    placementLine: 'Claude Code · opus-5.5 · high effort · main · Worktree · Workstation', pr: { checks: { text: 'Checks pending', tone: 'muted' } } });
  expect(card.threadActions!.items.map(item => item.id)).toEqual(['fix-checks', 'resolve-conflicts', 'address-comments', 'land-instead', 'merge', 'open-pr']);
  expect(card.threadActions!.items.find(item => item.id === 'merge')!.enabled).toBe(true);
  for (const state of ['queued', 'preparing', 'running', 'publishing', 'attached'] as const) {
    const view = threadActionView({ ...ready, state }, false, 'release');
    expect(view.items.find(item => item.id === 'merge')!.enabled, state).toBe(false);
    expect(view.items.some(item => item.id === 'fix-checks'), state).toBe(false);
  }
  const conflicted = { ...ready, pr: { ...pr, checks: 'failing' as const, mergeable: 'conflict' as const } };
  expect(threadActionView(conflicted, false, 'release').items.find(item => item.id === 'merge')!.refusal).toBe('This pull request has conflicts. Ask the thread to resolve them first.');
  expect(threadActionView(conflicted, true, 'release').items.find(item => item.id === 'merge')!.refusal).toBe('Merges are held while the nightly window runs.');
  const saved = makeThread('thread_saved', 'Saved', { state: 'idle', fixable: { checks: false, conflicts: false, comments: 0, publish: true } });
  expect(threadActionView(saved, false, 'main').items.find(item => item.id === 'resolve')).toMatchObject({ confirmation: { body: 'This thread has commits that are not in a pull request. Resolve it anyway? The branch and worktree stay.' } });
  const resolved = threadCardView({ ...saved, resolution: { by: 'owner', at: at(0) } }, options);
  expect(resolved).toMatchObject({ label: 'Resolved', stateLabel: 'Resolved' });
  expect(resolved.threadActions!.items.some(item => item.id === 'reopen')).toBe(true);
  expect(threadCardView({ ...ready, state: 'attached' }, options).chips).toContainEqual({ text: 'In a terminal', tone: 'plain' });
  const merged = threadCardView({ ...ready, state: 'done', pr: { ...pr, state: 'merged' } }, options);
  expect(merged).toMatchObject({ outcome: 'Merged #42', mergedOutcome: 'Merged #42', headerBadges: [{ text: 'Merged', tone: 'ok' }] });
  const draft = taskCardView(makeTask('task_draft', 'Draft', { state: 'draft' }));
  expect(draft).toMatchObject({ label: 'Proposed', taskStart: { body: { action: 'approve', expectedRevision: 1 } }, taskDismiss: { body: { action: 'reject', reason: 'Dismissed from the chat.' } } });
  expect(taskCardView(makeTask('task_held', 'Held', { held: true }), 2)).toMatchObject({ label: 'Held', meta: '#2 in queue', taskStart: { body: { held: false, expectedRevision: 1 } }, taskDismiss: null });
  expect(taskCardView(makeTask('task_done', 'Done', { state: 'done' }))).toMatchObject({ meta: null, taskStart: null, taskDismiss: null });
});

test('task card start and dismiss require an unlinked task even when its thread index is absent',()=>{
 for(const state of ['draft','queued']as const){const linked=makeTask('task_linked','Linked fixture',{state,held:true,threadId:'thread_missing'}),model=taskCardView(linked);expect(model.taskStart).toBeNull();expect(model.taskDismiss).toBeNull();}
 expect(taskCardView(makeTask('task_unlinked','Unlinked fixture',{state:'draft',held:true}))).toMatchObject({taskStart:{body:{action:'approve'}},taskDismiss:{body:{action:'reject',reason:'Dismissed from the chat.'}}});
});
