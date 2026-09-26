import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckoutOwnership, GitSettings, GitWorkspace, Homes, ProjectSchema, gitFailureMessage, type Project } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let settings: GitSettings; let project: Project; let origin: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-git-settings-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); settings = new GitSettings(homes);
  origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin);
  const path = join(root, 'checkout'); git(root, 'clone', origin, path);
  git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(path, 'file.txt'), 'one'); git(path, 'add', '.'); git(path, 'commit', '-m', 'Seed'); git(path, 'push', 'origin', 'main');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Fixture', paths: { device: path }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

test('Git preferences persist only in the isolated home and reject stale saves', () => {
  const initial = settings.get(); expect(initial.githubTransport).toBe('machine');
  const native = join(homes.userHome, '.gitconfig'); writeFileSync(native, '[user]\nname = Native\n');
  const saved = settings.save({ ...initial, githubTransport: 'ssh' });
  expect(new GitSettings(homes).get()).toEqual(saved);
  expect(() => settings.save(initial)).toThrow('changed');
  expect(readFileSync(native, 'utf8')).toBe('[user]\nname = Native\n');
  expect(() => settings.save({ ...saved, token: 'not-supported' })).toThrow();
});

test('connection checks inspect a local remote without changing refs or files', async () => {
  const path = project.paths.device!; const config = readFileSync(join(path, '.git/config'), 'utf8'); const refs = git(path, 'show-ref');
  const result = await settings.check(project, 'device'); expect(result).toMatchObject({ status: 'ready', transport: 'other', remote: origin });
  expect(git(path, 'show-ref')).toBe(refs); expect(readFileSync(join(path, '.git/config'), 'utf8')).toBe(config); expect(git(path, 'status', '--porcelain')).toBe('');
  git(path, 'remote', 'remove', 'origin'); expect(await settings.check(project, 'device')).toMatchObject({ status: 'local', transport: 'none' });
});

test('SSH selection bypasses a broken HTTPS helper for checks, snapshots and fetch without changing the remote', async () => {
  const path = project.paths.device!; git(path, 'remote', 'set-url', 'origin', 'https://github.com/example/repository.git');
  git(path, 'config', 'credential.helper', '!exit 1');
  const config = readFileSync(join(path, '.git/config'), 'utf8');
  const bin = join(root, 'bin'); mkdirSync(bin);
  // The SSH transport is simulated; Git upload-pack/fetch operate on a real local repository.
  writeFileSync(join(bin, 'ssh'), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nif(process.argv.includes('-G')) process.exit(0);\nif(!process.argv.at(-1).startsWith('git-upload-pack ')) process.exit(1);\nconst r=spawnSync('git',['upload-pack',${JSON.stringify(origin)}],{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o700 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  settings.save({ ...settings.get(), githubTransport: 'ssh' });
  expect(await settings.check(project, 'device')).toMatchObject({ status: 'ready', transport: 'ssh', remote: 'git@github.com:example/repository.git' });
  const db = new HubDatabase(homes, 'hub');
  try {
    const ownership = new CheckoutOwnership(db, homes, 'device'); const owner = { conversationId: 'conversation', conversationTitle: 'Fixture', workId: 'work' };
    await ownership.acquire(project, owner); const workspace = new GitWorkspace(project, 'device', ownership, owner);
    expect(await workspace.remoteHead()).toBe(git(origin, 'rev-parse', 'main')); await workspace.prepare();
    expect((await workspace.snapshot()).clean).toBe(true);
  } finally { db.close(); }
  expect(readFileSync(join(path, '.git/config'), 'utf8')).toBe(config);
  expect(git(path, 'remote', 'get-url', 'origin')).toBe('https://github.com/example/repository.git');
  settings.save({ ...settings.get(), githubTransport: 'machine' }); expect(settings.environment()).not.toHaveProperty('GIT_CONFIG_COUNT');
});

test('credentials in remote URLs are rejected and authentication failures name the recovery setting', async () => {
  git(project.paths.device!, 'remote', 'set-url', 'origin', 'https://user:fixture-password@github.com/example/repository.git');
  await expect(settings.check(project, 'device')).rejects.toThrow('Remove credentials');
  expect(gitFailureMessage("failed to get: -25308 fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toContain('Settings → Git');
  expect(gitFailureMessage('Permission denied (publickey).')).toContain('Settings → Git');
  expect(gitFailureMessage('Could not resolve host')).toBe('Could not resolve host');
});
