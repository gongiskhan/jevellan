import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as core from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { commitStep, projectFixture, reportStep, type ProjectFixture, type ProjectFixtureOptions } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
async function setup(options: ProjectFixtureOptions = {}) {
  const fixture = f = await projectFixture(options), settings = await fixture.app.projectWork.admission.settings(fixture.project.id);
  await fixture.app.projectHub.putSettings({ ...settings, prAutoFix: { checks: false, conflicts: false, comments: false, maxRounds: 3 } }, settings.revision);
  return fixture;
}
async function start(f: ProjectFixture, title = 'Overview task') {
  return f.json('/api/projects/project/threads', core.ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task: title });
}
const action = (f: ProjectFixture, id: string, action: string, clientRequestId = `req_${randomUUID()}`) => f.request(`/api/projects/project/threads/${id}/actions`, 'POST', { schema: 'thread-action-request-v1', clientRequestId, action });
test('Overview groups use the first matching rule for every state and landing value', () => {
  const group = (core as unknown as { boardGroup(t: object): string }).boardGroup;
  for (const state of ['done', 'stopped']) expect(group({ state })).toBe('resolved');
  for (const state of ['failed', 'waiting-for-you']) expect(group({ state })).toBe('waiting');
  for (const state of ['queued', 'preparing', 'running', 'publishing', 'attached']) expect(group({ state })).toBe('working');
  expect(group({ state: 'idle' })).toBe('idle'); expect(group({ state: 'in-review' })).toBe('review');
  for (const landing of ['verifying', 'merging', 'held']) expect(group({ state: 'in-review', landing })).toBe('landing');
  expect(group({ state: 'failed', resolution: { by: 'owner', at: '2026-10-17T00:00:00Z' } })).toBe('resolved');
});
test('Resolve withdraws only open thread questions, preserves files, repeats safely and Reopen clears it', async () => {
  const f = await setup(); f.fake.enqueueTurn(reportStep({ status: 'needs-decision', summary: 'Choose a colour.', question: 'Colour?', options: [{ label: 'Blue' }, { label: 'Red' }] }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'waiting-for-you'); await f.app.projectWork.pulse();
  const id = await f.app.projectWork.decisions.ask('project', { question: 'Colour?', options: [{ label: 'Blue' }], threadId }, 'thread');
  const other = await f.app.projectWork.decisions.ask('project', { question: 'Project question?', options: [] }, 'coordinator');
  const bodyId = `req_${randomUUID()}`; const result = await action(f, threadId, 'resolve', bodyId); expect(result.status).toBe(200);
  expect(core.ThreadViewSchema.parse(await result.json()).thread.resolution).toMatchObject({ by: 'owner' });
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', stateReason: 'Resolved by you.' }); expect(existsSync(f.thread(threadId).cwd)).toBe(true);
  expect((await f.app.projectHub.decision(id))?.document.withdrawnAt).toBeTruthy(); expect((await f.app.projectHub.decision(other))?.document.withdrawnAt).toBeUndefined();
  expect((await f.app.projectWork.threads.list('project', 'active')).some(row => row.id === threadId)).toBe(false);
  expect((await f.app.projectWork.threads.list('project', 'all')).some(row => row.id === threadId)).toBe(true);
  expect((await action(f, threadId, 'resolve', bodyId)).status).toBe(200);
  expect((await action(f, threadId, 'reopen')).status).toBe(200); expect(f.thread(threadId).resolution).toBeUndefined();
  await action(f, threadId, 'resolve'); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued.' }), forThread());
  await f.app.projectWork.threads.message('project', threadId, 'coordinator', 'Continue.', false, 'msg_reopen');
  await f.waitFor(() => f.thread(threadId), t => t.turns === 2); expect(f.thread(threadId).resolution).toBeUndefined();
});
test('Publish reuses managed verification and publication without another agent turn; actions refuse invalid states', async () => {
  const f = await setup(); f.fake.enqueueTurn(commitStep({ 'publish.txt': 'ready\n' }, { status: 'progress', summary: 'Saved for publishing.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle'); await f.app.projectWork.pulse();
  expect((await f.index(threadId))?.fixable?.publish).toBe(true);
  const requestId = `req_${randomUUID()}`; expect((await action(f, threadId, 'publish', requestId)).status).toBe(200);
  await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review'); expect(f.fake.turnStarts).toHaveLength(1);
  expect((await action(f, threadId, 'publish', requestId)).status).toBe(200);
  for (const [name, message] of [['publish', 'This thread already has an open pull request.'], ['fix-checks', 'This pull request has no failing checks.'], ['resolve-conflicts', 'This pull request has no conflicts.'], ['address-comments', 'There are no new review comments.']]) {
    const response = await action(f, threadId, name!); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ message });
  }
  expect((await action(f, threadId, 'resolve')).status).toBe(409);
  expect(f.github.requests.filter(r => r.method === 'POST' && r.path.endsWith('/pulls'))).toHaveLength(1);
});
test('Automatic resolution uses seven days of index activity, keeps open PRs, and publishes new index event ids', async () => {
  const f = await setup(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Resting.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle'); await f.app.projectWork.pulse();
  const index = (await f.index(threadId))!;
  const threads = f.app.projectWork.threads as unknown as { autoResolve(now?: number): Promise<void> };
  await threads.autoResolve(Date.parse(index.updatedAt) + 7 * 86_400_000 - 1); expect(f.thread(threadId).resolution).toBeUndefined();
  await threads.autoResolve(Date.parse(index.updatedAt) + 7 * 86_400_000); expect(f.thread(threadId).resolution).toMatchObject({ by: 'inactivity' });
  await f.app.projectWork.pulse(); expect((await f.index(threadId))?.resolution).toMatchObject({ by: 'inactivity' });
  expect(f.coordinatorState().queue).toContainEqual(expect.objectContaining({ kind: 'thread-resolved', threadId, by: 'inactivity' }));
});

test('Owner check, conflict and comment actions run the right prompt once and update the existing PR', { timeout: 120_000 }, async () => {
  let now = Date.now(); const f = await setup({ projectTimers: { now: () => now } });
  f.fake.enqueueTurn(commitStep({ 'fix.txt': 'before\n' }, { status: 'done', summary: 'Initial change.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review');
  f.github.setChecks(1, 'failing'); await f.app.projectWork.pulse();
  f.fake.enqueueTurn(commitStep({ 'fix.txt': 'after\n' }, { status: 'done', summary: 'Fixed checks.' }), forThread());
  const id = `req_${randomUUID()}`; const responses = await Promise.all([action(f, threadId, 'fix-checks', id), action(f, threadId, 'fix-checks', id)]); expect(responses.map(r => r.status)).toEqual([200, 200]);
  await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review' && t.turns === 2); expect(f.fake.turnStarts[1]!.prompt).toContain('Read the failing jobs and their logs');
  f.github.setChecks(1, 'passing'); f.github.setMergeable(1, 'dirty'); await f.app.projectWork.pulse();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Conflict inspected.' }), forThread());
  expect((await action(f, threadId, 'resolve-conflicts')).status).toBe(200); await f.waitFor(() => f.thread(threadId), t => t.turns === 3);
  expect(f.fake.turnStarts[2]!.prompt).toContain('merge origin/main into this branch (do not rebase)');
  now += 61_000;
  const pull = f.github.pulls[0]!; pull.issueComments = [{ id: 99, user: { login: 'fixture-bot' }, body: 'Rename the helper.', created_at: new Date(now).toISOString() }]; pull.updatedAt = new Date(now).toISOString();
  await f.app.projectWork.pulse(); expect((await f.index(threadId))?.fixable?.comments).toBe(1);
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Comment addressed.' }), forThread());
  expect((await action(f, threadId, 'address-comments')).status).toBe(200); await f.waitFor(() => f.thread(threadId), t => t.turns === 4);
  expect(f.fake.turnStarts[3]!.prompt).toContain('fixture-bot: Rename the helper.');
  await f.app.projectWork.pulse(); expect((await f.index(threadId))?.fixable?.comments).toBe(0);
  expect((await action(f, threadId, 'address-comments')).status).toBe(409);
});
test('A comment arriving within the request cache window is still discovered after that window', async () => {
  let now = Date.now(); const f = await setup({ projectTimers: { now: () => now } });
  f.fake.enqueueTurn(commitStep({ 'note.txt': 'ready\n' }, { status: 'done', summary: 'Ready.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review'); await f.app.projectWork.pulse();
  now += 1000; const pull = f.github.pulls[0]!; pull.issueComments = [{ id: 100, user: { login: 'owner' }, body: 'Add the example.', created_at: new Date(now).toISOString() }]; pull.updatedAt = new Date(now).toISOString();
  await f.app.projectWork.pulse(); now += 61_000; await f.app.projectWork.pulse();
  expect((await f.index(threadId))?.fixable?.comments).toBe(1);
});

test('An accepted Publish repeats after restart even when its HTTP receipt was not marked applied', async () => {
  const f = await setup(); f.fake.enqueueTurn(commitStep({ 'saved.txt': 'ready\n' }, { status: 'progress', summary: 'Ready to publish.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle');
  const id = `req_${randomUUID()}`; expect((await action(f, threadId, 'publish', id)).status).toBe(200);
  await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review');
  const path = join(f.homes.root, 'projects', 'project', 'threads', threadId, 'actions', `${id}.json`);
  const receipt = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify({ ...receipt, applied: false }));
  await f.restart(); expect((await action(f, threadId, 'publish', id)).status).toBe(200);
  expect(f.github.requests.filter(row => row.method === 'POST' && row.path.endsWith('/pulls'))).toHaveLength(1);
});

test('A review-comment read failure does not suppress the checks-failed event', async () => {
  const f = await setup(); f.fake.enqueueTurn(commitStep({ 'ready.txt': 'ready\n' }, { status: 'done', summary: 'Ready.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review');
  f.github.setChecks(1, 'failing'); f.github.failNext('GET', /^\/repos\/fixture\/repo\/pulls\/1\/reviews$/,  500, 'Unavailable');
  await f.app.projectWork.pulse(); expect(f.coordinatorState().queue).toContainEqual(expect.objectContaining({ kind: 'pr-update', threadId, change: 'checks-failed' }));
});

test('Working and attached actions are refused, and resolving cannot reuse another action id', async () => {
  const f = await setup(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Resting.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle');
  let response = await action(f, threadId, 'publish'); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ message: 'This thread has no commits to publish.' });
  f.app.projectWork.store.update(threadId, t => ({ ...t, state: 'running' })); response = await action(f, threadId, 'resolve'); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ message: 'The thread is working. Wait for the turn to end or stop it.' });
  f.app.projectWork.store.update(threadId, t => ({ ...t, state: 'attached' })); response = await action(f, threadId, 'resolve'); expect(response.status).toBe(409); expect((await response.json()).message).toContain(`jevellan thread detach ${threadId}`);
  f.app.projectWork.store.update(threadId, t => ({ ...t, state: 'idle' })); const id = `req_${randomUUID()}`; expect((await action(f, threadId, 'resolve', id)).status).toBe(200); expect((await action(f, threadId, 'reopen', id)).status).toBe(409);
});

test('A nightly hold badge clears through the normal thread sweep when the window releases it', async () => {
  const f = await setup(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Resting.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle');
  let held = true; f.app.projectWork.daily.mergesHeld = async () => held; f.app.projectWork.daily.allowedMergeThreads = async () => [];
  await expect(f.app.projectWork.daily.assertMerge('project', threadId)).rejects.toThrow('Merges are held while the nightly window runs.');
  expect(f.app.projectWork.store.local(threadId).landing).toBe('held');
  held = false; await f.app.projectWork.threads.sweep(); expect(f.app.projectWork.store.local(threadId).landing).toBeUndefined();
});

test('Review comments beyond five hundred remain available and owner delivery advances the cursor', async () => {
  let now = Date.now(); const f = await setup({ projectTimers: { now: () => now } });
  f.fake.enqueueTurn(commitStep({ 'ready.txt': 'ready\n' }, { status: 'done', summary: 'Ready.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review');
  const firstAt = Date.now() + 1000, pull = f.github.pulls[0]!;
  pull.issueComments = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, user: { login: 'owner' }, body: `Review point ${i + 1}.`, created_at: new Date(firstAt + i).toISOString() })); pull.updatedAt = new Date(firstAt + 501).toISOString(); now = firstAt + 2000;
  await f.app.projectWork.pulse(); expect((await f.index(threadId))?.fixable?.comments).toBe(501);
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'First fifteen comments addressed.' }), forThread());
  expect((await action(f, threadId, 'address-comments')).status).toBe(200); await f.waitFor(() => f.thread(threadId), t => t.turns === 2);
  expect(f.local(threadId).prComments?.since).toBe(pull.issueComments[14]!.created_at);
  now += 61_000; pull.issueComments.push({ id: 502, user: { login: 'owner' }, body: 'One more point.', created_at: new Date(now).toISOString() }); pull.updatedAt = new Date(now).toISOString();
  await f.app.projectWork.pulse(); expect((await f.index(threadId))?.fixable?.comments).toBe(487);
});

test('An owner fix action continues a stopped thread with its open PR in the same thread', async () => {
  const f = await setup(); f.fake.enqueueTurn(commitStep({ 'ready.txt': 'ready\n' }, { status: 'done', summary: 'Ready.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review');
  f.github.setChecks(1, 'failing'); await f.app.projectWork.pulse(); await f.app.projectWork.threads.stop('project', threadId, 'Stopped by you.', false);
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Checks inspected.' }), forThread());
  expect((await action(f, threadId, 'fix-checks')).status).toBe(200);
  await f.waitFor(() => f.thread(threadId), t => t.turns === 2, 3000);
  expect(f.thread(threadId).pr?.number).toBe(1); expect(f.thread(threadId).state).toBe('idle');
});

test('An idle thread with an open PR is never resolved by inactivity', async () => {
  const f = await setup(); f.fake.enqueueTurn(commitStep({ 'ready.txt': 'ready\n' }, { status: 'done', summary: 'Ready.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'in-review');
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Waiting for the pull request.' }), forThread());
  await f.app.projectWork.threads.message('project', threadId, 'coordinator', 'Inspect the status.', false, 'msg_inspect_pr');
  await f.waitFor(() => f.thread(threadId), t => t.state === 'idle' && t.turns === 2); await f.app.projectWork.pulse();
  await f.app.projectWork.threads.autoResolve(Date.parse((await f.index(threadId))!.updatedAt) + 8 * 86_400_000);
  expect(f.thread(threadId).resolution).toBeUndefined(); expect((await action(f, threadId, 'resolve')).status).toBe(409);
});

test('The thread view reports the current nightly merge hold before an owner attempts to merge', async () => {
  const f = await setup(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Resting.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle');
  f.app.projectWork.daily.mergesHeld = async () => true; f.app.projectWork.daily.allowedMergeThreads = async () => [];
  const view = await f.json(`/api/projects/project/threads/${threadId}`, core.ThreadViewSchema);
  expect((view as typeof view & { mergesHeld?: boolean }).mergesHeld).toBe(true);
});

test('A missing hub hold read does not hide the local thread transcript and reports', async () => {
  const f = await setup(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Local report remains available.' }), forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle');
  f.app.projectWork.daily.mergesHeld = async () => { throw new core.HubUnavailable('The hub is offline.'); };
  const response = await f.request(`/api/projects/project/threads/${threadId}`); expect(response.status).toBe(200);
  expect(core.ThreadViewSchema.parse(await response.json()).reports[0]?.summary).toBe('Local report remains available.');
});
