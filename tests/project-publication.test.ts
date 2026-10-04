import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Homes, PlacementRecordSchema, ProjectSchema, SecretRedactor, ThreadReportSchema, ThreadSchema, type CoordinatorEvent, type Project, type Thread,
} from '../packages/core/dist/index.js';
import {
  BRANCH_PUSHED_NO_TOKEN, GitHubAccess, MERGE_CHECKS_FAILING, MERGE_CONFLICTS, NOT_GITHUB, NO_REMOTE, PR_CLOSED, REMOTE_CREDENTIALS, ProjectLedgers, ProjectPaths, PullRequestTracker,
  ThreadGit, ThreadIndexPublisher, ThreadPublication, ThreadStore, ThreadWorktree, VERIFICATION_HEAD_MOVED, githubRefused, prStatusUnavailable,
  type WorktreePublication,
} from '../packages/projects/dist/index.js';
import { startGitHubFixture, type GitHubFixture } from './fixtures/github-server.mjs';

let root: string; let homes: Homes; let redactor: SecretRedactor; let git: ThreadGit; let worktrees: ThreadWorktree; let threads: ThreadStore; let ledgers: ProjectLedgers;
let origin: string; let checkout: string; let project: Project; let github: GitHubFixture; let access: GitHubAccess; let publication: ThreadPublication;
/** The saved GitHub token as the daemon would read it; the fixture accepts only `fixtureToken`. */
let token: string | undefined; let fixtureToken: string;
const at = '2026-10-03T10:00:00.000Z'; const now = Date.parse(at);
const placement = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fallback', fixed: [], isolation: 'worktree', runtime: 'codex', modelId: 'swift',
  model: 'swift-version', effortRequested: 'medium', effortEffective: 'medium', deviceId: 'dev_a', accountId: 'acc_a', eligibleModels: ['swift'], excludedModels: [],
  eligibleDevices: ['dev_a'], excludedDevices: [], error: { kind: 'not-enabled', message: 'Jev placement is not enabled yet.' }, jevCalls: [], decidedAt: at });
const labels = { runtimeName: 'Codex', modelLabel: 'Swift' };
function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
const fails = (cwd: string, ...args: string[]) => { try { run(cwd, ...args); return false; } catch { return true; } };
const report = (summary: string) => ThreadReportSchema.parse({ schema: 'thread-report-v1', turn: 1, status: 'done', summary, synthesized: false });

/** A thread with its worktree prepared and a done report, as the runner hands it to publication. */
async function prepared(id: string, title: string, summary = 'Added greeting.txt with a test.'): Promise<Thread> {
  threads.create(ThreadSchema.parse({ schema: 'project-thread-v1', id, projectId: 'proj_a', title, task: 'Create greeting.txt.', createdAt: at, createdBy: 'owner',
    state: 'preparing', isolation: 'worktree', placement, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_a', cwd: '', baseBranch: '', baseCommit: '', turns: 0,
    turnAllowance: 30, queuedMessages: [], verificationAttempts: 0 }), { modelLabel: 'Swift', accountLabel: 'Work' });
  const made = await worktrees.create(project, threads.get(id)!);
  return threads.update(id, (thread) => ({ ...thread, ...made, state: 'publishing', turns: 1, lastReport: report(summary) }));
}
function commit(cwd: string, files: Record<string, string>, message = 'Work'): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  run(cwd, 'add', '-A'); run(cwd, 'commit', '-m', message); return run(cwd, 'rev-parse', 'HEAD');
}
const publish = (thread: Thread, over: Partial<WorktreePublication> = {}) => publication.publishWorktree({ project, thread, local: threads.local(thread.id), ledger: ledgers.thread('proj_a', thread.id), labels, ...over });
const verifications = (threadId: string) => ledgers.thread('proj_a', threadId).events().filter((event) => event.type === 'thread-verification').map((event) => event.data);
const pullPosts = () => github.requests.filter((request) => request.method === 'POST' && request.path === '/repos/fixture/repo/pulls');

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-publication-'))); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); redactor = new SecretRedactor(); const paths = new ProjectPaths(homes);
  git = new ThreadGit({ homes, redactor }); worktrees = new ThreadWorktree({ git, homes, paths, redactor, deviceId: 'dev_a', deviceName: 'Mac mini' });
  ledgers = new ProjectLedgers(paths); threads = new ThreadStore(paths, ledgers, new ThreadIndexPublisher({ publishThread: async (_index, eventId) => ({ eventId }) }));
  origin = join(root, 'origin.git'); run(root, 'init', '--bare', '-b', 'main', origin);
  checkout = join(root, 'project'); run(root, 'clone', origin, checkout);
  run(checkout, 'config', 'user.name', 'Fixture'); run(checkout, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(checkout, 'value.txt'), '1\n'); run(checkout, 'add', '-A'); run(checkout, 'commit', '-m', 'Seed'); run(checkout, 'push', '-u', 'origin', 'main');
  // A GitHub-shaped remote that git rewrites to the bare origin (D18).
  run(checkout, 'remote', 'set-url', 'origin', 'https://github.com/fixture/repo.git'); run(checkout, 'config', `url.${origin}.insteadOf`, 'https://github.com/fixture/repo.git');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'proj_a', name: 'Shop', paths: { dev_a: checkout }, branchPolicy: 'main', testCommand: 'test -f greeting.txt',
    memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  fixtureToken = `fixture-${randomUUID()}`; token = fixtureToken;
  github = await startGitHubFixture({ token: fixtureToken, repositories: { 'fixture/repo': origin } });
  access = new GitHubAccess({ credential: async () => token, baseUrl: github.url, redactor });
  publication = new ThreadPublication({ git, homes, redactor, github: access, deviceName: 'Mac mini', now: () => now });
});
afterEach(async () => { await github.close(); rmSync(root, { recursive: true, force: true }); });

test('publication commits leftovers without trailers, verifies the exact head, pushes with a create-only lease and opens the pull request (brief 8.4, 9.7)', async () => {
  const before = { head: run(checkout, 'rev-parse', 'HEAD'), status: run(checkout, 'status', '--porcelain=v1'), tracking: run(checkout, 'rev-parse', 'refs/remotes/origin/main') };
  let thread = await prepared('thread_01K6PUBLISH1', 'Add greeting', 'Added greeting.txt with a test.\nIt prints hello.');
  commit(thread.cwd, { 'greeting.txt': 'hello\n' }, 'Add greeting');
  writeFileSync(join(thread.cwd, 'notes.md'), 'left over\n');
  threads.updateLocal(thread.id, (local) => ({ ...local, gitIdentity: { name: 'Owner', email: 'owner@example.invalid' } }));
  const pushed: string[] = [];
  const result = await publish(thread, { onPushed: (sha) => pushed.push(sha) });
  const head = run(thread.cwd, 'rev-parse', 'HEAD');
  // The leftover commit: the D86 subject only, the machine identity, nothing appended.
  expect(run(thread.cwd, 'log', '-1', '--format=%B')).toBe('Add greeting: Added greeting.txt with a test.');
  expect(run(thread.cwd, 'log', '-1', '--format=%an <%ae> %cn <%ce>')).toBe('Owner <owner@example.invalid> Owner <owner@example.invalid>');
  expect(run(thread.cwd, 'status', '--porcelain=v1')).toBe('');
  expect(result).toEqual({ pushedCommit: head, verified: expect.objectContaining({ status: 'passed', command: 'test -f greeting.txt', exitCode: 0, commit: head }),
    outcome: { kind: 'pr', result: 'pr-opened', pr: { number: 1, url: 'https://github.com/fixture/repo/pull/1', state: 'open', headSha: head, checks: 'none', mergeable: 'clean', updatedAt: at } } });
  expect(pushed).toEqual([head]);
  expect(run(origin, 'rev-parse', `refs/heads/${thread.branch}`)).toBe(head);
  expect(verifications(thread.id)).toEqual([expect.objectContaining({ schema: 'thread-verification-v1', attempt: 1, command: 'test -f greeting.txt', status: 'passed', exitCode: 0, timedOut: false, commit: head, tail: '' })]);
  expect(pullPosts().map((request) => request.body)).toEqual([{ title: 'Add greeting', head: thread.branch, base: 'main',
    body: 'Added greeting.txt with a test.\nIt prints hello.\n\nTests: Passed: test -f greeting.txt\n\nThread: Add greeting\nPlacement: Codex Swift, medium effort, Mac mini' }]);
  expect(JSON.stringify(github.requests)).not.toContain(fixtureToken);
  // The owner checkout never moved.
  expect({ head: run(checkout, 'rev-parse', 'HEAD'), status: run(checkout, 'status', '--porcelain=v1'), tracking: run(checkout, 'rev-parse', 'refs/remotes/origin/main') }).toEqual(before);

  // A fix commit later: the push leases on the recorded commit and the open pull request is found, not created again.
  threads.updateLocal(thread.id, (local) => ({ ...local, pushedCommit: head }));
  thread = threads.update(thread.id, (current) => ({ ...current, verificationAttempts: 0 }));
  const fix = commit(thread.cwd, { 'greeting.txt': 'hello, world\n' }, 'Polish greeting');
  const second = await publish(thread);
  expect(second.outcome).toEqual({ kind: 'pr', result: 'pr-updated', pr: expect.objectContaining({ number: 1, headSha: fix, mergeable: 'clean' }) });
  expect(pullPosts()).toHaveLength(1); expect(run(origin, 'rev-parse', `refs/heads/${thread.branch}`)).toBe(fix);

  // A lease on a commit the remote branch no longer holds is refused and nothing is overwritten.
  threads.updateLocal(thread.id, (local) => ({ ...local, pushedCommit: head }));
  commit(thread.cwd, { 'greeting.txt': 'hi\n' }, 'Third');
  const stale = await publish(thread);
  expect(stale.outcome.kind).toBe('error'); expect(stale.outcome.kind === 'error' && stale.outcome.reason).toMatch(/^Git push failed \(1\): .*stale info/s);
  expect(run(origin, 'rev-parse', `refs/heads/${thread.branch}`)).toBe(fix);
}, 60_000);

test('a first push never clobbers a foreign branch, but recovers its own unrecorded push (D27)', async () => {
  const thread = await prepared('thread_01K6PUBLISH2', 'Add greeting');
  const mine = commit(thread.cwd, { 'greeting.txt': 'hello\n' });
  // The thread pushed before a crash lost the record: the retry leases on that commit of its own.
  run(thread.cwd, 'push', 'origin', `HEAD:refs/heads/${thread.branch}`);
  const recovered = await publish(thread);
  expect(recovered.outcome.kind).toBe('pr'); expect(recovered.pushedCommit).toBe(mine);
  // A branch of the same name holding a commit that is not this thread's is refused.
  const other = await prepared('thread_01K6PUBLISH3', 'Add greeting', 'Another greeting.');
  commit(other.cwd, { 'greeting.txt': 'other\n' });
  const second = join(root, 'second'); run(root, 'clone', origin, second); run(second, 'switch', '-c', 'foreign');
  const foreign = commit(second, { 'foreign.txt': 'x\n' }); run(second, 'push', 'origin', `HEAD:refs/heads/${other.branch}`);
  const refused = await publish(other);
  expect(refused.outcome.kind).toBe('error'); expect(refused.outcome.kind === 'error' && refused.outcome.reason).toMatch(/^Git push failed \(1\): /);
  expect(run(origin, 'rev-parse', `refs/heads/${other.branch}`)).toBe(foreign);
}, 60_000);

test('nothing committed concludes without changes; a failed or moved test run stops before the push; no test command is skipped', async () => {
  const empty = await prepared('thread_01K6PUBLISH4', 'Nothing to do');
  expect(await publish(empty)).toEqual({ outcome: { kind: 'no-changes' } });
  expect(verifications(empty.id)).toEqual([]); expect(fails(origin, 'rev-parse', '--verify', `refs/heads/${empty.branch}`)).toBe(true);

  project = { ...project, testCommand: 'cat value.txt; test "$(cat value.txt)" = 3' };
  let thread = await prepared('thread_01K6PUBLISH5', 'Count to three');
  commit(thread.cwd, { 'value.txt': '2\n' });
  thread = threads.update(thread.id, (current) => ({ ...current, verificationAttempts: 1 }));
  const failed = await publish(thread);
  expect(failed.outcome).toEqual({ kind: 'verification-failed', verification: expect.objectContaining({ status: 'failed', exitCode: 1, timedOut: false, tail: '2\n', command: project.testCommand }) });
  expect(verifications(thread.id)).toEqual([expect.objectContaining({ attempt: 2, status: 'failed', exitCode: 1, tail: '2\n', outputRef: expect.stringMatching(/^blobs\//) })]);
  expect(fails(origin, 'rev-parse', '--verify', `refs/heads/${thread.branch}`)).toBe(true);
  // A test command that commits changed what it tested: the run does not count.
  project = { ...project, testCommand: 'echo ok; git commit -q --allow-empty -m moved' };
  const moved = await publish(thread);
  expect(moved.outcome.kind === 'verification-failed' && moved.outcome.verification).toMatchObject({ status: 'failed', exitCode: 0, tail: `ok\n${VERIFICATION_HEAD_MOVED}` });

  project = ProjectSchema.parse({ ...project, testCommand: undefined });
  const skipped = await publish(threads.get(thread.id)!);
  expect(skipped.verified).toEqual({ status: 'skipped', command: null, timedOut: false, tail: '', commit: run(thread.cwd, 'rev-parse', 'HEAD') });
  expect(verifications(thread.id).at(-1)).toEqual({ schema: 'thread-verification-v1', attempt: 2, command: null, status: 'skipped', timedOut: false, commit: run(thread.cwd, 'rev-parse', 'HEAD'), tail: '' });
  expect(pullPosts().at(-1)?.body).toMatchObject({ body: expect.stringContaining('\n\nTests: Not run: no test command\n\n') });
}, 60_000);

test('without a token, a GitHub remote or any remote the branch stays with the documented reason; GitHub refusals are errors (D23, D58)', async () => {
  const thread = await prepared('thread_01K6PUBLISH6', 'Add greeting');
  const head = commit(thread.cwd, { 'greeting.txt': 'hello\n' });
  token = undefined;
  expect((await publish(thread)).outcome).toEqual({ kind: 'branch-only', reason: BRANCH_PUSHED_NO_TOKEN, branch: thread.branch });
  expect(run(origin, 'rev-parse', `refs/heads/${thread.branch}`)).toBe(head); expect(github.requests).toEqual([]);
  token = fixtureToken; threads.updateLocal(thread.id, (local) => ({ ...local, pushedCommit: head }));
  github.failNext('POST', /\/pulls$/, 422, 'Validation Failed');
  expect((await publish(thread)).outcome).toEqual({ kind: 'error', reason: githubRefused('Validation Failed') });
  expect(githubRefused('Validation Failed')).toBe('GitHub refused the pull request: Validation Failed');

  run(checkout, 'remote', 'set-url', 'origin', origin);
  expect((await publish(thread)).outcome).toEqual({ kind: 'branch-only', reason: NOT_GITHUB, branch: thread.branch });
  run(checkout, 'remote', 'set-url', 'origin', 'https://someone:secret@github.com/fixture/repo.git');
  expect((await publish(thread)).outcome).toEqual({ kind: 'error', reason: REMOTE_CREDENTIALS });
  run(checkout, 'remote', 'remove', 'origin');
  const local = await publish(thread);
  expect(local.outcome).toEqual({ kind: 'no-remote', reason: NO_REMOTE }); expect(local.verified?.status).toBe('passed');
}, 60_000);

test('pull request tracking reports check and conflict transitions once, merges the reviewed head and cleans up (brief 8.5, D68, D69, D75, D95)', async () => {
  const events: CoordinatorEvent[] = [];
  const tracker = new PullRequestTracker({ threads, github: access, git, worktrees, project: async () => project, toCoordinator: async (_projectId, event) => { events.push(event); }, redactor, now: () => now });
  const open = async (id: string, title: string) => {
    const thread = await prepared(id, title); commit(thread.cwd, { 'greeting.txt': `${id}\n` });
    const result = await publish(thread); if (result.outcome.kind !== 'pr') throw new Error(`not published: ${JSON.stringify(result.outcome)}`);
    const pr = result.outcome.pr;
    return threads.update(id, (current) => ({ ...current, state: 'in-review', pr }));
  };
  const changes = () => events.map((event) => event.kind === 'pr-update' ? `${event.prNumber} ${event.change}` : event.kind);
  const thread = await open('thread_01K6TRACK0001', 'Add greeting');
  const ledger = ledgers.thread('proj_a', thread.id);
  const notices = () => ledger.events().filter((event) => event.type === 'notice').map((event) => (event.data as { text: string }).text);

  await tracker.poll(); expect(changes()).toEqual([]);
  github.setChecks(1, 'failing'); await tracker.poll();
  expect(threads.get(thread.id)!.pr).toMatchObject({ checks: 'failing', state: 'open' }); expect(changes()).toEqual(['1 checks-failed']);
  expect(ledger.events().at(-1)).toMatchObject({ type: 'thread-publication', data: { result: 'pr-state', prNumber: 1, pr: { checks: 'failing' } } });
  const size = ledger.events().length; await tracker.poll(); expect(changes()).toEqual(['1 checks-failed']); expect(ledger.events()).toHaveLength(size);
  await expect(tracker.merge(thread.id)).rejects.toMatchObject({ message: MERGE_CHECKS_FAILING, status: 409 });
  // Passing on the same head is another transition; GitHub's combined status still reads pending with no entries.
  github.setChecks(1, 'passing'); await tracker.poll(); expect(changes()).toEqual(['1 checks-failed', '1 checks-passed']);
  github.setMergeable(1, 'dirty'); await tracker.poll(); await tracker.poll();
  expect(changes()).toEqual(['1 checks-failed', '1 checks-passed', '1 conflict']);
  await expect(tracker.merge(thread.id)).rejects.toMatchObject({ message: MERGE_CONFLICTS, status: 409 });
  github.setMergeable(1, 'clean'); await tracker.poll();
  // Without a token the last state stays and one notice is written per kind of failure.
  token = undefined; await tracker.poll(); await tracker.poll();
  expect(notices()).toEqual([prStatusUnavailable('No GitHub token is saved.')]); expect(threads.get(thread.id)!).toMatchObject({ state: 'in-review', pr: { state: 'open', checks: 'passing', mergeable: 'clean' } });
  await expect(tracker.merge(thread.id)).rejects.toMatchObject({ message: 'No GitHub token is saved.', status: 409 });
  token = fixtureToken; github.failNext('PUT', /\/merge$/, 405, 'Pull Request is not mergeable');
  await expect(tracker.merge(thread.id)).rejects.toMatchObject({ message: 'Pull Request is not mergeable', status: 409 });

  // A squash merge of the reviewed head concludes the thread at once and removes its worktree and local branch only.
  const head = threads.get(thread.id)!.pr!.headSha;
  expect(await tracker.merge(thread.id)).toEqual({ schema: 'pull-request-merge-view-v1', merged: true, message: 'Pull Request successfully merged' });
  expect(github.requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([{ merge_method: 'squash', sha: head }, { merge_method: 'squash', sha: head }]);
  const merged = threads.get(thread.id)!;
  expect(merged).toMatchObject({ state: 'done', endedAt: at, pr: { state: 'merged', headSha: head } }); expect(merged.stateReason).toBeUndefined();
  expect(changes().at(-1)).toBe('1 merged');
  expect(existsSync(thread.cwd)).toBe(false); expect(fails(checkout, 'rev-parse', '--verify', `refs/heads/${thread.branch}`)).toBe(true);
  expect(run(checkout, 'for-each-ref', `refs/jevellan/threads/${thread.id}`)).toBe(''); expect(run(origin, 'rev-parse', `refs/heads/${thread.branch}`)).toBe(head);
  expect(ledger.events().at(-1)).toMatchObject({ type: 'thread-publication', data: { result: 'cleanup', branch: thread.branch } });
  await expect(tracker.merge(thread.id)).rejects.toMatchObject({ status: 409 });
  await tracker.poll(); expect(changes().filter((change) => change === '1 merged')).toHaveLength(1);

  // Closed without merging during a fix turn: polled anyway (D95), stopped with its reason, cleaned up (D69).
  const docs = await open('thread_01K6TRACK0002', 'Write docs');
  threads.update(docs.id, (current) => ({ ...current, state: 'running' }));
  github.closePull(2); await tracker.poll();
  expect(threads.get(docs.id)!).toMatchObject({ state: 'stopped', stateReason: PR_CLOSED, endedAt: at, pr: { state: 'closed' } });
  expect(changes().at(-1)).toBe('2 closed'); expect(existsSync(docs.cwd)).toBe(false);
  // Merged on GitHub itself: the next poll concludes it; jevellan_pr_status reads the stored final state.
  const third = await open('thread_01K6TRACK0003', 'Tidy up');
  github.markMerged(3); await tracker.poll();
  expect(threads.get(third.id)!.state).toBe('done'); expect(changes().at(-1)).toBe('3 merged');
  expect(await tracker.fresh('proj_a', third.id)).toEqual({ pr: expect.objectContaining({ number: 3, state: 'merged' }) });
  // A thread the owner already stopped keeps its own end when its pull request closes; its worktree still goes.
  const fourth = await open('thread_01K6TRACK0004', 'Abandon');
  threads.update(fourth.id, (current) => ({ ...current, state: 'stopped', stateReason: 'Stopped by you.', endedAt: '2026-10-03T09:00:00.000Z' }));
  github.closePull(4); await tracker.poll();
  expect(threads.get(fourth.id)!).toMatchObject({ state: 'stopped', stateReason: 'Stopped by you.', endedAt: '2026-10-03T09:00:00.000Z', pr: { state: 'closed' } });
  expect(changes().at(-1)).toBe('4 closed'); expect(existsSync(fourth.cwd)).toBe(false);
}, 120_000);
