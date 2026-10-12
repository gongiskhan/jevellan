import { afterEach, expect, test } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ProjectMemoryViewSchema, MemoryNoteSchema, ThreadIndexSchema, ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { HUB_MEMORY_OFFLINE, splitMemoryText } from '../packages/memory/dist/index.js';
import { projectRecall, projectNow, ReviewTools, VerificationTools } from '../packages/projects/dist/index.js';
import { SecretRedactor } from '../packages/core/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

// Real Basic Memory, two daemons, HTTP, Git and mesh transport; provider sessions and device facts are simulated.
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
async function setup(now = () => Date.parse('2026-10-12T00:00:00Z')) {
  const fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true;
  const f = fixture = await projectFixture({ runtimes: { fake }, menu: [{ id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated.', enabled: true, efforts: ['low', 'medium', 'high'] }],
    projectTimers: { now } });
  const prior = (await f.app.state.projects.get('project'))!;
  const project = { ...prior.project, memory: { ...prior.project.memory, mode: 'hub' as const } };
  await f.app.conversations.saveProject({ schema: 'project-write-v1', revision: prior.revision, project });
  return { f, project: (await f.app.state.projects.get('project'))!.project };
}
test('the authenticated mesh shares writes and owner notes without opening a member index, and skips recall when offline', async () => {
  const { f } = await setup(), member = await projectMember(f);
  const project = (await f.app.state.projects.get('project'))!.project, at = new Date().toISOString();
  await member.app.projectHub.publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 1, id: 'memory_member_thread', projectId: project.id,
    title: 'Customer tests', state: 'running', ownerDeviceId: member.deviceId, isolation: 'worktree', runtime: 'codex', modelLabel: 'Fixture', accountLabel: 'Fixture', effort: 'medium', turns: 1, createdAt: at, updatedAt: at }), 1);
  const port = member.app.memory.project(project, member.deviceId, () => { throw new Error('No checkout ownership'); }, { kind: 'thread', id: 'memory_member_thread', provenance: { source: 'thread', runtime: 'codex', model: 'fixture', threadId: 'memory_member_thread' } });
  const note = await port.write({ title: 'Customer environment', content: 'Set SANDBOX_DATA_DIR before testing customers.' }, AbortSignal.timeout(120_000));
  expect((await f.app.memory.project(project, f.app.device.deviceId, () => {}).read(note.permalink, AbortSignal.timeout(120_000))).content).toContain('SANDBOX_DATA_DIR');
  const owner = await member.json(`/api/projects/${project.id}/memory/shared`, MemoryNoteSchema, 'POST', { operation: 'write', requestId: 'owner_dates', input: { title: 'Owner dates', content: 'Use DD/MM/YYYY.' } });
  const before = readFileSync(join(f.app.hubMemory!.notes(project.id), owner.permalink));
  await expect(port.edit({ permalink: owner.permalink, operation: 'append', content: 'Wrong.' }, AbortSignal.timeout(120_000))).rejects.toThrow('Owner memory');
  expect(readFileSync(join(f.app.hubMemory!.notes(project.id), owner.permalink)).equals(before)).toBe(true);
  expect(member.app.memory.processCount).toBe(0); expect(existsSync(join(member.homes.root, 'project-memory', project.id, 'notes'))).toBe(false);
  member.offline = true;
  const recall = await projectRecall(() => member.app.memory.project(project, member.deviceId, () => {}), { title: 'Customer tests', brief: 'Use existing storage.' }, { model: 'fixture' }, AbortSignal.timeout(20_000));
  expect(recall.source).toBe('unavailable'); expect(recall.section).toContain(HUB_MEMORY_OFFLINE);
}, 180_000);
test('turn capture extracts into the inbox, preserves the learner provenance and reaches a different provider on recall', async () => {
  const { f, project } = await setup(), work = f.app.projectWork, programme = work.memoryProgramme!;
  work.captures.accept({ schema: 'memory-capture-v1', id: 'capture_learning', projectId: project.id, scope: 'thread', threadId: 'learning_codex', taskId: 'task_learning', runtime: 'codex', model: 'learner-model', sessionId: 'fixture_capture_session', transcriptPath: '/disposable/fixture.jsonl', fromByte: 0, toByte: 6000, at: new Date().toISOString(), processedAt: null, extractionId: null }, `The CHANGELOG rule: add an entry before pushing. ${'A durable test log. '.repeat(300)}`);
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.owner.kind).toBe('memory'); expect(turn.input.permissions).toBe('read-only'); expect(turn.input.effort).toBe('low');
    const file = turn.input.prompt.match(/input at (.*)\. Extract/)![1]!; expect(readFileSync(file, 'utf8')).toContain('CHANGELOG rule');
    await turn.bridge('jevellan_memory_inbox_add', { title: 'CHANGELOG rule', body: 'Add a CHANGELOG entry before the first push.', kind: 'convention', evidence: { threadId: 'learning_codex', taskId: 'task_learning', quote: 'add an entry before pushing' } });
    return { status: 'completed' };
  });
  await programme.start(project, 'extraction'); expect(programme.session(project.id, 'extraction')!.state).toBe('completed'); expect(work.captures.slices(project.id)).toHaveLength(0);
  const inbox = f.app.hubMemory!.list(project.id).find(note => note.permalink.startsWith('inbox/'))!;
  expect(splitMemoryText(inbox.content).meta).toMatchObject({ source: 'capture', runtime: 'codex', model: 'learner-model', threadId: 'learning_codex' });
  const recall = await projectRecall(f.app.memory.project(project, f.app.device.deviceId, () => {}), { title: 'Customer CHANGELOG', brief: 'Add a new customer screen.' }, { model: 'fixture' }, AbortSignal.timeout(120_000));
  expect(recall.section).toContain('from today, not yet consolidated'); expect(recall.section).toContain('Add a CHANGELOG entry'); expect(recall.notes.some(note => note.permalink === inbox.permalink)).toBe(true);
  expect(recall.source).toBe('search-rank');
}, 180_000);
test('a real notes dream is independent of ordered work, reports actual changes and Run now retries do not launch twice', async () => {
  const { f, project } = await setup(), programme = f.app.projectWork.memoryProgramme!, store = f.app.hubMemory!;
  const baseline = f.git(f.checkout, 'rev-parse', 'HEAD'); programme.dream.initialise(project.id, baseline);
  writeFileSync(join(f.checkout, 'new.txt'), 'A direct change.\n'); f.git(f.checkout, 'add', '-A'); f.git(f.checkout, 'commit', '-m', 'Direct push for the dream'); f.git(f.checkout, 'push');
  const head = f.git(f.checkout, 'rev-parse', 'HEAD'), writer = store.project(project, { kind: 'memory', provenance: { source: 'capture', runtime: 'codex', model: 'fixture' } }, undefined, undefined, 'inbox');
  const inbox = await writer.write({ title: 'CHANGELOG convention', content: 'Always add CHANGELOG entries.' }, AbortSignal.timeout(120_000));
  const checkout = f.git(f.checkout, 'status', '--porcelain');
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.effort).toBe('high'); expect(turn.input.permissions).toBe('read-only');
    const file = turn.input.prompt.match(/input at (.*)\. Search/)![1]!; expect(readFileSync(file, 'utf8')).toContain('Direct push for the dream');
    await turn.bridge('memory_write', { title: 'Project brief', content: `Run npm test. Always add CHANGELOG entries. Read ${inbox.permalink}.` });
    await turn.bridge('jevellan_memory_archive', { note: inbox.permalink, reason: 'Folded into Project brief.' });
    await turn.bridge('jevellan_memory_dream_report', { summary: 'Consolidated the changelog convention.' });
    return { status: 'completed' };
  });
  const one = programme.runNow(project, 'dream_click'), two = programme.runNow(project, 'dream_click'); expect(two).toEqual(one);
  await f.waitFor(() => programme.session(project.id, 'dream'), session => !!session && session.state !== 'running', 120_000);
  expect(programme.session(project.id, 'dream')!.state).toBe('completed'); expect(f.fake.turnStarts.filter(turn => turn.owner.kind === 'memory')).toHaveLength(1);
  const view = await f.json(`/api/projects/${project.id}/memory/shared`, ProjectMemoryViewSchema);
  expect(view.dream!.report).toMatchObject({ mainCommit: head, counts: { inboxPromoted: 1, inboxDropped: 0, created: 1 }, briefUpdated: true });
  expect(view.inbox).toHaveLength(0); expect(programme.dream.watermark(project.id)).toBe(head); expect(f.git(f.checkout, 'status', '--porcelain')).toBe(checkout);
  await programme.dream.undo(project); expect(programme.dream.watermark(project.id)).toBe(baseline); expect(store.list(project.id).some(note => note.permalink.startsWith('inbox/'))).toBe(true);
}, 180_000);
test('review and verification sessions can read memory while writes remain refused', async () => {
  const { f, project } = await setup(), store = f.app.hubMemory!;
  const note = await store.project(project, { kind: 'thread', provenance: { source: 'thread', runtime: 'codex', model: 'fixture' } }).write({ title: 'Tests', content: 'Use TZ=UTC npm test.' }, AbortSignal.timeout(120_000));
  for (const tools of [new ReviewTools(async () => {}, new SecretRedactor(), store.project(project, { kind: 'review' })), new VerificationTools(async () => {}, new SecretRedactor(), null, store.project(project, { kind: 'verification' }))]) {
    expect(tools.list().tools.map(tool => tool.name)).toContain('memory_read');
    expect((await tools.call('memory_read', { permalink: note.permalink })).result).toMatchObject({ content: expect.stringContaining('TZ=UTC') });
    await expect(tools.call('memory_write', { title: 'Refused', content: 'Refused' })).rejects.toMatchObject({ status: 403 }); await tools.close();
  }
}, 180_000);

test('the first turn after compaction re-reads changed hub memory and retains Project now in the same native session', async () => {
  const { f, project } = await setup(), writer = f.app.hubMemory!.project(project, { kind: 'thread', provenance: { source: 'thread', runtime: 'codex', model: 'fixture' } });
  const brief = await writer.write({ title: 'Project brief', content: 'Use the first test convention.' }, AbortSignal.timeout(120_000));
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.prompt).toContain('Use the first test convention.'); expect(turn.input.prompt).toContain('Project now');
    turn.emit({ type: 'compacted', beforeTokens: 8000, afterTokens: 1000, contextWindow: 10000 });
    await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Ready for another turn.' }); return { status: 'completed' };
  });
  const receipt = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'recall_compaction', title: 'Keep this task', task: 'Remember the entire brief.' });
  await f.waitFor(() => f.thread(receipt.threadId), thread => thread.state === 'idle'); const native = f.thread(receipt.threadId).nativeSessionId;
  await writer.edit({ permalink: brief.permalink, operation: 'replace', find: 'first', content: 'changed' }, AbortSignal.timeout(120_000));
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.resume?.sessionId).toBe(native); expect(turn.input.prompt).toContain('Remember the entire brief.');
    expect(turn.input.prompt).toContain('Use the changed test convention.'); expect(turn.input.prompt).not.toContain('Use the first test convention.');
    expect(turn.input.prompt.indexOf('Project memory')).toBeLessThan(turn.input.prompt.indexOf('Project now'));
    await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Changed memory received.' }); return { status: 'completed' };
  });
  await f.app.projectWork.threads.message(project.id, receipt.threadId, 'owner', 'Continue.', false); await f.waitFor(() => f.thread(receipt.threadId), thread => thread.turns === 2 && thread.state === 'idle');
}, 180_000);

test('extraction retries once, waits thirty minutes, and recovers a durable request after restart', async () => {
  let now = Date.parse('2026-10-12T00:00:00Z'); const { f, project } = await setup(() => now), programme = f.app.projectWork.memoryProgramme!;
  const capture = { schema: 'memory-capture-v1' as const, id: 'retry_capture', projectId: project.id, scope: 'thread' as const, runtime: 'codex', model: 'fixture', sessionId: 'fixture_retry', transcriptPath: '/fixture/journal', fromByte: 0, toByte: 5000, at: new Date(now).toISOString(), processedAt: null, extractionId: null };
  f.app.projectWork.captures.accept(capture, 'A durable convention. '.repeat(260)); f.fake.enqueueTurn(() => ({ status: 'failed', error: { kind: 'other', message: 'Fixture extraction failure.' } }));
  await programme.start(project, 'extraction'); await programme.sweep(project); expect(f.fake.turnStarts).toHaveLength(1);
  now += 1_800_000; f.fake.enqueueTurn(() => ({ status: 'failed', error: { kind: 'other', message: 'Fixture extraction failure.' } }));
  await programme.sweep(project); await f.waitFor(() => programme.session(project.id, 'extraction'), session => session?.retries === 1 && session.state === 'failed');
  now += 1_800_000; await programme.sweep(project); expect(f.fake.turnStarts).toHaveLength(2);
  const saved = programme.save({ ...programme.session(project.id, 'extraction')!, state: 'running', retries: 1 });
  await f.restart(); const recovered = f.app.projectWork.memoryProgramme!; await recovered.sweep(project);
  expect(recovered.session(project.id, 'extraction')).toMatchObject({ id: saved.id, state: 'failed', reason: expect.stringContaining('restarted') });
  expect(f.fake.turnStarts).toHaveLength(2);
}, 180_000);
test('Project now preserves both sections under its limit, excludes the thread itself and uses the PR merge time', () => {
  const at = new Date().toISOString(), old = '2020-01-01T00:00:00Z', base = { schema: 'project-thread-index-v1', revision: 1, id: 'self', projectId: 'project', title: 'Self', state: 'running', isolation: 'worktree', runtime: 'codex', ownerDeviceId: 'pro', modelLabel: 'Fixture', accountLabel: 'Fixture', effort: 'medium', turns: 1, createdAt: at, updatedAt: at };
  const rows = [ThreadIndexSchema.parse(base), ...Array.from({ length: 20 }, (_, n) => ThreadIndexSchema.parse({ ...base, id: `other_${n}`, title: `Other ${n} ${'x'.repeat(100)}`, changedPaths: ['src/customers.ts'], lastSummary: 'Adding sorting.' })), ThreadIndexSchema.parse({ ...base, id: 'old_merge', title: 'Old merge', state: 'done', pr: { number: 3, url: 'https://github.com/fixture/repo/pull/3', headSha: 'a'.repeat(40), state: 'merged', checks: 'passing', mergeable: 'clean', updatedAt: old } })];
  const text = projectNow(rows, 'self', 'main', () => 'Pro'); expect(text.length).toBeLessThanOrEqual(2500); expect(text).toContain('Other 0'); expect(text).not.toContain('Self'); expect(text).toContain('Merged to main'); expect(text).not.toContain('#3');
});
