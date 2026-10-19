import { afterEach, expect, test } from 'vitest';
import { TaskCreateRequestSchema, defaultProjectWorkSettings, undoProjectSetting, ProjectSettingsUpdateSchema } from '../packages/core/dist/index.js';
import { settingsChangePlan } from '../packages/projects/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

const fields = (current: ReturnType<typeof defaultProjectWorkSettings>) => { const { schema: _schema, projectId: _id, revision: _revision, ...value } = current; void _schema; void _id; void _revision; return value; };
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('settings append limits, strict allowed fields and field-specific Undo preserve unrelated settings', () => {
  const original = defaultProjectWorkSettings('project');
  const plan = settingsChangePlan(original, { maxRunningThreads: 2, prAutoFix: { checks: false }, instructionsAppend: 'Keep it small.', ownerWords: 'Two threads, and keep it small.' }, 'setting_first', new Date().toISOString());
  const first = plan.change.changes.find(change => change.field === 'maxRunningThreads')!;
  expect(undoProjectSetting(plan.settings, first)).toMatchObject({ maxRunningThreads: original.maxRunningThreads, instructions: 'Keep it small.', prAutoFix: { checks: false, conflicts: true } });
  expect(undoProjectSetting({ ...plan.settings, maxRunningThreads: 4 }, first)).toBeUndefined();
  expect(() => settingsChangePlan({ ...original, instructions: 'x'.repeat(16000) }, { instructionsAppend: 'More', ownerWords: 'More' }, 'setting_limit', new Date().toISOString())).toThrow('Project instructions would exceed 16,000 characters.');
  expect(ProjectSettingsUpdateSchema.safeParse({ autoLand: true, ownerWords: 'Merge' }).success).toBe(false);
  expect(ProjectSettingsUpdateSchema.safeParse({ ownerWords: 'No change' }).success).toBe(false);
  expect(ProjectSettingsUpdateSchema.safeParse({ prAutoFix: {}, ownerWords: 'No change' }).success).toBe(false);
});

test('owner Undo restores only its field from stored settings and refuses a changed field', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const raw = { ...defaultProjectWorkSettings(f.project.id), maxRunningThreads: 2, memory: { mode: 'hub' as const, capture: false, dreamMode: 'suggest' as const } };
  const stored = await f.app.projectHub.putSettings(raw, 0);
  const projectMode = f.project.memory.mode;
  const request = { schema: 'project-settings-undo-request-v1', expectedRevision: stored.revision, clientRequestId: 'undo_first', change: { field: 'maxRunningThreads', before: 3, after: 2 } };
  expect((await f.request(`/api/projects/${f.project.id}/work-settings/undo`, 'POST', request)).status).toBe(200);
  expect((await f.app.projectHub.settings(f.project.id))?.document).toMatchObject({ maxRunningThreads: 3, memory: raw.memory });
  expect((await f.app.state.projects.get(f.project.id))?.project.memory.mode).toBe(projectMode);
  const latest = (await work.settingsView(f.project.id)).settings;
  const changed = await f.request(`/api/projects/${f.project.id}/work-settings/undo`, 'POST', { ...request, clientRequestId: 'undo_changed', expectedRevision: latest.revision, change: { field: 'maxRunningThreads', before: 4, after: 2 } });
  expect(changed.status).toBe(409);
  expect((await f.app.projectHub.settings(f.project.id))?.document.maxRunningThreads).toBe(3);
});

test('coordinator settings change only permitted fields even when the view adjusts the stored memory mode', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  const raw = { ...defaultProjectWorkSettings(f.project.id), memory: { mode: 'hub' as const, capture: false, dreamMode: 'suggest' as const } };
  await f.app.projectHub.putSettings(raw, 0);
  expect((await f.app.projectWork.settingsView(f.project.id)).settings.memory.mode).toBe(f.project.memory.mode);
  await f.app.projectWork.coordinatorSettings(f.project.id, { maxRunningThreads: 2, ownerWords: 'Use two threads.' }, 'setting_preserve');
  expect((await f.app.projectHub.settings(f.project.id))?.document).toMatchObject({ maxRunningThreads: 2, memory: raw.memory });
  expect((await f.app.state.projects.get(f.project.id))?.project.memory.mode).toBe(f.project.memory.mode);
});

test('propose mode holds owner-request work as drafts even with Now, and leaves owner-created tasks alone', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); const work = f.app.projectWork;
  await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  const current = (await work.settingsView(f.project.id)).settings;
  await work.putSettings(f.project.id, { schema: 'project-work-settings-request-v1', revision: current.revision, settings: { ...fields(current), startMode: 'propose' } });
  const receipt = await work.tasks.create(f.project.id, TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: 'proposed', title: 'Small work', brief: 'Inspect README.', now: true, held: true }), 'owner-request', { ownerRequested: true });
  await work.pulse();
  expect(await work.tasks.read(f.project.id, receipt.taskId)).toMatchObject({ state: 'draft', threadId: null });
  expect(receipt).toHaveProperty('message', 'Proposed "Small work". It starts when the owner starts it.');
  const owner = await work.tasks.create(f.project.id, TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: 'manual', title: 'Manual work', brief: 'Inspect README.', held: true }));
  expect(owner.state).toBe('queued');
});

test('new threads snapshot instructions in their system append; resumed turns keep the original snapshot', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); const work = f.app.projectWork;
  let current = (await work.settingsView(f.project.id)).settings;
  await work.putSettings(f.project.id, { schema: 'project-work-settings-request-v1', revision: current.revision, settings: { ...fields(current), instructions: 'Keep the original rule.' } });
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Read the task.' }), forThread());
  const receipt = await work.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'snapshot', title: 'Inspect', task: 'Read README.' });
  await f.waitFor(() => f.thread(receipt.threadId), thread => thread.turns === 1 && thread.state === 'idle');
  expect(f.thread(receipt.threadId)).toMatchObject({ task: 'Read README.', instructions: 'Keep the original rule.' });
  expect(f.fake.turnStarts[0]!.systemAppend).toMatch(/Project instructions from the owner:\nKeep the original rule\.$/u);
  current = (await work.settingsView(f.project.id)).settings;
  await work.putSettings(f.project.id, { schema: 'project-work-settings-request-v1', revision: current.revision, settings: { ...fields(current), instructions: 'Use the changed rule.' } });
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued.' }), forThread());
  await work.threads.message(f.project.id, receipt.threadId, 'owner', 'Continue.', false, 'continue_snapshot');
  await f.waitFor(() => f.thread(receipt.threadId).turns, turns => turns === 2);
  expect(f.fake.turnStarts[1]!.systemAppend).toBe(f.fake.turnStarts[0]!.systemAppend);
});
