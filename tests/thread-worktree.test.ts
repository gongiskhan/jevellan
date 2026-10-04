import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, PlacementRecordSchema, ProjectSchema, SecretRedactor, ThreadSchema, inside, type Project, type Thread } from '../packages/core/dist/index.js';
import {
  ProjectLedgers, ProjectPaths, ThreadGit, ThreadWorktree, commandTimedOut, contextLinkSkipped, outputTail, parseWorktrees, runThreadCommand, worktreeSetupFailed,
} from '../packages/projects/dist/index.js';

let root: string; let homes: Homes; let paths: ProjectPaths; let redactor: SecretRedactor; let git: ThreadGit; let worktrees: ThreadWorktree;
let origin: string; let checkout: string; let project: Project;
const at = '2026-10-03T10:00:00.000Z';
function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
const fails = (cwd: string, ...args: string[]) => { try { run(cwd, ...args); return false; } catch { return true; } };
const placement = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fixed', fixed: ['isolation', 'model', 'effort', 'device'], isolation: 'worktree',
  runtime: 'codex', modelId: 'swift', model: 'swift-version', effortRequested: 'medium', effortEffective: 'medium', deviceId: 'dev_a', accountId: 'acc_a', eligibleModels: ['swift'],
  excludedModels: [], eligibleDevices: ['dev_a'], excludedDevices: [], jevCalls: [], decidedAt: at });
const thread = (over: Partial<Thread> = {}): Thread => ThreadSchema.parse({ schema: 'project-thread-v1', id: 'thread_01K6XYZQ9M7RTP', projectId: 'proj_a', title: 'Fix login!',
  task: 'The redirect loops.', createdAt: at, createdBy: 'owner', state: 'preparing', isolation: 'worktree', placement, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_a',
  cwd: '', baseBranch: '', baseCommit: '', turns: 0, turnAllowance: 30, queuedMessages: [], verificationAttempts: 0, ...over });
/** What a thread must never change in the owner checkout. */
function ownerState() {
  return { head: run(checkout, 'rev-parse', 'HEAD'), status: run(checkout, 'status', '--porcelain=v1', '--untracked-files=all'), index: readFileSync(join(checkout, '.git', 'index')).toString('hex'),
    branch: run(checkout, 'symbolic-ref', 'HEAD'), tracking: run(checkout, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/trunk', 'refs/tags'),
    fetchHead: existsSync(join(checkout, '.git', 'FETCH_HEAD')) ? readFileSync(join(checkout, '.git', 'FETCH_HEAD'), 'utf8') : null };
}
function upstream(file: string): string {
  const second = join(root, `second-${file}`); if (!existsSync(second)) run(root, 'clone', origin, second);
  run(second, 'pull', '--ff-only'); writeFileSync(join(second, file), `${file}\n`); run(second, 'add', '-A'); run(second, 'commit', '-m', file); run(second, 'push', 'origin', 'HEAD:trunk');
  return run(second, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-worktree-'))); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); paths = new ProjectPaths(homes); redactor = new SecretRedactor();
  git = new ThreadGit({ homes, redactor }); worktrees = new ThreadWorktree({ git, homes, paths, redactor, deviceId: 'dev_a', deviceName: 'Mac mini' });
  // origin HEAD points at trunk, so base detection reads it instead of falling back to main.
  origin = join(root, 'origin.git'); run(root, 'init', '--bare', '-b', 'trunk', origin);
  checkout = join(root, 'project'); run(root, 'clone', origin, checkout);
  run(checkout, 'config', 'user.name', 'Fixture'); run(checkout, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(checkout, 'AGENTS.md'), '# Shop\n'); writeFileSync(join(checkout, 'value.txt'), '1\n'); run(checkout, 'add', '-A'); run(checkout, 'commit', '-m', 'Seed');
  run(checkout, 'push', '-u', 'origin', 'trunk'); run(checkout, 'remote', 'set-head', 'origin', '-a');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'proj_a', name: 'Shop', paths: { dev_a: checkout }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('a worktree is created outside the checkout from a private base fetch, and the owner checkout is untouched', async () => {
  const newer = upstream('upstream.txt'); run(origin, 'tag', 'v2', newer);
  const before = ownerState(); expect(run(checkout, 'rev-parse', 'refs/remotes/origin/trunk')).not.toBe(newer);
  const created = await worktrees.create(project, thread());
  expect(created).toEqual({ cwd: join(homes.root, 'worktrees', 'proj_a', 'thread_01K6XYZQ9M7RTP'), branch: 'jv/fix-login-9m7rtp', baseBranch: 'trunk', baseCommit: newer });
  expect(inside(checkout, created.cwd)).toBe(false); expect(realpathSync(run(created.cwd, 'rev-parse', '--show-toplevel'))).toBe(created.cwd);
  expect(run(created.cwd, 'rev-parse', 'HEAD')).toBe(newer); expect(run(created.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('jv/fix-login-9m7rtp');
  expect(fails(created.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(true);
  expect(run(checkout, 'rev-parse', 'refs/jevellan/threads/thread_01K6XYZQ9M7RTP/base')).toBe(newer);
  // HEAD, status, index, origin/trunk, FETCH_HEAD and tags are as before (D14, D143).
  expect(ownerState()).toEqual(before); expect(existsSync(join(checkout, 'upstream.txt'))).toBe(false);
  expect(await worktrees.exists(project, thread())).toBe(true);
  expect(parseWorktrees(run(checkout, 'worktree', 'list', '--porcelain', '-z')).map((entry) => entry.branch)).toEqual(['refs/heads/trunk', 'refs/heads/jv/fix-login-9m7rtp']);
});

test('create is idempotent: a reused worktree keeps its commits and base, and an interrupted add resumes on the branch', async () => {
  const first = await worktrees.create(project, thread());
  writeFileSync(join(first.cwd, 'login.ts'), 'fixed\n'); run(first.cwd, 'add', '-A'); run(first.cwd, 'commit', '-m', 'Fix login'); const work = run(first.cwd, 'rev-parse', 'HEAD');
  upstream('later.txt');
  const stored = thread({ cwd: first.cwd, branch: first.branch, baseBranch: first.baseBranch, baseCommit: first.baseCommit });
  expect(await worktrees.create(project, stored)).toEqual(first);
  expect(run(first.cwd, 'rev-parse', 'HEAD')).toBe(work); expect(run(checkout, 'rev-parse', 'refs/jevellan/threads/thread_01K6XYZQ9M7RTP/base')).toBe(first.baseCommit);
  // A crash after the branch existed but before the worktree was registered.
  run(checkout, 'worktree', 'remove', '--force', first.cwd); expect(existsSync(first.cwd)).toBe(false);
  expect(await worktrees.create(project, thread())).toEqual(first); expect(run(first.cwd, 'rev-parse', 'HEAD')).toBe(work);
  // A folder that vanished is pruned and recreated; an unregistered leftover folder is replaced.
  rmSync(first.cwd, { recursive: true, force: true }); expect(await worktrees.create(project, stored)).toEqual(first);
  run(checkout, 'worktree', 'remove', '--force', first.cwd); mkdirSync(first.cwd); writeFileSync(join(first.cwd, 'partial'), 'x');
  expect(await worktrees.create(project, stored)).toEqual(first); expect(existsSync(join(first.cwd, 'partial'))).toBe(false); expect(run(first.cwd, 'rev-parse', 'HEAD')).toBe(work);
  // A registered worktree on another branch is never reused silently.
  run(first.cwd, 'switch', '-c', 'elsewhere');
  await expect(worktrees.create(project, stored)).rejects.toThrow('The thread worktree is on another branch.');
});

test('cleanup removes the worktree, the local branch and the private refs but never the remote branch', async () => {
  const created = await worktrees.create(project, thread());
  writeFileSync(join(created.cwd, 'login.ts'), 'fixed\n'); run(created.cwd, 'add', '-A'); run(created.cwd, 'commit', '-m', 'Fix login');
  run(created.cwd, 'push', 'origin', `HEAD:refs/heads/${created.branch}`); run(checkout, 'update-ref', 'refs/jevellan/threads/thread_01K6XYZQ9M7RTP/pushed', 'HEAD');
  run(checkout, 'update-ref', 'refs/jevellan/threads/thread_01K6XYZQ9M7RTPX/base', 'HEAD');
  const before = ownerState(); const stored = thread({ cwd: created.cwd, branch: created.branch, baseBranch: created.baseBranch, baseCommit: created.baseCommit });
  await worktrees.remove(project, stored);
  expect(existsSync(created.cwd)).toBe(false); expect(run(checkout, 'worktree', 'list', '--porcelain')).not.toContain(created.cwd);
  expect(fails(checkout, 'rev-parse', '--verify', `refs/heads/${created.branch}`)).toBe(true);
  expect(run(checkout, 'for-each-ref', '--format=%(refname)', 'refs/jevellan/threads')).toBe('refs/jevellan/threads/thread_01K6XYZQ9M7RTPX/base');
  expect(run(origin, 'rev-parse', '--verify', `refs/heads/${created.branch}`)).toMatch(/^[0-9a-f]{40}$/);
  expect(ownerState()).toEqual(before); expect(await worktrees.exists(project, stored)).toBe(false);
  await worktrees.remove(project, stored);
  // A worktree whose folder vanished is pruned.
  const again = await worktrees.create(project, thread({ id: 'thread_01K6XYZQ9M7RTQ' })); rmSync(again.cwd, { recursive: true, force: true });
  await worktrees.remove(project, thread({ id: 'thread_01K6XYZQ9M7RTQ', branch: again.branch }));
  expect(run(checkout, 'worktree', 'list', '--porcelain')).not.toContain(again.cwd); expect(fails(checkout, 'rev-parse', '--verify', `refs/heads/${again.branch}`)).toBe(true);
});

test('an origin whose HEAD names main gives main, and a checkout without origin/HEAD falls back to main', async () => {
  const mainOrigin = join(root, 'main.git'); run(root, 'init', '--bare', '-b', 'main', mainOrigin); const clone = join(root, 'main-project'); run(root, 'clone', mainOrigin, clone);
  writeFileSync(join(clone, 'value.txt'), '1\n'); run(clone, 'add', '-A'); run(clone, 'commit', '-m', 'Seed'); run(clone, 'push', '-u', 'origin', 'main');
  expect(fails(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe(true); expect(await worktrees.baseBranch(clone)).toBe('main');
  run(clone, 'remote', 'set-head', 'origin', '-a'); expect(await worktrees.baseBranch(clone)).toBe('main');
  const created = await worktrees.create({ ...project, paths: { dev_a: clone } }, thread());
  expect(created).toMatchObject({ baseBranch: 'main', baseCommit: run(mainOrigin, 'rev-parse', 'main') });
});

test('without an origin the base is the local branch and stays local', async () => {
  run(checkout, 'remote', 'remove', 'origin'); const head = run(checkout, 'rev-parse', 'HEAD');
  expect(await git.remoteUrl(checkout)).toBeNull();
  const created = await worktrees.create(project, thread());
  expect(created).toMatchObject({ baseBranch: 'trunk', baseCommit: head }); expect(run(checkout, 'rev-parse', 'refs/jevellan/threads/thread_01K6XYZQ9M7RTP/base')).toBe(head);
});

test('context links are mirrored only when git ignores them in the worktree', async () => {
  symlinkSync('AGENTS.md', join(checkout, 'CLAUDE.md')); const status = ownerState().status; expect(status).toBe('?? CLAUDE.md');
  const unexcluded = await worktrees.create(project, thread());
  expect(unexcluded.contextNote).toBe(contextLinkSkipped('CLAUDE.md')); expect(existsSync(join(unexcluded.cwd, 'CLAUDE.md'))).toBe(false);
  writeFileSync(join(checkout, '.git', 'info', 'exclude'), '/CLAUDE.md\n'); const exclude = readFileSync(join(checkout, '.git', 'info', 'exclude'), 'utf8'); const before = ownerState();
  const linked = await worktrees.create(project, thread({ id: 'thread_01K6XYZQ9M7RTQ' }));
  expect(linked.contextNote).toBeUndefined(); expect(readlinkSync(join(linked.cwd, 'CLAUDE.md'))).toBe('AGENTS.md');
  expect(readFileSync(join(linked.cwd, 'CLAUDE.md'), 'utf8')).toBe('# Shop\n'); expect(run(linked.cwd, 'status', '--porcelain=v1')).toBe('');
  expect(ownerState()).toEqual(before); expect(readFileSync(join(checkout, '.git', 'info', 'exclude'), 'utf8')).toBe(exclude);
});

test('the setup command runs in the worktree with a Jevellan HOME and reports its first failing line', async () => {
  const created = await worktrees.create(project, thread()); const stored = thread({ cwd: created.cwd, branch: created.branch });
  const ledger = new ProjectLedgers(paths).thread('proj_a', stored.id); redactor.add('setup-secret-value');
  const ok = await worktrees.setup(stored, 'pwd; echo "$HOME"', ledger);
  expect(ok.ok).toBe(true);
  expect(ledger.read(ok.outputRef)).toEqual({ stdout: `${created.cwd}\n${homes.at('tmp', 'verification', stored.id)}\n`, stderr: '', timedOut: false });
  const failed = await worktrees.setup(stored, 'echo installing; echo "npm ERR! missing script: ci setup-secret-value" >&2; echo second >&2; exit 3', ledger);
  expect(failed).toMatchObject({ ok: false, reason: 'Worktree setup failed: npm ERR! missing script: ci [redacted]' });
  expect(JSON.stringify(ledger.read(failed.outputRef))).not.toContain('setup-secret-value');
  expect(await worktrees.setup(stored, 'echo only stdout; exit 2', ledger)).toMatchObject({ ok: false, reason: 'Worktree setup failed: only stdout' });
  expect(await worktrees.setup(stored, 'exit 4', ledger)).toMatchObject({ ok: false, reason: 'Worktree setup failed: exit code 4' });
  expect(await worktrees.setup(stored, 'sleep 5', ledger, { timeoutMs: 300 })).toMatchObject({ ok: false, reason: worktreeSetupFailed(commandTimedOut(300)) });
  expect(commandTimedOut(15 * 60_000)).toBe('the command timed out after 15 minutes.');
  await expect(worktrees.setup(thread(), 'true', ledger)).rejects.toThrow('The thread worktree is not ready.');
  const result = await runThreadCommand(created.cwd, 'printf out; printf err >&2; exit 1', { homes, workId: stored.id, timeoutMs: 10_000, redactor });
  expect(outputTail(result)).toBe('out\nerr'); expect(outputTail({ stdout: 'x'.repeat(5000), stderr: 'y' })).toBe(`${'x'.repeat(3998)}\ny`);
});

test('thread git reads identity and the raw origin url, and fetches only into private thread refs', async () => {
  expect(await git.identity(checkout)).toEqual({ name: 'Fixture', email: 'fixture@example.invalid' });
  run(checkout, 'config', '--unset', 'user.email'); const identity = await git.identity(checkout);
  expect(identity === undefined || identity.email !== '').toBe(true);
  run(checkout, 'config', 'remote.origin.url', 'https://github.com/owner/shop.git'); run(checkout, 'config', `url.${origin}.insteadOf`, 'https://github.com/owner/shop.git');
  expect(await git.remoteUrl(checkout)).toBe('https://github.com/owner/shop.git');
  expect(await git.fetchPrivate(checkout, 'trunk', 'refs/jevellan/threads/thread_x/base')).toBe(run(origin, 'rev-parse', 'trunk'));
  await expect(git.fetchPrivate(checkout, 'trunk', 'refs/heads/other')).rejects.toThrow('Thread fetches write only private thread refs.');
  await expect(git.fetchPrivate(checkout, 'missing', 'refs/jevellan/threads/thread_x/base')).rejects.toThrow(/^Git fetch failed \(128\)/);
  await expect(git.run(checkout, ['rev-parse', 'refs/heads/none'])).rejects.toThrow(/^Git rev-parse failed \(128\)/);
});
