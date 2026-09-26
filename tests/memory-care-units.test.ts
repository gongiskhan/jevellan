import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationSchema, Homes, ImproverJobSchema, ProjectSchema, conversationIndex, seedConfiguration, unifiedDiff, type ConversationIndex, type DeviceView, type ImproverJob,
} from '../packages/core/dist/index.js';
import { HubDatabase, ProjectImproverHub, checkedPatch } from '../packages/mesh/dist/index.js';
import { careKey, collectMemoryCandidates, memoryCarePatch, memoryCareCommit, memoryCareResult, patchFile, projectPatch, readMemoryFiles, searchOverlapPairs } from '../packages/memory/dist/index.js';
import { memoryCareQuestions } from '../packages/decisions/dist/index.js';
import { trialLog } from '../apps/daemon/dist/index.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-care-units-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function note(path: string, content: string, ageDays = 0) {
  const file = join(root, '.jevellan/memory', path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content);
  const at = new Date(Date.now() - ageDays * 86400_000); utimesSync(file, at, at);
}

test('candidate collection finds near-identical titles, unresolved merges, stale unlinked notes and broken links without judging them', () => {
  note('testing.md', '---\ntitle: Testing with Vitest\n---\nGlobals on. See [[Deploy]].\n');
  note('testing-copy.md', '---\ntitle: Testing with vitest.\n---\nGlobals are on.\n');
  note('deploy.md', '---\ntitle: Deploy\nstatus: unresolved\n---\nOne.\n\n## Merged from laptop on 2026-09-01\n\nTwo. [[Nowhere]] and [gone](missing.md).\n');
  note('linked-old.md', '---\ntitle: Linked old\n---\nOld but linked.\n', 200);
  note('lonely-old.md', '---\ntitle: Lonely old\n---\nOld and unlinked.\n', 200);
  note('index.md', '---\ntitle: Index\n---\n[[Linked old]]\n');
  note('archive/ancient.md', '---\ntitle: Ancient\n---\nArchived already.\n', 400);
  const files = readMemoryFiles(root, '.jevellan/memory');
  const candidates = collectMemoryCandidates(files, { changed: null, now: Date.now() });
  expect(candidates.pairs).toEqual([{ a: '.jevellan/memory/testing-copy.md', b: '.jevellan/memory/testing.md', basis: 'title' }]);
  expect(candidates.unresolved).toEqual(['.jevellan/memory/deploy.md']);
  expect(candidates.stale).toEqual(['.jevellan/memory/lonely-old.md']);
  expect(candidates.brokenLinks).toEqual([{ path: '.jevellan/memory/deploy.md', target: 'Nowhere' }, { path: '.jevellan/memory/deploy.md', target: 'missing.md' }]);
  expect(candidates.notes.map(entry => entry.path)).not.toContain('.jevellan/memory/archive/ancient.md');
  // Only pairs touching a changed note are reconsidered after the first run.
  expect(collectMemoryCandidates(files, { changed: new Set(['.jevellan/memory/index.md']), now: Date.now() }).pairs).toEqual([]);
  expect(searchOverlapPairs(new Map([['a', ['b', 'c']], ['b', ['a']], ['c', []]]))).toEqual([['a', 'b']]);
  const questions = memoryCareQuestions(candidates, new Map(files.map(file => [file.path, { title: file.title, content: file.content }])));
  expect(Object.keys(questions)).toEqual(['pair_0', 'stale_0']);
  expect(questions.pair_0!.instructions).toContain('These two notes describe the same thing. Note A: Testing with vitest.');
  expect(questions.stale_0!.instructions).toContain('This note is still useful for work on this project. Note: Lonely old');
});

test('a memory patch archives stale notes in code and refuses drafts that exceed what Jev confirmed', () => {
  note('a.md', '---\ntitle: Alpha\n---\nOne.\n'); note('b.md', '---\ntitle: Alpha.\n---\nTwo.\n'); note('c.md', '---\ntitle: Gamma\n---\nThree.\n'); note('old.md', 'Old.\n', 200);
  const files = readMemoryFiles(root, '.jevellan/memory'); const dir = '.jevellan/memory';
  const confirmed = { pairs: [[`${dir}/a.md`, `${dir}/b.md`]] as Array<[string, string]>, stale: [`${dir}/old.md`], unresolved: [], brokenLinks: [] };
  const draft = (files: Array<{ path: string; content: string | null }>) => ({ schema: 'memory-patch-draft-v1', summary: 'Tidy.', files });
  const { patch, counts } = memoryCarePatch(dir, files, confirmed, draft([{ path: 'a.md', content: '---\ntitle: Alpha\n---\nOne.\nTwo.\n' }, { path: 'b.md', content: null }]));
  expect(counts).toEqual({ merged: 1, archived: 1, fixedLinks: 0, reconciled: 0 });
  expect(patch!.files.map(file => [file.path, file.after === null])).toEqual([[`${dir}/a.md`, false], [`${dir}/archive/old.md`, false], [`${dir}/b.md`, true], [`${dir}/old.md`, true]]);
  expect(patch!.files.find(file => file.path === `${dir}/archive/old.md`)).toMatchObject({ before: null, after: 'Old.\n' });
  expect(memoryCareCommit(counts)).toBe('nightly care (1 merged, 1 archived, 0 links)'); expect(memoryCareResult(counts)).toBe('Merged 1 note, archived 1, fixed 0 links');
  expect(() => memoryCarePatch(dir, files, confirmed, draft([{ path: 'c.md', content: 'Changed.\n' }]))).toThrow('only change notes that Jev confirmed');
  expect(() => memoryCarePatch(dir, files, confirmed, draft([{ path: 'new.md', content: 'New.\n' }]))).toThrow('cannot create new notes');
  expect(() => memoryCarePatch(dir, files, confirmed, draft([{ path: 'a.md', content: null }, { path: 'b.md', content: null }]))).toThrow('keep one note');
  expect(() => memoryCarePatch(dir, files, confirmed, draft([{ path: 'old.md', content: null }]))).toThrow();
  expect(() => memoryCarePatch(dir, files, confirmed, draft([{ path: 'archive/x.md', content: 'x' }]))).toThrow('Archiving is done by Jevellan');
  expect(() => memoryCarePatch(dir, files, confirmed, draft([{ path: '../AGENTS.md', content: 'x' }]))).toThrow();
  expect(careKey('memory-care', files, [`${dir}/a.md`])).not.toBe(careKey('memory-care', files.map(file => file.path === `${dir}/a.md` ? { ...file, content: 'Edited.' } : file), [`${dir}/a.md`]));
});

test('unified diffs show additions, removals, new and deleted files', () => {
  expect(unifiedDiff('n.md', 'a\nb\nc\n', 'a\nB\nc\n')).toBe('diff --git a/n.md b/n.md\n--- a/n.md\n+++ b/n.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  expect(unifiedDiff('n.md', null, 'x\n')).toBe('diff --git a/n.md b/n.md\nnew file mode 100644\n--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,1 @@\n+x\n');
  expect(unifiedDiff('n.md', 'x\n', null)).toContain('deleted file mode 100644\n--- a/n.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n');
  const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  expect(unifiedDiff('n.md', `${long}\n`, `${long.replace('line 1\n', 'one\n').replace('line 18', 'eighteen')}\n`).match(/^@@/gm)).toHaveLength(2);
  expect(unifiedDiff('n.md', 'same\n', 'same\n')).toBe('');
});

test('the hub dispatches project jobs to the hub checkout, otherwise the first online device with one, and binds results to that device', () => {
  mkdirSync(join(root, 'user')); const homes = new Homes(join(root, 'home'), join(root, 'user')); const hub = new HubDatabase(homes, 'hub');
  try {
    const configuration = seedConfiguration(); configuration['x-jevellan'].improver.schedule.enabled = false; hub.configuration.put(configuration, 0, { deviceId: 'hub', source: 'install' });
    const project = (id: string, paths: Record<string, string>) => hub.put('projects', id, ProjectSchema, { schema: 'project-v1', id, name: id, paths, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'linked' } }, 0);
    project('on_hub', { hub: '/tmp/a', laptop: '/tmp/b' }); project('on_members', { laptop: '/tmp/b', desktop: '/tmp/c', offline: '/tmp/d' });
    const view = (id: string, joinedAt: string, status: DeviceView['status']): DeviceView => ({ schema: 'device-view-v1', device: { schema: 'device-v1', id, name: id, role: 'member', url: 'http://127.0.0.1:1', os: 'linux', version: '0.1.0', joinedAt }, status, heartbeat: null, revoked: false });
    const devices = [view('desktop', '2026-09-02T00:00:00.000Z', 'online'), view('laptop', '2026-09-03T00:00:00.000Z', 'online'), view('offline', '2026-09-01T00:00:00.000Z', 'offline')];
    const projects = new ProjectImproverHub(hub, { hubId: 'hub', devices: () => devices });
    expect(projects.designated(projects.project('on_hub'))).toBe('hub'); expect(projects.designated(projects.project('on_members'))).toBe('desktop');
    projects.requestRun('cycle', 'laptop');
    const laptop = projects.poll('laptop', new Date().toISOString()); expect(laptop.jobs).toEqual([]);
    const desktop = projects.poll('desktop', new Date().toISOString());
    expect(desktop.jobs.map(job => [job.scope.kind, job.scope.projectId])).toEqual([['memory', 'on_members']]);
    const hubWork = projects.poll('hub', new Date().toISOString()); expect(hubWork.jobs.map(job => job.scope.projectId)).toEqual(['on_hub']);
    // Context waits for memory care on the same project and cycle.
    const job: ImproverJob = ImproverJobSchema.parse(desktop.jobs[0]);
    expect(() => projects.finish('laptop', job, 'complete', 'Wrong device.', null)).toThrow('another device');
    projects.finish('desktop', job, 'complete', 'Nothing to tidy.', null);
    expect(projects.poll('desktop', new Date().toISOString()).jobs.map(value => value.scope.kind)).toEqual(['context']);
    devices[0]!.status = 'offline'; expect(projects.designated(projects.project('on_members'))).toBe('laptop');
    const text = 'Original.\n'; const good = projectPatch([patchFile('.jevellan/memory/a.md', text, 'Changed.\n')]);
    expect(checkedPatch({ ...good, diff: 'forged' }).diff).toContain('+Changed.');
    expect(() => checkedPatch({ ...good, files: [{ ...good.files[0]!, beforeText: 'Tampered.\n' }] })).toThrow('does not match');
    const input = (path: string) => ({ schema: 'project-suggestion-input-v1' as const, id: `s_${path.length}`, kind: 'memory-care' as const, projectId: 'on_members', projectName: 'on_members', title: 'Care', reason: 'Tidy.',
      evidence: [{ path: '.jevellan/memory/a.md', permalink: 'a.md', title: 'A' }], counts: { merged: 0, archived: 0, fixedLinks: 0, reconciled: 0 }, patch: projectPatch([patchFile(path, text, 'Changed.\n')]), suppressionKey: 'a'.repeat(64) });
    const context = projects.poll('desktop', new Date().toISOString()).jobs;
    expect(context).toEqual([]);
    const retry = projects.jobs.claim({ kind: 'memory', projectId: 'on_members', cycle: { kind: 'manual', id: 'other' } }, 'desktop').job;
    expect(() => projects.suggest('desktop', retry, input('AGENTS.md'))).toThrow('only change notes in the memory folder');
    expect(() => projects.suggest('laptop', retry, input('.jevellan/memory/a.md'))).toThrow('another job');
    expect(projects.suggest('desktop', retry, input('.jevellan/memory/a.md')).suggestion).toMatchObject({ deviceId: 'desktop', status: 'pending' });
  } finally { hub.close(); }
});

test('the trial log counts conversations finished in Jevellan and outside it per week, with the reasons given', () => {
  const index = (id: string, state: 'done' | 'running' | 'cancelled', updatedAt: string, outcome?: { reason?: string; at: string }): ConversationIndex => conversationIndex(ConversationSchema.parse({
    schema: 'conversation-v2', id, title: `Conversation ${id}`, projectId: 'sandbox', ownerDeviceId: 'hub', createdAt: '2026-09-01T00:00:00.000Z', updatedAt, state, generation: 0, pins: {}, stretchCount: 1, work: null,
    ...(outcome ? { outcome: { kind: 'finished-elsewhere', ...outcome } } : {}) }));
  const log = trialLog([
    index('one', 'done', '2026-09-21T10:00:00.000Z'), index('two', 'done', '2026-09-22T10:00:00.000Z'), index('three', 'running', '2026-09-22T10:00:00.000Z'),
    index('four', 'done', '2026-09-23T10:00:00.000Z', { reason: 'Needed a live browser.', at: '2026-09-23T11:00:00.000Z' }), index('five', 'cancelled', '2026-09-15T10:00:00.000Z', { at: '2026-09-15T11:00:00.000Z' }),
    index('six', 'done', '2026-09-16T10:00:00.000Z'), index('old', 'done', '2026-01-01T10:00:00.000Z'),
  ], Date.parse('2026-09-26T12:00:00.000Z'));
  expect(log.weeks).toEqual([
    { weekStart: '2026-09-21', inJevellan: 2, outside: 1, reasons: [{ conversationId: 'four', title: 'Conversation four', projectId: 'sandbox', at: '2026-09-23T11:00:00.000Z', reason: 'Needed a live browser.' }] },
    { weekStart: '2026-09-14', inJevellan: 1, outside: 1, reasons: [{ conversationId: 'five', title: 'Conversation five', projectId: 'sandbox', at: '2026-09-15T11:00:00.000Z', reason: null }] },
  ]);
  expect(index('four', 'done', '2026-09-23T10:00:00.000Z', { at: '2026-09-23T11:00:00.000Z' }).outcome?.kind).toBe('finished-elsewhere');
});
