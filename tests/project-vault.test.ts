import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, SecretRedactor } from '../packages/core/dist/index.js';
import { ProjectVault, vaultFolder } from '../packages/memory/dist/index.js';

// Two hubs share one vault remote: a local bare repository standing in for gongiskhan/jevellan-vault.
const URL = 'https://github.com/fixture/vault.git';
let root: string, bare: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-vault-')); mkdirSync(join(root, 'user')); bare = join(root, 'remote.git'); git(root, 'init', '--bare', '--quiet', '-b', 'main', bare); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function hub(name: string, token = 'vault-fixture-token-value') {
  const homes = new Homes(join(root, name), join(root, 'user')); homes.ensure();
  let reachable = true;
  const vault = new ProjectVault({ homes, deviceId: `dev_${name}`, redactor: new SecretRedactor(), now: Date.now, timers: false,
    remote: async () => reachable ? { url: URL, token } : { url: 'https://github.com/fixture/unreachable.git', token } });
  vault.ensure(); git(vault.root, 'config', `url.${bare}.insteadOf`, URL);
  const write = (path: string, text: string) => { const file = join(vault.root, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); git(vault.root, '-c', 'user.name=T', '-c', 'user.email=t@x', 'add', '--', path); git(vault.root, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '--quiet', '-m', `write ${path}`, '--', path); vault.changed(); };
  return { vault, homes, write, read: (path: string) => readFileSync(join(vault.root, path), 'utf8'), offline: () => { reachable = false; }, online: () => { reachable = true; } };
}

test('vault folders are keyed by GitHub origin, never by project id', () => {
  expect(vaultFolder('https://github.com/gongiskhan/ekoa-code.git')).toBe('gongiskhan__ekoa-code');
  expect(vaultFolder('git@github.com:gongiskhan/ekoa-code.git')).toBe('gongiskhan__ekoa-code');
  expect(vaultFolder('/srv/local/repo')).toBeNull(); expect(vaultFolder(undefined)).toBeNull();
});

test('two hubs push and pull through one remote; a note edited on both keeps both versions and nothing is lost', async () => {
  const a = hub('a'), b = hub('b');
  a.write('projects/fixture__repo/notes/Test conventions.md', '---\ntitle: Test conventions\n---\nRun the unit tests first.\n');
  await a.vault.sync(); expect(a.vault.status()).toMatchObject({ remote: URL, lastError: null, pending: false });
  await b.vault.sync();
  expect(b.read('projects/fixture__repo/notes/Test conventions.md')).toContain('Run the unit tests first.');
  // Both edit the same note before either pushes; each also writes a note of its own.
  a.write('projects/fixture__repo/notes/Test conventions.md', '---\ntitle: Test conventions\n---\nRun the unit tests first.\nThen the browser checks.\n');
  a.write('projects/fixture__repo/notes/From A.md', 'A only.\n');
  b.write('projects/fixture__repo/notes/Test conventions.md', '---\ntitle: Test conventions\n---\nRun the unit tests first.\nLint before pushing.\n');
  b.write('projects/fixture__repo/project.json', '{"schema":"vault-project-v1"}\n');
  await a.vault.sync(); await b.vault.sync(); await a.vault.sync();
  for (const side of [a, b]) {
    const note = side.read('projects/fixture__repo/notes/Test conventions.md');
    expect(note).toContain('Then the browser checks.'); expect(note).toContain('Lint before pushing.'); expect(note).toContain('status: unresolved');
    expect(note).toMatch(/## Merged from dev_b on \d{4}-\d{2}-\d{2}/u);
    expect(side.read('projects/fixture__repo/notes/From A.md')).toBe('A only.\n');
    expect(side.read('projects/fixture__repo/project.json')).toContain('vault-project-v1');
  }
  expect(git(a.vault.root, 'rev-parse', 'HEAD')).toBe(git(b.vault.root, 'rev-parse', 'HEAD'));
  expect(git(bare, 'rev-parse', 'main')).toBe(git(a.vault.root, 'rev-parse', 'HEAD'));
  // The token never reaches the repository configuration or the remote URL.
  expect(readFileSync(join(a.vault.root, '.git', 'config'), 'utf8')).not.toContain('vault-fixture-token-value');
});

test('an unreachable remote keeps the commits local, reports a redacted error and pushes them once it is back', async () => {
  const a = hub('a');
  a.write('projects/fixture__repo/notebook.md', 'Plan: tests first.\n');
  a.offline(); await a.vault.sync();
  const status = a.vault.status(); expect(status.pending).toBe(true); expect(status.lastError).toBeTruthy(); expect(status.lastError).not.toContain('vault-fixture-token-value');
  expect(existsSync(join(a.vault.root, 'projects/fixture__repo/notebook.md'))).toBe(true);
  a.online(); await a.vault.sync();
  expect(a.vault.status()).toMatchObject({ pending: false, lastError: null });
  expect(git(bare, 'show', 'main:projects/fixture__repo/notebook.md')).toBe('Plan: tests first.');
});

test('Undo still reverts a dream after a pull rebased its commit onto another hub\'s work', { timeout: 240_000 }, async () => {
  const { BasicMemory, HubMemoryStore, MemoryDream } = await import('../packages/memory/dist/index.js');
  const { ProjectSchema } = await import('../packages/core/dist/index.js');
  const a = hub('a'), b = hub('b'); await b.vault.sync();
  const redactor = new SecretRedactor(), manager = new BasicMemory(a.homes, 'basic-memory', redactor);
  const store = new HubMemoryStore(manager, 'hub', Date.now, { vault: a.vault, folder: () => 'fixture__repo' });
  manager.configureHub((definition, _device, scope) => store.project(definition, scope));
  try {
    const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project_a', name: 'Fixture', paths: {}, branchPolicy: 'external', remoteUrl: 'https://github.com/fixture/repo.git', memory: { mode: 'hub', dir: '.jevellan/memory' }, context: { state: 'none' } });
    const port = store.project(project, { kind: 'owner', provenance: { source: 'owner', runtime: 'owner', model: 'owner' } });
    const note = await port.write({ title: 'Kept note', content: 'Stays.' }, AbortSignal.timeout(120_000));
    await a.vault.sync();
    const dream = new MemoryDream(store), state = await dream.begin(project, 'a'.repeat(40), { source: 'dream', runtime: 'fake', model: 'fixture' }, 'apply');
    writeFileSync(join(dream.staging(state).path, 'Dream note.md'), '---\ntitle: Dream note\nsource: dream\nruntime: fake\nmodel: fixture\nstatus: active\n---\nLearned.\n');
    const applied = await dream.finish(project, 'One note.'); expect(applied.state).toBe('applied');
    // Another hub pushes first; this hub's pull rebases the unpushed dream commit onto it.
    await b.vault.sync(); b.write('projects/other__repo/notes/Elsewhere.md', 'Other project.\n'); await b.vault.sync();
    await a.vault.pull();
    expect(git(a.vault.root, 'log', '--format=%s', '-3')).toContain('dream:');
    expect((await dream.undo(project)).state).toBe('undone');
    expect(store.list(project.id).map(row => row.title)).toEqual(['Kept note']);
    expect(readFileSync(join(port.path, note.permalink), 'utf8')).toContain('Stays.');
    expect(readFileSync(join(a.vault.root, 'projects/other__repo/notes/Elsewhere.md'), 'utf8')).toBe('Other project.\n');
    await a.vault.sync(); expect(a.vault.status().lastError).toBeNull();
  } finally { await manager.close(); }
});
