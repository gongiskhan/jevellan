// Phase 1 acceptance (brief 13 PJ1-PJ1d, design 5.2.1-5.2.4, 5.2.11): owner threads on a booted daemon, simulated runtime
// turns through the real bridge, live git on a bare origin behind a GitHub-shaped remote, and the fake GitHub server.
import { afterEach, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountSchema, DeviceSchema, MergeResultViewSchema, ProjectWorkSettingsSchema, ProjectWorkViewSchema, ThreadCreatedViewSchema, ThreadViewSchema, defaultProjectWorkSettings,
  type CoordinatorEvent,
  type ProjectWorkSettings, type ProjectLedgerData, type ProjectLedgerEvent, type ProjectLedgerEventType,
} from '../packages/core/dist/index.js';
import { forThread, groupAlive, processIdentity, type FakeTurnStep } from '../packages/runtime-contract/dist/index.js';
import { eventLine } from '../packages/projects/dist/index.js';
import { commitStep, expectNoLeaks, holdStep, never, projectFixture, reportStep, type ProjectFixture, type ProjectFixtureOptions } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
async function setup(options: ProjectFixtureOptions = {}): Promise<ProjectFixture> { fixture = await projectFixture(options); return fixture; }

const createBody = (title: string, task: string, clientRequestId = `req_${randomUUID()}`, extra: object = {}) => ({ schema: 'thread-create-request-v1', clientRequestId, title, task, ...extra });
const empty = { schema: 'empty-request-v1' };
const queue = (f: ProjectFixture): CoordinatorEvent[] => f.coordinatorState().queue;
const kinds = (events: CoordinatorEvent[]) => events.map((event) => event.kind === 'thread-report' ? `report:${event.report.status}` : event.kind === 'pr-update' ? `pr:${event.change}` : event.kind);
function payloads<T extends ProjectLedgerEventType>(f: ProjectFixture, threadId: string, type: T): ProjectLedgerData<T>[] {
  const ledger = f.app.projectWork.ledgers.thread(f.project.id, threadId);
  return ledger.events().filter((event) => event.type === type).map((event) => ledger.payload(event as ProjectLedgerEvent & { type: T }));
}
/** The owner checkout's observable git state: status, HEAD, main, origin/main and an index digest. */
function checkoutState(f: ProjectFixture) {
  return { status: f.git(f.checkout, 'status', '--porcelain=v1'), head: f.git(f.checkout, 'rev-parse', 'HEAD'), main: f.git(f.checkout, 'rev-parse', 'refs/heads/main'),
    tracking: f.git(f.checkout, 'rev-parse', 'refs/remotes/origin/main'), index: createHash('sha256').update(f.git(f.checkout, 'ls-files', '--stage', '-z')).digest('hex') };
}
/** Pushes one more commit to origin main from a second clone, so origin is ahead of the checkout's `origin/main`. */
function advanceOrigin(f: ProjectFixture): string {
  const second = join(f.root, 'second'); f.git(f.root, 'clone', f.origin, second);
  writeFileSync(join(second, 'upstream.txt'), 'upstream\n'); f.git(second, 'add', '-A'); f.git(second, 'commit', '-m', 'Upstream'); f.git(second, 'push', 'origin', 'main');
  return f.git(second, 'rev-parse', 'HEAD');
}
const fails = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
const kill = (pid: number) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };
async function start(f: ProjectFixture, title: string, task: string, extra: object = {}) {
  return f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', createBody(title, task, undefined, extra));
}
async function settings(f: ProjectFixture, over: Partial<ProjectWorkSettings>): Promise<void> {
  const current = await f.app.projectHub.settings('project');
  await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...(current?.document ?? defaultProjectWorkSettings('project')), ...over }), current?.revision ?? 0);
}

test('PJ1 owner thread runs in a worktree, opens a pull request, follows checks and cleans up after merge', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: 'test -f greeting.txt' });
  const upstream = advanceOrigin(f);
  const before = checkoutState(f);
  expect(before.tracking).not.toBe(upstream);
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt with a test.',
    testsRun: { command: 'test -f greeting.txt', passed: true, summary: 'ok' }, changedFiles: ['greeting.txt'] }), forThread());

  // 1-2. The start answers at once and repeats by request id; the same id with other content is refused.
  const body = createBody('Add greeting', 'Create greeting.txt.', 'req_pj1');
  const response = await f.request('/api/projects/project/threads', 'POST', body);
  expect(response.status).toBe(201);
  const created = ThreadCreatedViewSchema.parse(await response.json());
  expect(created.state).toBe('preparing');
  const threadId = created.threadId;
  expect(ThreadCreatedViewSchema.parse(await (await f.request('/api/projects/project/threads', 'POST', body)).json()).threadId).toBe(threadId);
  const reused = await f.request('/api/projects/project/threads', 'POST', { ...body, title: 'Another title' });
  expect(reused.status).toBe(409);
  expect(await reused.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: 'This request id was already used for a different thread.' });

  // 3. The hub index reaches in-review.
  await f.app.projectWork.idle('project'); await f.app.projectWork.pulse();
  const index = await f.waitFor(() => f.index(threadId), (value) => value?.state === 'in-review');
  const thread = f.thread(threadId);

  // 4. The first turn: thread owner, write permissions, thread profile, the task prompt and the system append.
  expect(f.fake.turnStarts).toHaveLength(1);
  const first = f.fake.turnStarts[0]!;
  expect(first).toMatchObject({ owner: { kind: 'thread', projectId: 'project', id: threadId }, turn: 1, permissions: 'write', safetyProfile: 'thread',
    prompt: 'Task: Add greeting\n\nCreate greeting.txt.', cwd: f.homes.at('worktrees', 'project', threadId) });
  expect(first.resume).toBeUndefined();
  expect(first.systemAppend).toContain('Isolation: your own git worktree on branch jv/add-greeting-');
  expect(first.systemAppend).toContain(', based on main.');
  expect(first.systemAppend).toContain('Jevellan runs test -f greeting.txt, pushes and opens the pull request.');
  expect(first.launch.env.GIT_AUTHOR_NAME).toBe('Fixture');

  // 5. Branch and worktree outside the checkout.
  expect(thread.branch).toMatch(/^jv\/add-greeting-[0-9a-z]{6}$/);
  expect(index!.branch).toBe(thread.branch);
  expect(thread.cwd).toBe(f.homes.at('worktrees', 'project', threadId));
  expect(f.git(f.checkout, 'worktree', 'list', '--porcelain')).toContain(`worktree ${thread.cwd}`);
  expect(thread.cwd.startsWith(`${f.checkout}/`)).toBe(false);
  // The private base fetch read the advanced origin.
  expect(thread.baseCommit).toBe(upstream);

  // 6. The branch is on the bare origin at the pull request head.
  expect(f.git(f.root, '--git-dir', f.origin, 'rev-parse', `refs/heads/${thread.branch}`)).toBe(thread.pr!.headSha);

  // 7. Exactly one pull request creation with the brief 9.7 body; every request carries the API headers and the token.
  const creations = f.github.requests.filter((entry) => entry.method === 'POST' && entry.path === '/repos/fixture/repo/pulls');
  expect(creations).toHaveLength(1);
  expect(creations[0]!.body).toEqual({ title: 'Add greeting', head: thread.branch, base: 'main',
    body: `Added greeting.txt with a test.\n\nTests: Passed: test -f greeting.txt\n\nThread: Add greeting\nPlacement: Scripted test runtime Fixture, high effort, ${f.deviceName}` });
  expect(f.github.requests.length).toBeGreaterThan(1);
  for (const entry of f.github.requests) expect(entry.headers).toMatchObject({ accept: 'application/vnd.github+json', apiVersion: '2022-11-28', authorized: true });

  // 8. Verification passed and the pull request opened, in the thread ledger.
  expect(payloads(f, threadId, 'thread-verification')).toEqual([expect.objectContaining({ status: 'passed', command: 'test -f greeting.txt', attempt: 1 })]);
  expect(payloads(f, threadId, 'thread-publication')).toContainEqual(expect.objectContaining({ result: 'pr-opened', prNumber: 1 }));

  // 9. The coordinator queue (no coordinator runs in this fixture): the owner start line, then the publication.
  expect(kinds(queue(f))).toEqual(['thread-user-message', 'thread-published']);
  expect(queue(f)[0]).toMatchObject({ threadId, text: `[owner started thread "Add greeting" (${threadId})] Create greeting.txt.` });
  expect(queue(f)[1]).toMatchObject({ threadId, result: 'pr-opened', prNumber: 1 });

  // 10. Failing checks are reported once per head.
  f.github.setChecks(1, 'failing'); await f.app.projectWork.pulse();
  expect((await f.index(threadId))!.pr!.checks).toBe('failing');
  expect(kinds(queue(f))).toEqual(['thread-user-message', 'thread-published', 'pr:checks-failed']);
  await f.app.projectWork.pulse();
  expect(queue(f)).toHaveLength(3);

  // 11. A success run while the combined status still reads pending with no statuses: passing.
  f.github.setChecks(1, 'passing'); await f.app.projectWork.pulse();
  expect((await f.index(threadId))!.pr!.checks).toBe('passing');
  expect(kinds(queue(f)).at(-1)).toBe('pr:checks-passed');

  // 12. Merged on GitHub: done, cleanup, the remote branch stays.
  f.github.markMerged(1); await f.app.projectWork.pulse(); await f.app.projectWork.idle('project'); await f.app.projectWork.pulse();
  const done = await f.index(threadId);
  expect(done).toMatchObject({ state: 'done', pr: { state: 'merged' } }); expect(done!.endedAt).toBeDefined();
  expect(queue(f).at(-1)).toMatchObject({ kind: 'pr-update', change: 'merged', threadId, prNumber: 1 });
  expect(existsSync(thread.cwd)).toBe(false);
  expect(f.git(f.checkout, 'worktree', 'list', '--porcelain')).not.toContain(thread.cwd);
  expect(fails(() => f.git(f.checkout, 'rev-parse', '--verify', `refs/heads/${thread.branch}`))).toBe(true);
  expect(f.git(f.checkout, 'for-each-ref', `refs/jevellan/threads/${threadId}`)).toBe('');
  expect(f.git(f.root, '--git-dir', f.origin, 'rev-parse', `refs/heads/${thread.branch}`)).toBe(thread.pr!.headSha);

  // 13. The owner checkout is untouched: the private base fetch did not move origin/main and nothing touched the index.
  expect(checkoutState(f)).toEqual(before);

  // 14. No native session id and no worktree path leave the owner device's private files.
  const sessionId = f.fake.runs[0]!.native.sessionId!;
  expect(f.thread(threadId).nativeSessionId).toBe(sessionId);
  const viewText = await (await f.request(`/api/projects/project/threads/${threadId}`)).text();
  const view = ThreadViewSchema.parse(JSON.parse(viewText));
  expect(view.transcript).not.toBeNull(); expect(view.transcript!.session.cwd).toBeNull();
  const hubText = JSON.stringify((await f.app.projectHub.threads('project')).records);
  for (const text of [viewText, hubText, f.ledgerText(), f.ledgerText(threadId)]) { expect(text).not.toContain(sessionId); expect(text).not.toContain(thread.cwd); }
});

test('PJ1 merge from the API squashes the reviewed head', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: 'test -f greeting.txt' });
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }), forThread());
  const { threadId } = ThreadCreatedViewSchema.parse(await (await f.request('/api/projects/project/threads', 'POST', createBody('Add greeting', 'Create greeting.txt.'))).json());
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'in-review');
  const route = `/api/projects/project/threads/${threadId}/pr/merge`;
  // A conflict refuses with the UI reason.
  f.github.setMergeable(1, 'dirty'); await f.app.projectWork.pulse();
  expect(f.thread(threadId).pr).toMatchObject({ mergeable: 'conflict' });
  expect(kinds(queue(f)).at(-1)).toBe('pr:conflict');
  let refused = await f.request(route, 'POST', empty);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: 'This pull request has conflicts. Ask the thread to resolve them first.' });
  // GitHub's refusal is shown as it came.
  f.github.setMergeable(1, 'clean'); await f.app.projectWork.pulse();
  f.github.failNext('PUT', /\/merge$/, 405, 'Pull Request is not mergeable');
  refused = await f.request(route, 'POST', empty);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: 'Pull Request is not mergeable' });
  expect(f.thread(threadId).state).toBe('in-review');
  // The squash merge of the reviewed head concludes without a poll.
  const headSha = f.thread(threadId).pr!.headSha;
  const merged = await f.request(route, 'POST', empty);
  expect(merged.status).toBe(200);
  expect(MergeResultViewSchema.parse(await merged.json())).toMatchObject({ merged: true });
  const puts = f.github.requests.filter((entry) => entry.method === 'PUT' && entry.path === '/repos/fixture/repo/pulls/1/merge');
  expect(puts.at(-1)!.body).toEqual({ merge_method: 'squash', sha: headSha });
  const polls = f.github.requests.length;
  await f.app.projectWork.idle('project');
  expect(f.thread(threadId)).toMatchObject({ state: 'done', pr: { state: 'merged' } });
  expect(f.github.requests.slice(polls).filter((entry) => entry.method === 'GET' && entry.path === '/repos/fixture/repo/pulls/1')).toEqual([]);
  expect(kinds(queue(f)).at(-1)).toBe('pr:merged');
});

test.each([
  { name: 'no token', options: { githubToken: false }, reason: 'Branch pushed. Add a GitHub token in Settings → Git to open pull requests.', pushed: true },
  { name: 'not GitHub', options: { github: false }, reason: 'The remote is not on GitHub.', pushed: true },
  { name: 'no remote', options: { remote: false }, reason: 'This project has no remote; the branch stays local.', pushed: false },
])('PJ1 publication without a token or a GitHub remote leaves the branch pushed with the documented reason ($name)', { timeout: 120_000 }, async ({ options, reason, pushed }) => {
  const f = await setup({ ...options, testCommand: 'test -f greeting.txt' });
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }), forThread());
  const { threadId } = await start(f, 'Add greeting', 'Create greeting.txt.');
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'idle');
  await f.app.projectWork.idle('project');
  const thread = f.thread(threadId);
  expect(thread).toMatchObject({ state: 'idle', stateReason: reason, lastReport: { status: 'done', synthesized: false } });
  expect(thread.pr).toBeUndefined();
  expect(f.github.requests).toEqual([]);
  expect(fails(() => f.git(f.root, '--git-dir', f.origin, 'rev-parse', '--verify', `refs/heads/${thread.branch}`))).toBe(!pushed);
  expect(f.git(f.checkout, 'rev-parse', '--verify', `refs/heads/${thread.branch}`)).toMatch(/^[0-9a-f]{40}$/);
  // The coordinator hears why no pull request opened; nothing was published.
  expect(kinds(queue(f))).toEqual(['thread-user-message', 'report:blocked']);
  expect(queue(f)[1]).toMatchObject({ threadId, report: { status: 'blocked', synthesized: true, summary: reason } });
  // A pushed branch is listed with its reason among the pull requests.
  const work = await f.json('/api/projects/project/work', ProjectWorkViewSchema);
  expect(work.pullRequests).toEqual(pushed ? [{ threadId, title: 'Add greeting', branch: thread.branch, reason }] : []);
});

test('PJ1 done without commits concludes without changes', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: 'test -f greeting.txt' });
  f.fake.enqueueTurn(reportStep({ status: 'done', summary: 'Nothing needed changing.' }), forThread());
  const { threadId } = await start(f, 'Check greeting', 'See whether greeting.txt is needed.');
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'done');
  await f.app.projectWork.idle('project');
  const thread = f.thread(threadId);
  expect(thread).toMatchObject({ state: 'done', stateReason: 'Concluded without changes.' }); expect(thread.endedAt).toBeDefined();
  expect(existsSync(thread.cwd)).toBe(false);
  expect(fails(() => f.git(f.checkout, 'rev-parse', '--verify', `refs/heads/${thread.branch}`))).toBe(true);
  expect(payloads(f, threadId, 'thread-verification')).toEqual([]);
  expect(queue(f).at(-1)).toMatchObject({ kind: 'thread-published', threadId, result: 'no-changes' });
  expect(f.github.requests).toEqual([]);
});

const VERIFY = 'cat value.txt; test "$(cat value.txt)" = 3';

test('PJ1b verification failure prompts are exact and the three-attempt limit holds', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: VERIFY });
  for (const value of ['1', '2', '3']) f.fake.enqueueTurn(commitStep({ 'value.txt': `${value}\n` }, { status: 'done', summary: `Set the value to ${value}.` }), forThread());
  const { threadId } = await start(f, 'Count to three', 'Make value.txt read 3.');
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'in-review');
  await f.app.projectWork.idle('project');
  expect(f.fake.turnStarts.map((input) => input.prompt)).toEqual([
    'Task: Count to three\n\nMake value.txt read 3.',
    'Jevellan ran cat value.txt; test "$(cat value.txt)" = 3 after your report and it failed (attempt 1 of 3). Fix the cause, run the tests, commit, and report done again.\n\nLast output:\n1\n',
    'Jevellan ran cat value.txt; test "$(cat value.txt)" = 3 after your report and it failed (attempt 2 of 3). Fix the cause, run the tests, commit, and report done again.\n\nLast output:\n2\n',
  ]);
  const thread = f.thread(threadId);
  expect(thread).toMatchObject({ state: 'in-review', verificationAttempts: 0, turns: 3, pr: { number: 1 } });
  const session = f.fake.runs[0]!.native.sessionId;
  expect(f.fake.turnStarts.slice(1).map((input) => input.resume?.sessionId)).toEqual([session, session]);
  expect(payloads(f, threadId, 'thread-verification').map((entry) => [entry.attempt, entry.status, entry.tail])).toEqual([[1, 'failed', '1\n'], [2, 'failed', '2\n'], [3, 'passed', '3\n']]);
  expect(kinds(queue(f))).toEqual(['thread-user-message', 'thread-published']);
});

test('PJ1b a third failed verification leaves the thread idle and runs no fourth turn', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: VERIFY });
  for (let n = 0; n < 4; n++) f.fake.enqueueTurn(commitStep({ 'value.txt': '1\n' }, { status: 'done', summary: 'Kept the value.' }), forThread());
  const { threadId } = await start(f, 'Stay at one', 'Keep value.txt at 1.');
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'idle');
  await f.app.projectWork.idle('project'); await f.app.projectWork.pulse(); await f.app.projectWork.idle('project');
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', stateReason: 'Tests failed three times.', turns: 3 });
  expect(f.fake.turnStarts).toHaveLength(3);
  expect(f.fake.turnStarts[2]!.prompt).toContain('(attempt 2 of 3)');
  expect(queue(f).at(-1)).toMatchObject({ kind: 'thread-verification-failed', threadId, attempts: 3, tail: '1\n' });
  expect(f.github.requests).toEqual([]);
  expect(fails(() => f.git(f.root, '--git-dir', f.origin, 'rev-parse', '--verify', `refs/heads/${f.thread(threadId).branch}`))).toBe(true);
});

test('PJ1c turns without a report or with a failure synthesize the report', { timeout: 120_000 }, async () => {
  const f = await setup();
  const run = async (title: string, step: FakeTurnStep) => {
    f.fake.enqueueTurn(step, forThread((input) => input.prompt.startsWith(`Task: ${title}\n`)));
    const { threadId } = await start(f, title, `Work on ${title}.`);
    await f.waitFor(() => f.thread(threadId).state, (state) => state === 'idle');
    await f.app.projectWork.idle('project');
    expect(queue(f).at(-1)).toMatchObject({ kind: 'thread-report', threadId });
    return f.thread(threadId);
  };
  expect((await run('Long text', ({ say }) => { say('x'.repeat(1500)); return { status: 'completed' }; })).lastReport)
    .toEqual({ schema: 'thread-report-v1', turn: 1, status: 'progress', summary: 'x'.repeat(1200), changedFiles: [], synthesized: true });
  expect((await run('Silent', () => ({ status: 'completed' }))).lastReport).toMatchObject({ status: 'progress', synthesized: true, summary: 'The turn ended without a report.' });
  const tools: FakeTurnStep = ({ say, emit }) => {
    say('Looking at the files first.');
    emit({ type: 'tool-start', id: 'tool_1', name: 'Bash', input: { command: 'ls' } }); emit({ type: 'tool-end', id: 'tool_1', ok: true, output: 'value.txt' });
    say('Final words.'); return { status: 'completed' };
  };
  expect((await run('After tools', tools)).lastReport).toMatchObject({ status: 'progress', synthesized: true, summary: 'Final words.' });
  expect((await run('Throws', () => { throw new Error('Scripted crash.'); })).lastReport).toMatchObject({ status: 'blocked', synthesized: true, summary: 'The scripted runtime failed.' });
  const limited = await run('Rate limited', () => ({ status: 'failed', error: { kind: 'rate-limit', message: 'You have hit your limit.' } }));
  expect(limited).toMatchObject({ state: 'idle', lastReport: { status: 'blocked', synthesized: true, summary: 'You have hit your limit.' } });
  expect(Date.parse((await f.app.accounts.status('acc_fixture')).coolingUntil ?? '')).toBeGreaterThan(Date.now());
  // The coordinator reads a synthesized report with the brief's suffix.
  const event = queue(f).find((entry) => entry.kind === 'thread-report')!;
  expect(eventLine(event, { title: () => 'Long text', base: 'main' })).toMatch(/ \(Jevellan wrote this report because the thread did not\.\)$/);
  expect(f.fake.turnStarts).toHaveLength(5);
});

test('PJ1d a restart during a running turn leaves the thread idle and resumes no model', { timeout: 120_000 }, async () => {
  const f = await setup();
  f.fake.enqueueTurn(holdStep(never()), forThread());
  const { threadId } = await start(f, 'Held work', 'Keep working.');
  await f.waitFor(() => f.local(threadId).process, Boolean);
  expect(f.thread(threadId).state).toBe('running');
  const pgid = f.fake.runs.at(-1)!.native.pgid;
  await f.restart();
  await f.app.projectWork.ready; await f.app.projectWork.idle();
  expect(groupAlive(pgid)).toBe(false);
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', stateReason: 'Jevellan restarted during this step.' });
  expect(f.local(threadId).process).toBeUndefined();
  await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect(f.fake.turnStarts).toHaveLength(1);
  expect(queue(f).filter((event) => event.kind === 'thread-interrupted'))
    .toEqual([expect.objectContaining({ threadId, reason: 'restart', message: 'Jevellan restarted during this step.' })]);
  expect(await f.index(threadId)).toMatchObject({ state: 'idle', stateReason: 'Jevellan restarted during this step.' });
  // The browser session survives the restart.
  expect((await f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema)).thread).toMatchObject({ state: 'idle', stateReason: 'Jevellan restarted during this step.' });

  // A crash with a live orphan: recovery kills it and leaves the thread idle.
  const crash = (process: { pid: number; pgid: number; startIdentity?: string }) => () => {
    const thread = f.thread(threadId); const local = f.local(threadId); const dir = f.app.projectWork.paths.thread('project', threadId);
    writeFileSync(join(dir, 'thread.json'), JSON.stringify({ ...thread, state: 'running', stateReason: undefined }));
    writeFileSync(join(dir, 'thread-local.json'), JSON.stringify({ ...local, process: { turn: 2, ...process, startedAt: new Date().toISOString() } }));
  };
  const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); sleeper.unref();
  try {
    const native = processIdentity(sleeper.pid!);
    await f.restart(crash({ pid: native.pid, pgid: native.pgid, startIdentity: native.startIdentity! }));
    expect(groupAlive(native.pgid)).toBe(false);
    expect(f.thread(threadId)).toMatchObject({ state: 'idle', stateReason: 'Jevellan restarted during this step.' });
    expect(f.local(threadId).process).toBeUndefined();
  } finally { kill(sleeper.pid!); }

  // A recorded identity that does not match the live process: it is left alone and the thread fails.
  const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); other.unref();
  try {
    const live = processIdentity(other.pid!);
    await f.restart(crash({ pid: live.pid, pgid: live.pgid, startIdentity: 'Thu Jan  1 00:00:00 1970' }));
    expect(f.thread(threadId)).toMatchObject({ state: 'failed', stateReason: "Jevellan restarted and could not confirm this thread's process stopped." });
    expect(f.local(threadId).process).toBeUndefined();
    expect(groupAlive(live.pgid)).toBe(true);
  } finally { kill(other.pid!); }
  expect(f.fake.turnStarts).toHaveLength(1);
});

test('PJ1d a restart during setup leaves the thread idle, and the next message prepares again and sends the task first', { timeout: 120_000 }, async () => {
  const f = await setup();
  const started = join(f.root, 'setup-runs'); const go = join(f.root, 'setup-go');
  await settings(f, { setupCommand: `echo run >> '${started}'; while [ ! -f '${go}' ]; do sleep 0.1; done` });
  const { threadId } = await start(f, 'Slow setup', 'Use the prepared tools.');
  await f.waitFor(() => existsSync(started));
  expect(f.thread(threadId).state).toBe('preparing');
  await f.restart();
  await f.app.projectWork.idle();
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', stateReason: 'Jevellan restarted during this step.', cwd: '' });
  expect(queue(f).filter((event) => event.kind === 'thread-interrupted')).toEqual([expect.objectContaining({ threadId, reason: 'restart' })]);
  await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect(f.fake.turnStarts).toHaveLength(0);
  // The next message prepares again (the worktree is reused) and its first turn carries the task block.
  writeFileSync(go, '');
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Carried on.' }), forThread());
  expect(await f.app.projectWork.threads.message('project', threadId, 'coordinator', 'Carry on.', false)).toMatchObject({ delivery: 'started' });
  await f.waitFor(() => f.thread(threadId).turns, (turns) => turns === 1);
  await f.app.projectWork.idle('project');
  expect(f.fake.turnStarts).toHaveLength(1);
  expect(f.fake.turnStarts[0]!.prompt).toBe('Task: Slow setup\n\nUse the prepared tools.\n\n---\n\nCarry on.');
  expect(f.fake.turnStarts[0]!.resume).toBeUndefined();
  expect(readFileSync(started, 'utf8')).toBe('run\nrun\n');
  const thread = f.thread(threadId);
  expect(thread).toMatchObject({ state: 'idle', cwd: f.homes.at('worktrees', 'project', threadId), lastReport: { summary: 'Carried on.' } });
  expect(f.git(f.checkout, 'worktree', 'list', '--porcelain').split(`worktree ${thread.cwd}\n`)).toHaveLength(2);
});

test('limits: a full device queues the start; an in-review fix turn waits for a slot and updates its pull request; in-review threads cannot be discarded (D9)', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: 'test -f greeting.txt' });
  await settings(f, { maxRunningPerDevice: 1 });
  const titled = (title: string) => forThread((input) => input.prompt.startsWith(`Task: ${title}\n`));
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }), titled('Reviewed'));
  const reviewed = (await start(f, 'Reviewed', 'Create greeting.txt.')).threadId;
  await f.waitFor(() => f.thread(reviewed).state, (state) => state === 'in-review');
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  f.fake.enqueueTurn(holdStep(held), titled('Busy'));
  const busy = (await start(f, 'Busy', 'Hold the slot.')).threadId;
  await f.waitFor(() => f.thread(busy).state, (state) => state === 'running');
  // The device is at its limit: a new start queues with the device sentence.
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Queued work ran.' }), titled('Queued'));
  const queued = await start(f, 'Queued', 'Wait for a slot.');
  expect(queued.state).toBe('queued');
  expect(f.thread(queued.threadId).stateReason).toBe(`Queued: ${f.deviceName} is at its limit of 1 running threads.`);
  // A fix request for the reviewed thread waits too, and the thread keeps its pull request state.
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello again\n' }, { status: 'done', summary: 'Changed the greeting.' }), forThread((input) => input.prompt === 'Change the greeting.'));
  const receipt = await f.request(`/api/projects/project/threads/${reviewed}/messages`, 'POST', { schema: 'thread-message-request-v1', clientMessageId: 'msg_fix', text: 'Change the greeting.', interrupt: false });
  expect(receipt.status).toBe(202);
  expect(f.thread(reviewed)).toMatchObject({ state: 'in-review', stateReason: `Waiting for a free slot: ${f.deviceName} is at its limit of 1 running threads.`, turns: 1 });
  const discard = await f.request(`/api/projects/project/threads/${reviewed}/discard`, 'POST', empty);
  expect(discard.status).toBe(409);
  expect(await discard.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: 'Only stopped or failed worktree threads can be discarded.' });
  await f.app.projectWork.pulse();
  expect(f.fake.turnStarts).toHaveLength(2);
  // The busy thread finishes its turn: the queued start runs first, then the waiting fix turn.
  release();
  await f.waitFor(() => f.thread(reviewed).turns, (turns) => turns === 2);
  await f.app.projectWork.idle('project'); await f.app.projectWork.pulse(); await f.app.projectWork.idle('project');
  expect(f.fake.turnStarts.map((input) => input.prompt)).toEqual(['Task: Reviewed\n\nCreate greeting.txt.', 'Task: Busy\n\nHold the slot.', 'Task: Queued\n\nWait for a slot.', 'Change the greeting.']);
  expect(f.thread(queued.threadId)).toMatchObject({ state: 'idle', lastReport: { summary: 'Queued work ran.' } });
  const updated = f.thread(reviewed);
  expect(updated).toMatchObject({ state: 'in-review', turns: 2, queuedMessages: [], pr: { number: 1, state: 'open' } }); expect(updated.stateReason).toBeUndefined();
  expect(f.git(f.root, '--git-dir', f.origin, 'rev-parse', `refs/heads/${updated.branch}`)).toBe(updated.pr!.headSha);
  expect(queue(f).filter((event) => event.kind === 'thread-published' && event.threadId === reviewed).map((event) => event.kind === 'thread-published' && event.result)).toEqual(['pr-opened', 'pr-updated']);
  expect(f.github.requests.filter((entry) => entry.method === 'POST' && entry.path === '/repos/fixture/repo/pulls')).toHaveLength(1);
});

test('account pinning: later turns resume on the placed account; an ineligible account moves the thread to a fresh session that starts with the task (D16, D94)', { timeout: 120_000 }, async () => {
  const f = await setup();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'First.' }), forThread());
  const { threadId } = await start(f, 'Pinned', 'Do the pinned work.');
  await f.waitFor(() => f.thread(threadId).turns, (turns) => turns === 1); await f.app.projectWork.idle('project');
  const session = f.thread(threadId).nativeSessionId;
  expect(session).toBeDefined();
  const message = async (text: string) => {
    f.fake.enqueueTurn(reportStep({ status: 'progress', summary: text }), forThread());
    await f.app.projectWork.threads.message('project', threadId, 'owner', text, false);
    await f.waitFor(() => f.thread(threadId).lastReport?.summary, (summary) => summary === text); await f.app.projectWork.idle('project');
  };
  await message('Second.');
  expect(f.fake.turnStarts[1]).toMatchObject({ prompt: 'Second.', resume: { sessionId: session }, account: { account: { id: 'acc_fixture' } } });
  // The placed account cools down; another account takes the next turn in a fresh session.
  f.app.hub.put('accounts', 'acc_second', AccountSchema, { schema: 'account-v1', id: 'acc_second', runtime: 'fake', label: 'Second', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await f.app.accounts.check('acc_second');
  await f.app.accounts.recordError('acc_fixture', 'rate-limit');
  await message('Third.');
  const third = f.fake.turnStarts[2]!;
  expect(third).toMatchObject({ prompt: 'Task: Pinned\n\nDo the pinned work.\n\n---\n\nThird.', account: { account: { id: 'acc_second' } } });
  expect(third.resume).toBeUndefined();
  const thread = f.thread(threadId);
  expect(thread.placement.accountId).toBe('acc_second'); expect(thread.nativeSessionId).not.toBe(session);
  expect(payloads(f, threadId, 'notice')).toContainEqual({ schema: 'project-notice-v1', text: 'This thread moved to account Second; a fresh session started.', kind: 'info' });
  await f.app.projectWork.pulse();
  expect(await f.index(threadId)).toMatchObject({ accountLabel: 'Second', turns: 3 });
  // The new account's session continues from there.
  await message('Fourth.');
  expect(f.fake.turnStarts[3]).toMatchObject({ prompt: 'Fourth.', resume: { sessionId: thread.nativeSessionId }, account: { account: { id: 'acc_second' } } });
});

test('placement phase gates: fixed main and foreign devices are refused with nothing created; a main default and a stale heartbeat still place a worktree here (D8, D88)', { timeout: 120_000 }, async () => {
  const f = await setup();
  const refusedWith = async (extra: object, message: string) => {
    const response = await f.request('/api/projects/project/threads', 'POST', createBody('Gated', 'Try a fixed field.', undefined, extra));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ schema: 'error-v1', code: 'conflict', message });
  };
  const at = new Date().toISOString();
  f.app.hub.put('devices', 'dev_studio', DeviceSchema, { schema: 'device-v1', id: 'dev_studio', name: 'Studio', role: 'member', url: 'http://127.0.0.1:9772', os: 'darwin', version: '0.1.0', joinedAt: at, lastHeartbeatAt: at }, 0);
  await refusedWith({ isolation: 'main' }, 'Main isolation is not available yet.');
  await refusedWith({ deviceId: 'dev_studio' }, 'Threads run only on this device for now.');
  await refusedWith({ deviceId: 'dev_unknown' }, 'Choose a registered device.');
  expect((await f.json('/api/projects/project/work', ProjectWorkViewSchema)).threads).toEqual([]);
  expect(f.fake.turnStarts).toEqual([]);
  // A main default is placed as a worktree until main isolation exists; this device's stale heartbeat does not exclude it.
  await settings(f, { defaultIsolation: 'main' });
  const device = f.app.hub.get('devices', f.app.device.deviceId, DeviceSchema)!;
  f.app.hub.put('devices', f.app.device.deviceId, DeviceSchema, { ...device.document, lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString() }, device.revision);
  expect((await f.app.roster()).devices.find((view) => view.device.id === f.app.device.deviceId)?.status).toBe('stale');
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Placed here.' }), forThread());
  const created = await start(f, 'Default main', 'Work with the main default.');
  expect(created).toMatchObject({ state: 'preparing', placement: `Scripted test runtime Fixture · high · Worktree · ${f.deviceName} · placed without Jev: no key configured` });
  await f.waitFor(() => f.thread(created.threadId).turns, (turns) => turns === 1);
  expect(f.thread(created.threadId)).toMatchObject({ isolation: 'worktree', ownerDeviceId: f.app.device.deviceId, cwd: f.homes.at('worktrees', 'project', created.threadId) });
});

test('placement phase gates: a Leave git project refuses fixed main isolation', { timeout: 60_000 }, async () => {
  const f = await setup({ branchPolicy: 'external' });
  const response = await f.request('/api/projects/project/threads', 'POST', createBody('Gated', 'Work on main.', undefined, { isolation: 'main' }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: 'This project is set to Leave git to me, so threads cannot work on main.' });
  expect((await f.json('/api/projects/project/work', ProjectWorkViewSchema)).threads).toEqual([]);
});
