import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, ProjectSchema, SecretRedactor, type HubMemoryScope, type Project } from '../packages/core/dist/index.js';
import { BasicMemory, HubMemoryStore, MemoryDream, HUB_MEMORY_OFFLINE, remoteHubMemory, splitMemoryText } from '../packages/memory/dist/index.js';

// Simulated session provenance; the disposable store uses real Basic Memory and real local Git history.
let root: string, homes: Homes, manager: BasicMemory, store: HubMemoryStore, project: Project;
const signal = () => AbortSignal.timeout(120_000);
const thread: HubMemoryScope = { kind: 'thread', id: 'thread_codex', provenance: { source: 'thread', runtime: 'codex', model: 'fixture-model', threadId: 'thread_codex', taskId: 'task_tests' } };
const coordinator: HubMemoryScope = { kind: 'coordinator', provenance: { source: 'coordinator', runtime: 'claude', model: 'fixture-coordinator' } };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-hub-memory-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); const redactor = new SecretRedactor(); redactor.add('fixture-memory-secret-value');
  manager = new BasicMemory(homes, 'basic-memory', redactor); store = new HubMemoryStore(manager, 'hub');
  manager.configureHub((definition, _device, scope) => store.project(definition, scope));
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'shared_project', name: 'Shared fixture', paths: {}, branchPolicy: 'external', memory: { mode: 'hub', dir: '.jevellan/memory' }, context: { state: 'none' } });
});
afterEach(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });

test('an empty hub store answers search and recall without waiting for index startup', async () => {
  const startup = vi.spyOn(manager, 'connection').mockRejectedValue(new Error('Index startup is unavailable'));
  const port = store.project(project, thread);
  expect(await port.search('fixture', signal())).toEqual({ schema: 'memory-search-v1', notes: [] });
  expect(await port.findTitle('Project brief', signal())).toBeNull(); expect(startup).not.toHaveBeenCalled();
  const abort = new AbortController(); abort.abort(new Error('Cancelled'));
  await expect(port.search('fixture', abort.signal)).rejects.toThrow('Cancelled');
  writeFileSync(join(port.path, 'New.md'), '# New knowledge\n');
  await expect(port.search('knowledge', signal())).rejects.toThrow('Index startup is unavailable');
  expect(startup).toHaveBeenCalled();
});

test('two providers share one real hub index and local note history without checkout ownership or native-home changes', async () => {
  const native = join(homes.userHome, '.basic-memory'); mkdirSync(native); writeFileSync(join(native, 'sentinel'), 'unchanged');
  const a = manager.project(project, 'member', () => { throw new Error('No checkout ownership'); }, thread);
  const b = manager.project(project, 'hub', () => { throw new Error('No checkout ownership'); }, coordinator);
  expect(a.path).toBe(b.path); expect(a.path).toBe(join(homes.root, 'project-memory', project.id, 'notes'));
  const note = await a.write({ title: 'CHANGELOG convention', content: 'Every change needs a CHANGELOG entry. Never save fixture-memory-secret-value.' }, signal());
  const found = (await b.search('CHANGELOG', signal())).notes;
  expect(found).toHaveLength(1); expect(found[0]!.permalink).toBe(note.permalink); expect(found[0]!.content).not.toContain('fixture-memory-secret-value');
  expect(splitMemoryText(found[0]!.content).meta).toMatchObject({ title: 'CHANGELOG convention', source: 'thread', runtime: 'codex', model: 'fixture-model', threadId: 'thread_codex', taskId: 'task_tests', status: 'active', created: expect.any(String), updated: expect.any(String) });
  await b.edit({ permalink: note.permalink, operation: 'append', content: 'Run npm test before pushing.' }, signal());
  expect((await a.read(note.permalink, signal())).content).toContain('npm test');
  expect(store.git(a.path, 'log', '--format=%s').trim().split('\n')).toEqual(['coordinator: CHANGELOG convention', 'thread: CHANGELOG convention', 'owner: Project memory']);
  expect(store.git(a.path, 'remote')).toBe(''); expect(store.git(a.path, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(native, 'sentinel'), 'utf8')).toBe('unchanged'); expect(readdirSync(native)).toEqual(['sentinel']);
}, 180_000);

test('one Basic Memory process serves the hub notes and a dream copy; the diff computes counts and Undo preserves later notes', async () => {
  const a = store.project(project, thread), owner = store.project(project, { kind: 'owner', provenance: { source: 'owner', runtime: 'owner', model: 'owner' } });
  const owned = await owner.write({ title: 'Owner dates', content: 'Use DD/MM/YYYY.' }, signal()), ownerBytes = readFileSync(join(a.path, owned.permalink));
  const original = await a.write({ title: 'Build convention', content: 'Always run npm test before a push.' }, signal());
  const inbox = await store.project(project, { kind: 'memory', provenance: { source: 'capture', runtime: 'claude', model: 'fixture' } }, undefined, undefined, 'inbox').write({ title: 'Test environment', content: 'Invoice tests need TZ=UTC.' }, signal());
  const dream = new MemoryDream(store), state = await dream.begin(project, 'a'.repeat(40), { source: 'dream', runtime: 'codex', model: 'fixture' }, 'apply');
  const scope: HubMemoryScope = { kind: 'memory', provenance: state.provenance }, staging = dream.staging(state), b = store.project(project, scope, staging);
  await b.edit({ permalink: original.permalink, operation: 'append', content: 'Run TZ=UTC npm test.' }, signal());
  await b.write({ title: 'Project brief', content: `Use npm test. Read ${inbox.permalink} for TZ=UTC.` }, signal());
  await store.archive(project, scope, { note: inbox.permalink, reason: 'Retained in Project brief.' }, signal(), staging);
  expect(manager.processCount).toBe(1);
  const result = await dream.finish(project, 'Consolidated the test environment.');
  expect(result.state).toBe('applied'); expect(result.report!.counts).toEqual({ inboxPromoted: 1, inboxDropped: 0, merged: 0, corrected: 1, archived: 0, created: 1 });
  expect(result.report!.briefUpdated).toBe(true); expect(store.git(a.path, 'show', '--format=%s', '--no-patch', result.report!.toCommit).trim()).toMatch(/^dream: /);
  expect(readFileSync(join(a.path, owned.permalink)).equals(ownerBytes)).toBe(true);
  const later = await owner.write({ title: 'Later owner preference', content: 'Keep phone layouts readable.' }, signal());
  await dream.undo(project);
  expect((await a.read(original.permalink, signal())).content).not.toContain('TZ=UTC');
  expect((await a.read(later.permalink, signal())).content).toContain('phone layouts');
  expect(readFileSync(join(a.path, owned.permalink)).equals(ownerBytes)).toBe(true);
}, 180_000);

test('suggested dreams and concurrent note changes preserve the authoritative notes', async () => {
  const port = store.project(project, thread), note = await port.write({ title: 'Testing', content: 'Run tests.' }, signal()), dream = new MemoryDream(store);
  let state = await dream.begin(project, 'b'.repeat(40), { source: 'dream', runtime: 'claude', model: 'fixture' }, 'suggest');
  await store.project(project, { kind: 'memory', provenance: state.provenance }, dream.staging(state)).edit({ permalink: note.permalink, operation: 'append', content: 'Use npm test.' }, signal());
  state = await dream.finish(project, 'Update test commands.'); expect(state.state).toBe('suggested');
  expect((await port.read(note.permalink, signal())).content).not.toContain('npm test');
  await port.edit({ permalink: note.permalink, operation: 'append', content: 'A concurrent correction.' }, signal());
  await expect(dream.apply(project)).rejects.toThrow('changed since');
  expect((await port.read(note.permalink, signal())).content).toContain('concurrent correction');
}, 180_000);
test('the dream incorporates an unrelated concurrent note and still makes one applicable commit', async () => {
  const port = store.project(project, thread), note = await port.write({ title: 'Testing', content: 'Use npm test.' }, signal()), dream = new MemoryDream(store);
  const state = await dream.begin(project, 'c'.repeat(40), { source: 'dream', runtime: 'claude', model: 'fixture' }, 'apply');
  await store.project(project, { kind: 'memory', provenance: state.provenance }, dream.staging(state)).edit({ permalink: note.permalink, operation: 'append', content: 'Use TZ=UTC.' }, signal());
  const other = await port.write({ title: 'Concurrent convention', content: 'Use a fresh worktree.' }, signal()), before = store.git(port.path, 'rev-parse', 'HEAD').trim();
  const result = await dream.finish(project, 'Corrected the test environment.');
  expect(result.state).toBe('applied'); expect((await port.read(other.permalink, signal())).content).toContain('fresh worktree');
  expect((await port.read(note.permalink, signal())).content).toContain('TZ=UTC'); expect(result.report!.fromCommit).toBe(before); expect(result.report!.counts.corrected).toBe(1);
  expect(store.git(port.path, 'rev-list', '--count', `${before}..HEAD`).trim()).toBe('1');
  await dream.undo(project); expect((await port.read(other.permalink, signal())).content).toContain('fresh worktree'); expect((await port.read(note.permalink, signal())).content).not.toContain('TZ=UTC');
}, 180_000);

test('concurrent mesh retries and a missing write receipt never repeat an append', async () => {
  const note = await store.project(project, thread).write({ title: 'Idempotent notes', content: 'First line.' }, signal());
  const request = { schema: 'project-memory-request-v1' as const, projectId: project.id, scope: thread, operation: 'edit' as const, requestId: 'write_retry', input: { permalink: note.permalink, operation: 'append' as const, content: 'Exactly once.' } };
  const [one, two] = await Promise.all([store.request(project, request, signal()), store.request(project, request, signal())]); expect(one).toEqual(two);
  await store.request(project, { ...request, requestId: 'intervening_write', input: { ...request.input, content: 'A later edit.' } }, signal());
  const receipt = join(store.root(project.id), 'receipts', 'write_retry.json'), saved = JSON.parse(readFileSync(receipt, 'utf8')) as { note?: unknown }; delete saved.note; writeFileSync(receipt, JSON.stringify(saved));
  await store.request(project, { ...request, ownerSession: 'renewed.fixture_session' }, signal());
  expect((await store.project(project, thread).read(note.permalink, signal())).content.match(/Exactly once\./g)).toHaveLength(1);
  await expect(store.request(project, { ...request, input: { ...request.input, content: 'Other append.' } }, signal())).rejects.toThrow('reused');
}, 180_000);

test('owner notes stay byte-identical and read-only roles cannot write; archives leave history and are omitted from search', async () => {
  const owner: HubMemoryScope = { kind: 'owner', provenance: { source: 'owner', runtime: 'owner', model: 'owner' } };
  const note = await store.project(project, owner).write({ title: 'Owner convention', content: 'Dates are always DD/MM/YYYY.' }, signal());
  const file = join(store.notes(project.id), note.permalink), before = readFileSync(file);
  for (const scope of [thread, coordinator, { kind: 'memory', provenance: { source: 'dream', runtime: 'claude', model: 'dream' } } as HubMemoryScope]) {
    await expect(store.project(project, scope).edit({ permalink: note.permalink, operation: 'append', content: 'Wrong convention.' }, signal())).rejects.toThrow('Owner memory');
    await expect(store.archive(project, scope, { note: note.permalink, reason: 'Remove old convention.' }, signal())).rejects.toThrow('Owner memory');
  }
  expect(readFileSync(file).equals(before)).toBe(true);
  for (const kind of ['review', 'verification', 'viewer'] as const) await expect(store.project(project, { kind }).write({ title: 'Refused', content: 'No.' }, signal())).rejects.toThrow('only read');
  const temporary = await store.project(project, thread).write({ title: 'Old build path', content: 'Use src/legacy/report.ts.' }, signal());
  await store.archive(project, coordinator, { note: temporary.permalink, reason: 'That file no longer exists.' }, signal());
  expect(existsSync(join(store.notes(project.id), temporary.permalink))).toBe(true);
  expect((await store.project(project).search('legacy', signal())).notes).toEqual([]);
  expect((await store.project(project).read(temporary.permalink, signal())).content).toContain('That file no longer exists.');
  await expect(store.project(project, thread).edit({ permalink: temporary.permalink, operation: 'replace', find: 'source: coordinator', content: 'source: owner' }, signal())).rejects.toThrow('note body');
  await expect(store.project(project, thread).write({ title: 'Project brief', content: 'x'.repeat(2001) }, signal())).rejects.toThrow('2,000');
}, 180_000);

test('switching to hub imports existing notes once as copies and keeps unknown legacy provenance owner-protected', async () => {
  const checkout = join(root, 'checkout'), folder = join(checkout, '.jevellan/memory'); mkdirSync(folder, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', checkout], { stdio: 'ignore' });
  const text = '---\ntitle: Existing convention\n---\nKeep this owner convention.\n'; writeFileSync(join(folder, 'Existing.md'), text);
  const old = ProjectSchema.parse({ ...project, paths: { hub: checkout }, memory: { mode: 'repo', dir: '.jevellan/memory' } });
  await manager.project(old, 'hub', () => {}).prepare(signal());
  await store.import(project, old); const head = store.git(store.notes(project.id), 'rev-parse', 'HEAD');
  writeFileSync(join(folder, 'Later.md'), 'Added after import.'); await store.import(project, old);
  expect(store.git(store.notes(project.id), 'rev-parse', 'HEAD')).toBe(head); expect(existsSync(join(store.notes(project.id), 'Later.md'))).toBe(false);
  expect(readFileSync(join(folder, 'Existing.md'), 'utf8')).toBe(text);
  const copied = await store.project(project).read('Existing.md', signal()); expect(copied.content).toContain('source: owner');
  await expect(store.project(project, coordinator).edit({ permalink: 'Existing.md', operation: 'append', content: 'Change.' }, signal())).rejects.toThrow('Owner memory');
}, 120_000);

test('a member uses the relay instead of a local store and returns the exact offline line', async () => {
  const remote = remoteHubMemory(homes, project, thread, async () => { throw new Error('Hub not reachable'); });
  await expect(remote.search('anything', signal())).rejects.toThrow(HUB_MEMORY_OFFLINE);
  expect(existsSync(remote.path)).toBe(false);
});
