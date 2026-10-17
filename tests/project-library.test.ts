import { afterEach, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThreadCreatedViewSchema, LIBRARY_FILE_LIMIT, LIBRARY_QUOTA, LibraryListSchema, ProjectLibraryItemSchema, RiggingStore } from '../packages/core/dist/index.js';
import { libraryTool } from '../packages/projects/dist/bridge-tools.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture, type ProjectMember } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined, member: ProjectMember | undefined;
afterEach(async () => { member = undefined; await fixture?.close(); fixture = undefined; });
const upload = (name: string, bytes = 'hello', mime = 'text/plain') => fixture!.app.library.upload(fixture!.project.id, { name, size: Buffer.byteLength(bytes), mime, source: 'owner' }, Readable.from([bytes]));
test('library uploads stream, sanitize names, serialize collisions and delete with metadata', async () => {
  const f = fixture = await projectFixture();
  const [first, second] = await Promise.all([upload('same?.txt'), upload('same?.txt', 'world')]);
  expect(first.name).toBe('same-.txt'); expect(second.name).toBe('same- (2).txt');
  expect(first.sha256).toBe(createHash('sha256').update('hello').digest('hex'));
  expect(readFileSync((await f.app.library.get(f.project.id, first.id)).localPath, 'utf8')).toBe('hello');
  const page = await f.json(`/api/projects/${f.project.id}/library`, LibraryListSchema); expect(page.items).toHaveLength(2);
  const content = await f.request(`/api/projects/${f.project.id}/library/${first.id}/content`); expect(await content.text()).toBe('hello'); expect(content.headers.get('content-length')).toBe('5');
  expect((await fetch(`${f.base}/api/projects/${f.project.id}/library`)).status).toBe(401);
  await f.app.library.remove(f.project.id, first.id); expect(existsSync(join(f.app.library.directory(f.project.id), first.path))).toBe(false); expect(await f.app.library.list(f.project.id)).toHaveLength(1);
  expect(f.app.hub.get('project-library', first.id, ProjectLibraryItemSchema)?.document.deletedAt).toBeTruthy();
});
test('upload limits, byte mismatch, quota and owner HTTP headers are enforced', async () => {
  const f = fixture = await projectFixture(), library = f.app.library;
  await expect(library.upload(f.project.id, { name: 'large', size: LIBRARY_FILE_LIMIT + 1, mime: 'text/plain', source: 'owner' }, Readable.from([]))).rejects.toThrow('Files up to 50 MB.');
  await expect(library.upload(f.project.id, { name: 'short', size: 4, mime: 'text/plain', source: 'owner' }, Readable.from(['x']))).rejects.toThrow('whole file');
  expect(await library.list(f.project.id)).toEqual([]);
  const item = await upload('seed'); for (let index = 0; index < Math.ceil(LIBRARY_QUOTA / LIBRARY_FILE_LIMIT); index++) f.app.hub.put('project-library', `quota_${index}`, ProjectLibraryItemSchema, { ...item, id: `quota_${index}`, size: LIBRARY_FILE_LIMIT }, 0);
  await expect(upload('full')).rejects.toThrow("This project's library is full (2 GB). Delete files to add more.");
  const response = await fetch(`${f.base}/api/projects/${f.project.id}/library/uploads/file.txt`, { method: 'PUT', body: 'hello', headers: { Cookie: f.cookie, Origin: f.base, 'Content-Type': 'text/plain' } }); expect(response.status).toBe(413);
});
test('member transfers are authenticated, hash checked and mirrored read-only, including paths with spaces', async () => {
  const f = fixture = await projectFixture(); member = await projectMember(f); const m = member;
  const first = await upload('screen one.txt');
  await m.app.library.prepare(f.project.id, `Attached file: library/${first.path} (text/plain, 5 B)`);
  const local = (await m.app.library.get(f.project.id, first.id)).localPath;
  expect(readFileSync(local, 'utf8')).toBe('hello'); expect(statSync(local).mode & 0o222).toBe(0); expect(statSync(join(m.homes.root, 'library', f.project.id)).mode & 0o222).toBe(0);
  chmodSync(local, 0o600); chmodSync(join(m.homes.root, 'library', f.project.id), 0o700); await m.app.library.get(f.project.id, first.id);
  expect(statSync(local).mode & 0o222).toBe(0); expect(statSync(join(m.homes.root, 'library', f.project.id)).mode & 0o222).toBe(0);
  const second = await upload('another.txt'); expect(readFileSync((await m.app.library.get(f.project.id, second.id)).localPath, 'utf8')).toBe('hello');
  const response = await fetch(`${m.base}/api/projects/${f.project.id}/library/uploads/via-member.txt`, { method: 'PUT', body: 'from member', headers: { Cookie: m.cookie, Origin: m.base, 'Content-Type': 'text/plain' } });
  expect(response.status).toBe(200); const saved = ProjectLibraryItemSchema.parse(await response.json()); expect((await f.app.library.list(f.project.id)).some(item => item.id === saved.id)).toBe(true);
  const forbidden = await f.request(`/hub/mesh/library/${f.project.id}/${first.id}`, 'DELETE'); expect(forbidden.status).toBe(403);
  // Corrupt the transferred bytes without changing the metadata hash.
  const third = await upload('corrupt.txt'); writeFileSync(join(f.app.library.directory(f.project.id), third.path), 'wrong');
  await expect(m.app.library.get(f.project.id, third.id)).rejects.toThrow('hash check');
});
test('thread output confinement and library scopes share the existing sensitive-file guard', async () => {
  const f = fixture = await projectFixture(), cwd = join(f.root, 'output'); mkdirSync(cwd); writeFileSync(join(cwd, 'report.md'), 'report'); writeFileSync(join(cwd, '.env.local'), 'secret'); symlinkSync(f.checkout, join(cwd, 'outside'));
  const item = await f.app.library.add(f.project.id, 'thread_output', cwd, { path: 'report.md', note: 'A report' }); expect(item.path).toBe('outputs/thread_output/report.md');
  for (const path of ['../escape', '.env.local', 'outside/README.md', join(cwd, 'report.md')]) await expect(f.app.library.add(f.project.id, 'thread_output', cwd, { path })).rejects.toThrow();
  const scope = { kind: 'coordinator' as const, projectId: f.project.id, turn: 1 };
  await expect(libraryTool(f.app.library, scope, 'jevellan_library_add', { path: 'report.md' }, cwd)).rejects.toThrow('only read');
  expect(await libraryTool(f.app.library, scope, 'jevellan_library_list', { query: 'report' })).toMatchObject({ items: [{ id: item.id }] });
});
test('rigging scope round-trips and absent or empty means every project', async () => {
  const f = fixture = await projectFixture(), store = new RiggingStore(f.app.hub, f.app.redactor, ['fake']);
  const item = store.add({ schema: 'add-rigging-v1', kind: 'rule', name: 'Scoped', content: 'Use precise words.', runtimes: { fake: true }, projects: [f.project.id] });
  expect(store.items('fake', f.project.id).some(row => row.id === item.item.id)).toBe(true); expect(store.items('fake', 'other').some(row => row.id === item.item.id)).toBe(false); expect(store.items('fake').some(row => row.id === item.item.id)).toBe(false);
  store.update(item.item.id, { schema: 'update-rigging-v1', revision: item.revision, name: item.item.name, content: item.item.content, state: item.item.state, runtimes: item.item.runtimes, projects: [] });
  expect(store.items('fake', 'other').some(row => row.id === item.item.id)).toBe(true);
});

test('concurrent mirror downloads keep every file and directory read-only', async () => {
  const f = fixture = await projectFixture(); member = await projectMember(f); const m = member;
  const one = await upload('one.txt', 'one'), two = await upload('two.txt', 'two');
  const client = m.app.member!, original = client.libraryFetch.bind(client), controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  vi.spyOn(client, 'libraryFetch').mockImplementation(async (path, input) => {
    const id = path.endsWith(`${one.id}/content`) ? one.id : path.endsWith(`${two.id}/content`) ? two.id : undefined;
    return id ? new Response(new ReadableStream<Uint8Array>({ start(controller) { controllers.set(id, controller); } })) : original(path, input);
  });
  const first = m.app.library.get(f.project.id, one.id), second = m.app.library.get(f.project.id, two.id); second.catch(() => undefined);
  await f.waitFor(() => controllers.size, count => count === 2);
  controllers.get(one.id)!.enqueue(Buffer.from('one')); controllers.get(one.id)!.close(); await first;
  controllers.get(two.id)!.enqueue(Buffer.from('two')); controllers.get(two.id)!.close();
  const result = await second; expect(readFileSync(result.localPath, 'utf8')).toBe('two'); expect(statSync(result.localPath).mode & 0o222).toBe(0);
});

test('new thread setup, native turn and publication receive vault environment; copied files stay private', async () => {
  const f = fixture = await projectFixture({ testCommand: 'test "$TZ" = UTC && test -n "$PRIVATE_VALUE"' });
  const settings = await f.app.projectWork.admission.settings('project'), secret = 'thread environment fixture secret';
  writeFileSync(join(f.checkout, '.env.fixture'), 'local-only');
  await f.app.projectHub.putSettings({ ...settings, setupCommand: 'test "$TZ" = UTC && test -f .env.fixture && printf "%s" "$PRIVATE_VALUE"', environment: { variables: [{ name: 'TZ', value: 'UTC' }], secrets: ['PRIVATE_VALUE'], copyFiles: ['.env.fixture'] } }, settings.revision);
  await f.app.state.environment.put('project', 'PRIVATE_VALUE', secret);
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.launch.projectEnv).toEqual({ TZ: 'UTC', PRIVATE_VALUE: secret });
    expect(turn.input.systemAppend).toContain('never commit them: .env.fixture.');
    expect(readFileSync(join(turn.input.cwd, '.env.fixture'), 'utf8')).toBe('local-only');
    writeFileSync(join(turn.input.cwd, 'feature.txt'), 'A small change.'); f.git(turn.input.cwd, 'add', 'feature.txt'); f.git(turn.input.cwd, 'commit', '-m', 'Add small change');
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: `Completed with ${secret}.`, changedFiles: ['feature.txt'] }); return { status: 'completed' };
  }, forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'environment_thread', title: 'A small environment task', task: 'Make a small change.' });
  await f.waitFor(() => f.thread(created.threadId).state, state => state === 'in-review' || state === 'failed');
  const thread = f.thread(created.threadId); expect(thread.state).toBe('in-review');
  expect(f.local(thread.id).copiedFiles).toEqual(['.env.fixture']); expect(thread.lastReport?.summary).not.toContain(secret);
  expect(f.git(thread.cwd, 'diff', '--name-only', `${thread.baseCommit}..HEAD`)).toBe('feature.txt');
  expect(f.ledgerText(thread.id)).not.toContain(secret);
});

test('a member thread receives attachment lines verbatim, reads the mirror and adds an output on the hub', async () => {
  const f = fixture = await projectFixture(); member = await projectMember(f); const m = member;
  const item = await upload('shared note.txt', 'Shared across devices.');
  const line = `Attached file: library/${item.path} (${item.mime}, ${item.size} B)`;
  m.fake.enqueueTurn(async turn => {
    expect(turn.input.prompt).toContain(line);
    const listed = await turn.bridge('jevellan_library_list', {}) as { items: Array<{ id: string }> }; expect(listed.items.some(row => row.id === item.id)).toBe(true);
    const fetched = await turn.bridge('jevellan_library_get', { itemId: item.id }) as { localPath: string };
    expect(readFileSync(fetched.localPath, 'utf8')).toBe('Shared across devices.'); expect(statSync(fetched.localPath).mode & 0o222).toBe(0);
    writeFileSync(join(turn.input.cwd, 'output.txt'), 'A member output.');
    const output = await turn.bridge('jevellan_library_add', { path: 'output.txt', note: 'From the member thread.' }) as { item: { path: string }; message: string };
    expect(output.message).toBe(`Added to the library as library/${output.item.path}.`);
    await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Read the shared attachment and saved its output.' }); return { status: 'completed' };
  }, forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'member_library', title: 'Read a shared file', task: `Read this file.\n\n${line}`, deviceId: m.deviceId });
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return m.app.projectWork.store.get(created.threadId)?.turns; }, turns => turns === 1);
  await m.app.projectWork.idle('project');
  expect(m.thread(created.threadId).lastReport?.summary).toBe('Read the shared attachment and saved its output.');
  const output = (await f.app.library.list(f.project.id)).find(row => row.source === 'thread'); expect(output).toMatchObject({ threadId: created.threadId, name: 'output.txt' });
  expect(readFileSync((await f.app.library.get(f.project.id, output!.id)).localPath, 'utf8')).toBe('A member output.');
});

test('deleting a file is retryable and never lets an old attachment path name different bytes', async () => {
  const f = fixture = await projectFixture(), first = await upload('stable.txt', 'original');
  await f.app.library.remove(f.project.id, first.id); const deleted = f.app.hub.get('project-library', first.id, ProjectLibraryItemSchema)!.document;
  await f.app.library.remove(f.project.id, first.id); expect(f.app.hub.get('project-library', first.id, ProjectLibraryItemSchema)!.document.deletedAt).toBe(deleted.deletedAt);
  const second = await upload('stable.txt', 'replacement'); expect(second.path).not.toBe(first.path); expect(second.name).toBe('stable (2).txt');
  await expect(f.app.library.get(f.project.id, first.id)).rejects.toThrow('not found');
});

test('a library stream failure after headers never becomes an unhandled server error', async () => {
  const f = fixture = await projectFixture(), item = await upload('lost.txt');
  vi.spyOn(f.app.library, 'get').mockResolvedValue({ localPath: join(f.root, 'missing-library-file') });
  const errors: unknown[] = [], rejected = (error: unknown) => errors.push(error); process.on('unhandledRejection', rejected);
  try {
    const response = await f.request(`/api/projects/${f.project.id}/library/${item.id}/content`).catch(() => null);
    await response?.arrayBuffer().catch(() => undefined); await new Promise(resolve => setTimeout(resolve, 20));
    expect(errors).toEqual([]); expect((await f.request('/api/health')).status).toBe(200);
  } finally { process.off('unhandledRejection', rejected); }
});

test('closing an in-flight library download leaves the daemon healthy', async () => {
  const f = fixture = await projectFixture(), bytes = Buffer.alloc(16 * 1024 * 1024, 120);
  const item = await f.app.library.upload(f.project.id, { name: 'large.txt', mime: 'text/plain', size: bytes.length, source: 'owner' }, Readable.from([bytes]));
  const errors: unknown[] = [], rejected = (error: unknown) => errors.push(error); process.on('unhandledRejection', rejected);
  try {
    const response = await fetch(`${f.base}/api/projects/${f.project.id}/library/${item.id}/content`, { headers: { Cookie: f.cookie, Origin: f.base } }), reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false); await reader.cancel(); await new Promise(resolve => setTimeout(resolve, 30));
    expect(errors).toEqual([]); expect((await f.request('/api/health')).status).toBe(200);
  } finally { process.off('unhandledRejection', rejected); }
});
