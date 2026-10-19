import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ThreadCreatedViewSchema, type ProjectWorkSettings } from '../packages/core/dist/index.js';
import { forThread, type FakeTurn } from '../packages/runtime-contract/dist/index.js';
import { commitStep, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

// Fix B (fix-051): fix turns (automatic, and from the Fix checks, Resolve conflicts and Address comments buttons) start from the pull
// request's current head after someone else pushed to it, and the checks fix reads the failing run and job on that head.

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const updated = (n: number, sha: string) => `Updated the worktree to pull request #${n}'s head ${sha.slice(0, 7)} before this fix.`;

async function open(f: ProjectFixture) {
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'First version.\n' }, { status: 'done', summary: 'Added the greeting.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'req_head_open', title: 'Repair the greeting', task: 'Add greeting.txt.' });
  await f.app.projectWork.idle(); const thread = f.thread(made.threadId);
  expect(thread.state).toBe('in-review');
  return { thread, n: thread.pr!.number, branch: f.git(thread.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD') };
}
async function settings(f: ProjectFixture, patch: Partial<ProjectWorkSettings>) {
  const current = await f.app.projectWork.admission.settings(f.project.id);
  await f.app.projectHub.putSettings({ ...current, ...patch }, current.revision);
}
/** The owner pushes a commit to the pull request branch from their own clone, through the remote. */
function ownerCommit(f: ProjectFixture, branch: string, files: Record<string, string>, message = 'Owner change'): string {
  const clone = mkdtempSync(join(f.root, 'owner-')); f.git(f.root, 'clone', '--quiet', f.origin, clone);
  f.git(clone, 'checkout', '--quiet', branch);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(clone, name), content);
  f.git(clone, 'add', '-A'); f.git(clone, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '--quiet', '-m', message);
  f.git(clone, 'push', '--quiet', 'origin', branch);
  return f.git(clone, 'rev-parse', 'HEAD');
}
const notices = (f: ProjectFixture, threadId: string) => f.app.projectWork.ledgers.thread(f.project.id, threadId).events()
  .filter(event => event.type === 'notice').map(event => (event.data as { text: string }).text);
/** Records the worktree as the fix turn found it, then commits a fix and reports done. */
function fixTurn(f: ProjectFixture, seen: Record<string, unknown>, extra?: (turn: FakeTurn) => Promise<void>) {
  f.fake.enqueueTurn(async turn => {
    const cwd = turn.input.cwd;
    seen.head = f.git(cwd, 'rev-parse', 'HEAD'); seen.ownerFile = existsSync(join(cwd, 'owner.txt'));
    seen.merging = existsSync(join(f.git(cwd, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'));
    await extra?.(turn);
    if (!seen.merging) { writeFileSync(join(cwd, 'greeting.txt'), 'Fixed version.\n'); f.git(cwd, 'add', '-A'); f.git(cwd, 'commit', '--quiet', '-m', 'Fix'); }
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Fixed it.' }); return { status: 'completed' };
  }, forThread());
}

test('failing checks after an owner commit: the worktree is at the new head, the failing job log is readable in scope, and the fix publishes', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); const { thread, n, branch } = await open(f);
  const owner = ownerCommit(f, branch, { 'owner.txt': 'Owner line\n' });
  const run = f.github.addWorkflow({ workflow: 'checks.yml', head_sha: owner, head_branch: branch, event: 'pull_request', conclusion: 'failure',
    jobs: [{ id: 501, name: 'unit tests', status: 'completed', conclusion: 'failure', steps: [], logs: 'FAIL greeting.test.ts: expected a newline' }] });
  const seen: Record<string, unknown> = {};
  fixTurn(f, seen, async turn => {
    seen.log = await turn.bridge('jevellan_github', { action: 'job_log', jobId: 501 }).catch((error: Error) => error.message);
    seen.runs = await turn.bridge('jevellan_github', { action: 'runs', branch }).catch((error: Error) => error.message);
  });
  f.github.setChecks(n, 'failing');
  await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).turns).toBe(2);
  expect(seen).toMatchObject({ head: owner, ownerFile: true, merging: false });
  expect(JSON.stringify(seen.log)).toContain('FAIL greeting.test.ts: expected a newline');
  expect(JSON.stringify(seen.runs)).toContain(`"id":${run.id}`);
  const prompt = f.fake.turnStarts[1]!.prompt;
  expect(prompt).toContain(`run ${run.id}`); expect(prompt).toContain('job 501');
  expect(notices(f, thread.id)).toContain(updated(n, owner));
  const after = f.thread(thread.id);
  expect(after.pr!.headSha).not.toBe(owner);
  expect(f.git(f.origin, 'merge-base', '--is-ancestor', owner, after.pr!.headSha)).toBe('');
});

test('the Fix checks button after an owner commit also starts from the new head', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); await settings(f, { prAutoFix: { checks: false, conflicts: false, comments: false, maxRounds: 3 } });
  const { thread, n, branch } = await open(f);
  const owner = ownerCommit(f, branch, { 'owner.txt': 'Owner line\n' });
  f.github.setChecks(n, 'failing'); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).turns).toBe(1);
  const seen: Record<string, unknown> = {}; fixTurn(f, seen);
  const response = await f.request(`/api/projects/project/threads/${thread.id}/actions`, 'POST', { schema: 'thread-action-request-v1', clientRequestId: 'owner_fix_checks', action: 'fix-checks' });
  expect(response.status).toBe(200); await f.app.projectWork.idle();
  expect(seen).toMatchObject({ head: owner, ownerFile: true });
  expect(notices(f, thread.id)).toContain(updated(n, owner));
  const published = f.thread(thread.id).pr!.headSha; expect(published).not.toBe(owner);
  expect(f.git(f.origin, 'merge-base', '--is-ancestor', owner, published)).toBe('');
});

test('review comments on top of an owner commit: the comments turn starts at the new head and publishes', { timeout: 120_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }); const { thread, n, branch } = await open(f);
  const owner = ownerCommit(f, branch, { 'owner.txt': 'Owner line\n' });
  now += 1000; const at = new Date(now).toISOString(), pull = f.github.pulls.find(p => p.number === n)!;
  pull.inlineComments = [{ id: 7, user: { login: 'owner' }, body: 'Rename the new helper to formatInvoiceTotal.', created_at: at, path: 'greeting.txt', line: 1 }]; pull.updatedAt = at;
  await f.app.projectWork.tracker.poll();
  const seen: Record<string, unknown> = {}; fixTurn(f, seen);
  now += 121_000; await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).turns).toBe(2);
  expect(f.fake.turnStarts[1]!.prompt).toContain('Rename the new helper to formatInvoiceTotal.');
  expect(seen).toMatchObject({ head: owner, ownerFile: true });
  expect(notices(f, thread.id)).toContain(updated(n, owner));
  const published = f.thread(thread.id).pr!.headSha; expect(published).not.toBe(owner);
  expect(f.git(f.origin, 'merge-base', '--is-ancestor', owner, published)).toBe('');
});

test('a conflict turn after an owner commit starts from the new head before merging the base', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); const { thread, n, branch } = await open(f);
  const owner = ownerCommit(f, branch, { 'owner.txt': 'Owner line\n' });
  writeFileSync(join(f.checkout, 'greeting.txt'), 'Main greeting.\n'); f.git(f.checkout, 'add', 'greeting.txt'); f.git(f.checkout, 'commit', '-m', 'Main greeting'); f.git(f.checkout, 'push', 'origin', 'main');
  f.github.setMergeable(n, 'dirty');
  const seen: Record<string, unknown> = {};
  f.fake.enqueueTurn(async turn => {
    const cwd = turn.input.cwd; seen.head = f.git(cwd, 'rev-parse', 'HEAD'); seen.ownerFile = existsSync(join(cwd, 'owner.txt'));
    f.git(cwd, 'fetch', 'origin'); expect(() => f.git(cwd, 'merge', 'origin/main')).toThrow();
    writeFileSync(join(cwd, 'greeting.txt'), 'First version. Main greeting.\n'); f.git(cwd, 'add', 'greeting.txt'); f.git(cwd, 'commit', '-m', 'Keep both greetings');
    f.github.setMergeable(n, 'clean'); await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Kept both greetings.' }); return { status: 'completed' };
  }, forThread());
  await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(seen).toMatchObject({ head: owner, ownerFile: true });
  expect(notices(f, thread.id)).toContain(updated(n, owner));
  const published = f.thread(thread.id).pr!.headSha; expect(published).not.toBe(owner);
  expect(f.git(f.origin, 'merge-base', '--is-ancestor', owner, published)).toBe('');
});

test('local unpushed commits and a conflicting owner commit produce a merge, never a rebase, and a turn that resolves the conflicts', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); const { thread, n, branch } = await open(f);
  const cwd = thread.cwd!, local = (() => { writeFileSync(join(cwd, 'greeting.txt'), 'Local wording.\n'); f.git(cwd, 'add', '-A'); f.git(cwd, 'commit', '--quiet', '-m', 'Local wording'); return f.git(cwd, 'rev-parse', 'HEAD'); })();
  const owner = ownerCommit(f, branch, { 'greeting.txt': 'Owner wording.\n' });
  const seen: Record<string, unknown> = {};
  fixTurn(f, seen, async turn => {
    seen.conflicted = readFileSync(join(turn.input.cwd, 'greeting.txt'), 'utf8').includes('<<<<<<<');
    writeFileSync(join(turn.input.cwd, 'greeting.txt'), 'Owner wording, kept with the local wording.\n'); f.git(turn.input.cwd, 'add', '-A'); f.git(turn.input.cwd, 'commit', '--quiet', '--no-edit');
  });
  f.github.setChecks(n, 'failing'); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(seen).toMatchObject({ head: local, merging: true, conflicted: true });
  const prompt = f.fake.turnStarts[1]!.prompt;
  expect(prompt).toContain('greeting.txt'); expect(prompt).toContain(owner.slice(0, 7));
  expect(notices(f, thread.id)).toContain(updated(n, owner));
  const head = f.thread(thread.id).pr!.headSha, parents = f.git(f.origin, 'rev-list', '--parents', '-n', '1', head).split(' ');
  expect(parents).toHaveLength(3); expect(parents).toEqual(expect.arrayContaining([local, owner]));
});
