import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Homes, ProjectSchema, SecretRedactor, groupAlive, type NativeProcess, type Project } from '../packages/core/dist/index.js';
import { BasicMemory, OwnedMemoryTransport, memoryEnvironment } from '../packages/memory/dist/index.js';
import { recallBySearchRank } from '../packages/conversations/dist/index.js';

let root: string; let homes: Homes; let memory: BasicMemory;
const natives: NativeProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-memory-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); memory = new BasicMemory(homes);
  const original = OwnedMemoryTransport.prototype.start;
  vi.spyOn(OwnedMemoryTransport.prototype, 'start').mockImplementation(async function (this: OwnedMemoryTransport) { await original.call(this); if (this.native) natives.push(this.native); });
});
afterEach(async () => {
  await memory.close(); for (const native of natives.splice(0)) expect(groupAlive(native.pgid)).toBe(false);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});
function project(id: string, mode: 'repo' | 'device' = 'repo'): Project {
  const path = join(root, id); mkdirSync(path); execFileSync('git', ['init', '--initial-branch=main', path], { stdio: 'ignore' });
  return ProjectSchema.parse({ schema: 'project-v1', id, name: id, paths: { device: path }, branchPolicy: mode === 'repo' ? 'main' : 'external', memory: { mode, dir: '.jevellan/memory' }, context: { state: 'none' } });
}
const signal = () => new AbortController().signal;
const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)).map((name) => `${entry.name}/${name}`) : [entry.name]);

test('isolated memory environment disables self-updates, frontmatter rewrites and inherited credentials', () => {
  vi.stubEnv('JEVELLAN_TEST_JEV_KEY', 'fixture-credential'); vi.stubEnv('BASIC_MEMORY_FORCE_CLOUD', 'true');
  const env = memoryEnvironment(homes);
  expect(env.HOME).toBe(homes.at('basic-memory', 'home')); expect(env.BASIC_MEMORY_CONFIG_DIR).toBe(homes.at('basic-memory'));
  expect(env.BASIC_MEMORY_AUTO_UPDATE).toBe('false'); expect(env.BASIC_MEMORY_FORCE_LOCAL).toBe('true');
  expect(env.BASIC_MEMORY_EXPLICIT_ROUTING).toBe('true');
  expect(env.BASIC_MEMORY_FORCE_CLOUD).toBeUndefined(); expect(env.JEVELLAN_TEST_JEV_KEY).toBeUndefined();
  expect(env.BASIC_MEMORY_ENSURE_FRONTMATTER_ON_SYNC).toBe('false');
});

test('memory rejects escaped paths and symlinks, and an empty read never creates the memory folder', async () => {
  const definition = project('path_checks'); const owned = vi.fn(); const bound = memory.project(definition, 'device', owned);
  expect(await bound.search('anything', signal())).toEqual({ schema: 'memory-search-v1', notes: [] });
  expect(existsSync(bound.path)).toBe(false); expect(owned).not.toHaveBeenCalled();
  expect(() => memory.project({ ...definition, memory: { mode: 'repo', dir: '../outside' } }, 'device', owned).path).toThrow('confined relative path');
  mkdirSync(join(definition.paths.device!, '.jevellan')); symlinkSync(root, join(definition.paths.device!, '.jevellan/memory'));
  expect(() => bound.path).toThrow('inside the checkout');
});

test('real Basic Memory keeps two projects isolated, preserves disk files on sync and edits the exact note', async () => {
  const native = join(homes.userHome, '.basic-memory'); mkdirSync(native); writeFileSync(join(native, 'sentinel'), 'untouched');
  const a = project('project_a'); const b = project('project_b');
  const owner = vi.fn(); const first = memory.project(a, 'device', owner); const second = memory.project(b, 'device', owner);
  const notes = await Promise.all([
    first.write({ title: 'Vitest convention', content: 'Only project A uses Vitest globals.' }, signal()),
    second.write({ title: 'Different convention', content: 'Only project B uses a private fixture marker.' }, signal()),
  ]);
  expect(notes[0]?.content).toContain('project A'); expect(notes[1]?.content).toContain('project B');
  expect((await first.search('Vitest', signal())).notes.map((note) => note.title)).toEqual(['Vitest convention']);
  expect((await second.search('Vitest', signal())).notes).toEqual([]);
  expect((await first.findTitle('Vitest convention', signal()))?.permalink).toBe(notes[0]!.permalink);
  expect(await first.findTitle('Vitest', signal())).toBeNull(); expect(await second.findTitle('Vitest convention', signal())).toBeNull();
  await expect(second.read(notes[0]!.permalink, signal())).rejects.toThrow();
  const updated = await first.edit({ permalink: notes[0]!.permalink, operation: 'append', content: '\nKeep the public signature.' }, signal());
  expect(updated.content).toContain('public signature'); expect(files(first.path).filter((name) => name.endsWith('.md'))).toHaveLength(1);
  expect((await recallBySearchRank(first, { request: 'Can you add another Vitest test?', latestMessage: 'Preserve the public signature.', action: 'test' }, signal())).chosen).toEqual([notes[0]!.permalink]);
  await expect(first.edit({ permalink: notes[0]!.permalink, operation: 'replace', find: 'absent text', content: 'replacement' }, signal())).rejects.toThrow();
  await expect(first.read('Vitest', signal())).rejects.toThrow();
  const imported = join(first.path, 'Imported.md'); const raw = '---\ntitle: Imported\nstatus: unresolved\n---\nPulled from another checkout.\n'; writeFileSync(imported, raw);
  const modified = new Date('2026-09-20T12:00:00.000Z'); utimesSync(imported, modified, modified);
  await first.sync(); expect(readFileSync(imported, 'utf8')).toBe(raw);
  expect(await first.read('Imported.md', signal())).toMatchObject({ unresolved: true, updatedAt: modified.toISOString() });
  expect((await first.search('Pulled', signal())).notes[0]).toMatchObject({ title: 'Imported', updatedAt: modified.toISOString() });
  expect(readFileSync(imported, 'utf8')).toBe(raw);
  expect(files(first.path).some((name) => /\.db(?:-|$)|\.sqlite/.test(name))).toBe(false);
  expect(files(homes.at('basic-memory')).some((name) => name.endsWith('.db'))).toBe(true);
  expect(owner).toHaveBeenCalled(); expect(readFileSync(join(native, 'sentinel'), 'utf8')).toBe('untouched'); expect(readdirSync(native)).toEqual(['sentinel']);
}, 120_000);

test('device memory is excluded locally, checks ownership and redacts before writing a real note', async () => {
  const definition = project('external', 'device'); let owned = false;
  const redactor = new SecretRedactor(); const secret = ['fixture', 'memory', 'credential'].join('-'); redactor.add(secret);
  await memory.close(); memory = new BasicMemory(homes, 'basic-memory', redactor);
  const bound = memory.project(definition, 'device', () => { if (!owned) throw new Error('This work does not own the checkout.'); });
  await expect(bound.write({ title: 'Private rule', content: 'Remember this.' }, signal())).rejects.toThrow('does not own'); expect(existsSync(bound.path)).toBe(false);
  owned = true; const note = await bound.write({ title: 'Private rule', content: `Never persist ${secret}.` }, signal());
  expect(note.content).toContain('[redacted]'); expect(note.content).not.toContain(secret);
  expect(execFileSync('git', ['-C', definition.paths.device!, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  const exclude = readFileSync(join(definition.paths.device!, '.git/info/exclude'), 'utf8'); expect(exclude).toContain('/.jevellan/memory/');
  await bound.prepare(); expect(readFileSync(join(definition.paths.device!, '.git/info/exclude'), 'utf8')).toBe(exclude);
}, 90_000);

test('an already-open memory index recalls notes pulled from another checkout without changing tracked files', async () => {
  const source = project('source'); const sourcePath = source.paths.device!;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(sourcePath, 'config', 'user.name', 'Fixture'); git(sourcePath, 'config', 'user.email', 'fixture@example.invalid');
  const folder = join(sourcePath, '.jevellan/memory'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'Existing.md'), '---\ntitle: Existing convention\n---\nPreserve the existing project behavior.\n');
  git(sourcePath, 'add', '-A'); git(sourcePath, 'commit', '-m', 'Seed memory fixture');
  const targetPath = join(root, 'target'); git(root, 'clone', sourcePath, targetPath);
  const target = ProjectSchema.parse({ ...source, id: 'target', paths: { device: targetPath } });
  const bound = memory.project(target, 'device', () => { throw new Error('This reader has no checkout ownership.'); });
  expect((await bound.search('existing', signal())).notes).toHaveLength(1);
  expect((await bound.search('Vitest', signal())).notes).toEqual([]);
  const content = '---\ntitle: Vitest globals convention\n---\nThis project uses Vitest with globals enabled.\n';
  writeFileSync(join(folder, 'Vitest.md'), content); git(sourcePath, 'add', '-A'); git(sourcePath, 'commit', '-m', 'Remember Vitest globals');
  git(targetPath, 'pull', '--ff-only'); const head = git(targetPath, 'rev-parse', 'HEAD');
  const recalled = await recallBySearchRank(bound, { request: 'Write a Vitest test.', latestMessage: '', action: 'reply' }, signal());
  expect(recalled.chosen).toContain('Vitest.md'); expect(recalled.excerpts.some(note => note.excerpt.includes('globals enabled'))).toBe(true);
  expect(readFileSync(join(targetPath, '.jevellan/memory/Vitest.md'), 'utf8')).toBe(content);
  expect(git(targetPath, 'rev-parse', 'HEAD')).toBe(head); expect(git(targetPath, 'status', '--porcelain')).toBe('');
}, 90_000);

test('a provider write followed by a revert on disk still reindexes, although unchanged folders skip the provider sync', async () => {
  const bound = memory.project(project('skip'), 'device', () => undefined); const folder = join(root, 'skip', '.jevellan/memory');
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'Base.md'), '---\ntitle: Base rule\n---\nKeep the base rule.\n');
  expect((await bound.search('base', signal())).notes).toHaveLength(1);
  expect((await bound.search('base', signal())).notes).toHaveLength(1);
  const written = await bound.write({ title: 'Temporary rule', content: 'A rule that git later removes.' }, signal());
  expect((await bound.search('temporary', signal())).notes.map(note => note.permalink)).toEqual([written.permalink]);
  // Undo removes the file, returning the folder to the last synced contents; the index must still drop the note.
  const file = readdirSync(folder).find(name => name !== 'Base.md')!; await rm(join(folder, file));
  expect((await bound.search('temporary', signal())).notes).toEqual([]);
  expect((await bound.search('base', signal())).notes).toHaveLength(1);
}, 180_000);
