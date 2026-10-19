import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultProjectSchema, type HubMemoryScope } from '../packages/core/dist/index.js';
import { MemoryDream } from '../packages/memory/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

// Phase 5.7: two disposable hubs (no service, temporary homes, separate ports) and a local bare repository as the vault remote.
const URL = 'https://github.com/fixture/jevellan-vault.git', ORIGIN = 'https://github.com/fixture/repo.git';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const owner: HubMemoryScope = { kind: 'owner', provenance: { source: 'owner', runtime: 'owner', model: 'owner' } };
const fixtures: ProjectFixture[] = []; let bare: string | undefined;
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); if (bare) rmSync(join(bare, '..'), { recursive: true, force: true }); bare = undefined; });
const signal = () => AbortSignal.timeout(120_000);

async function hub(): Promise<ProjectFixture> {
  const f = await projectFixture({ vaultRemote: async () => ({ url: URL, token: 'drill-vault-token-value' }) }); fixtures.push(f);
  f.app.vault!.ensure(); git(f.app.vault!.root, 'config', `url.${bare!}.insteadOf`, URL);
  // The project's GitHub origin names its vault folder.
  const stored = (await f.app.state.projects.get(f.project.id))!;
  await f.app.conversations.saveProject({ schema: 'project-write-v1', revision: stored.revision, project: { ...stored.project, remoteUrl: ORIGIN, memory: { mode: 'hub', dir: '.jevellan/memory' } } });
  return f;
}
const project = async (f: ProjectFixture) => (await f.app.state.projects.get(f.project.id))!.project;

test('a second hub restores notes, settings, goals, jobs, dailies and the notebook from the vault, and a note edited on both keeps both versions', { timeout: 300_000 }, async () => {
  bare = join(mkdtempSync(join(tmpdir(), 'jevellan-vault-remote-')), 'vault.git'); git(join(bare, '..'), 'init', '--bare', '--quiet', '-b', 'main', bare);
  const a = await hub(), work = a.app.projectWork, id = a.project.id;
  // Hub A: settings, a goal, a gated job, a daily, the notebook and a note; then a dream that is undone.
  const settings = await work.admission.settings(id);
  await a.app.projectHub.putSettings({ ...settings, instructions: 'Keep each change small.', maxRunningThreads: 5, landingChecks: [{ name: 'Result', paths: [], command: 'true' }], coordinator: { ...settings.coordinator, accountId: 'acc_fixture' } }, settings.revision);
  const { goal } = await work.goals.create(id, { schema: 'goal-create-request-v1', clientRequestId: 'docs', name: 'Docs and tests', motivation: 'Keep the project easy to work on.', autonomy: 'auto' });
  const suite = await work.daily.createJob(id, { schema: 'job-create-request-v1', clientRequestId: 'suite', name: 'Unit tests', goalId: goal.id, enabled: true, gate: null, run: { kind: 'command', command: 'npm test', timeoutMinutes: 30 } });
  await work.daily.createJob(id, { schema: 'job-create-request-v1', clientRequestId: 'deploy', name: 'Deploy check', goalId: null, enabled: false, gate: { jobId: suite.id }, run: { kind: 'command', command: 'true', timeoutMinutes: 5 } });
  await work.daily.createDaily(id, { schema: 'daily-create-request-v1', clientRequestId: 'nightly', name: 'Unit tests', goalId: goal.id, order: 1, enabled: true, target: { kind: 'job', jobId: suite.id } });
  await work.putNotebook(id, { schema: 'notebook-request-v1', expectedRevision: 0, content: 'Plan: tests before features.\n' });
  const port = a.app.hubMemory!.project(await project(a), owner);
  const note = await port.write({ title: 'Test conventions', content: 'Run the unit tests before pushing.' }, signal());
  const dream = new MemoryDream(a.app.hubMemory!), before = readFileSync(join(port.path, note.permalink), 'utf8');
  const state = await dream.begin(await project(a), git(a.checkout, 'rev-parse', 'HEAD'), { source: 'dream', runtime: 'fake', model: 'fixture' }, 'apply');
  writeFileSync(join(dream.staging(state).path, 'Dream note.md'), '---\ntitle: Dream note\nsource: dream\nruntime: fake\nmodel: fixture\nstatus: active\n---\nLearned overnight.\n');
  expect((await dream.finish(await project(a), 'One new note.')).state).toBe('applied');
  expect(a.app.hubMemory!.list(id).map(row => row.title)).toContain('Dream note');
  expect((await dream.undo(await project(a))).state).toBe('undone');
  expect(a.app.hubMemory!.list(id).map(row => row.title)).not.toContain('Dream note');
  expect(readFileSync(join(port.path, note.permalink), 'utf8')).toBe(before);
  await a.app.vault!.sync(); await work.pulse(); await a.app.vault!.sync();
  expect(a.app.vault!.status()).toMatchObject({ remote: URL, lastError: null, pending: false });
  const definition = VaultProjectSchema.parse(JSON.parse(git(bare, 'show', 'main:projects/fixture__repo/project.json')));
  expect(definition).toMatchObject({ origin: ORIGIN, work: { instructions: 'Keep each change small.', maxRunningThreads: 5, landingChecks: [{ name: 'Result', paths: [], command: 'true' }] }, goals: [{ name: 'Docs and tests', autonomy: 'auto' }] });
  expect(definition.jobs.find(job => job.name === 'Deploy check')).toMatchObject({ gate: 'Unit tests', enabled: false });
  // Nothing device-, account- or path-specific travels.
  const text = JSON.stringify(definition);
  for (const forbidden of [a.app.device.deviceId, 'acc_fixture', a.checkout, a.root, 'drill-vault-token-value']) expect(text).not.toContain(forbidden);
  expect(git(bare, 'show', 'main:projects/fixture__repo/notebook.md')).toBe('Plan: tests before features.');

  // Hub B: a fresh hub adds the same origin and restores.
  // Hub B's sweeps run before the owner restores: they must not push B's empty defaults over A's definition.
  const b = await hub(); await b.app.vault!.sync(); await b.app.projectWork.pulse(); await b.app.vault!.sync();
  expect(VaultProjectSchema.parse(JSON.parse(git(bare, 'show', 'main:projects/fixture__repo/project.json'))).goals.map(goal => goal.name)).toEqual(['Docs and tests']);
  const restored = await b.app.restoreProjectFromVault(b.project.id);
  expect(restored.restored).toBe(true);
  const restoredSettings = await b.app.projectWork.admission.settings(b.project.id);
  expect(restoredSettings).toMatchObject({ instructions: 'Keep each change small.', maxRunningThreads: 5, landingChecks: [{ name: 'Result', paths: [], command: 'true' }] });
  expect(restoredSettings.coordinator.accountId ?? null).toBeNull();
  expect((await project(b)).allowedDevices).toEqual([b.app.device.deviceId]);
  expect((await b.app.projectWork.goals.list(b.project.id)).map(row => row.name)).toEqual(['Docs and tests']);
  const jobs = await b.app.projectWork.daily.jobs(b.project.id);
  expect(jobs.map(row => row.name).sort()).toEqual(['Deploy check', 'Unit tests']);
  expect(jobs.find(row => row.name === 'Deploy check')!.gate?.jobId).toBe(jobs.find(row => row.name === 'Unit tests')!.id);
  expect((await b.app.projectWork.daily.dailies(b.project.id)).map(row => row.name)).toEqual(['Unit tests']);
  expect((await b.app.projectWork.notebookView(b.project.id)).notebook?.content).toBe('Plan: tests before features.\n');
  expect(b.app.hubMemory!.list(b.project.id).map(row => row.title)).toEqual(['Test conventions']);
  // Restoring again duplicates nothing.
  await b.app.restoreProjectFromVault(b.project.id);
  expect((await b.app.projectWork.goals.list(b.project.id))).toHaveLength(1); expect(await b.app.projectWork.daily.jobs(b.project.id)).toHaveLength(2);
  // After restoring, B exports only what changes on B.
  await b.app.projectWork.goals.create(b.project.id, { schema: 'goal-create-request-v1', clientRequestId: 'b_goal', name: 'Faster builds', motivation: 'Wait less.' });
  await b.app.projectWork.pulse(); await b.app.vault!.sync();
  expect(VaultProjectSchema.parse(JSON.parse(git(bare, 'show', 'main:projects/fixture__repo/project.json'))).goals.map(goal => goal.name)).toEqual(['Docs and tests', 'Faster builds']);

  // The same note edited on both hubs: both versions survive.
  const portB = b.app.hubMemory!.project(await project(b), owner);
  await port.edit({ permalink: note.permalink, operation: 'append', content: 'Edited on hub A.' }, signal());
  await portB.edit({ permalink: note.permalink, operation: 'append', content: 'Edited on hub B.' }, signal());
  await a.app.vault!.sync(); await b.app.vault!.sync(); await a.app.vault!.sync();
  for (const side of [a, b]) {
    const merged = readFileSync(join(side.app.hubMemory!.notes(side.project.id), note.permalink), 'utf8');
    expect(merged).toContain('Edited on hub A.'); expect(merged).toContain('Edited on hub B.'); expect(merged).toContain('status: unresolved'); expect(merged).toContain('## Merged from');
  }
});
