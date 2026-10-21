import { afterEach, expect, test } from 'vitest';
import { ProjectWorkSettingsSchema } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/config/editor';
async function prepare() {
  const f = fixture = await projectFixture(), current = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...current, environment: { ...current.environment, secrets: ['KEEP_SECRET', 'REMOVE_SECRET', 'MISSING_SECRET'] } }, current.revision);
  const value = 'owned fixture vault value';
  await f.app.state.environment.put('project', 'KEEP_SECRET', value); await f.app.state.environment.put('project', 'REMOVE_SECRET', value);
  const base = (await f.app.projectWork.settingsView('project')).settings;
  return { f, base, value };
}

test('general settings editor supplies ordered sections, routine state and secret summaries without values', async () => {
  const { f, base, value } = await prepare(), response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-settings-editor-v1', settingsView: { settings: base }, work: { project: { id: 'project' } }, routines: { schema: 'project-routine-settings-view-v1' } });
  expect(view.sections.map((row: { key: string }) => row.key)).toEqual(['general', 'instructions', 'placement', 'limits', 'pull-requests', 'environment', 'routines', 'health', 'notifications', 'usage', 'automation']);
  expect(view.statusOptions.map((row: { value: string }) => row.value)).toEqual(['active', 'paused', 'archived']);
  expect(view.secretStates.map((row: { name: string; saved: boolean }) => ({ name: row.name, saved: row.saved }))).toEqual([{ name: 'KEEP_SECRET', saved: true }, { name: 'REMOVE_SECRET', saved: true }, { name: 'MISSING_SECRET', saved: false }]);
  expect(JSON.stringify(view).includes(value), 'Vault values stay out of editor metadata.').toBe(false); expect(f.fake.runs).toHaveLength(0);
});

test('general save commits settings first and returns a value-free ordered plan for normal vault routes', async () => {
  const { f, base, value } = await prepare(), draft = { ...base, instructions: 'A focused project.', environment: { ...base.environment, secrets: ['KEEP_SECRET', 'NEW_SECRET', 'MISSING_SECRET'] } };
  const request = { schema: 'project-settings-editor-save-v1', clientRequestId: 'settings_editor_save', base, draft, secretPresence: { KEEP_SECRET: true, NEW_SECRET: true, MISSING_SECRET: false, UNUSED_SECRET: true } };
  const response = await f.request(path, 'POST', request); expect(response.status).toBe(200); const result = await response.json();
  expect(result).toMatchObject({ schema: 'project-settings-editor-saved-v1', settingsView: { settings: { ...draft, revision: base.revision + 1 } }, backPath: '/projects/project' });
  expect(result.secretSteps.map((step: { kind: string; name: string }) => ({ kind: step.kind, name: step.name }))).toEqual([{ kind: 'delete', name: 'REMOVE_SECRET' }, { kind: 'write', name: 'KEEP_SECRET' }, { kind: 'write', name: 'NEW_SECRET' }]);
  expect(JSON.stringify(result).includes(value), 'Vault values stay out of save receipts and operation plans.').toBe(false);
  expect((await f.app.state.environment.summary('project', 'REMOVE_SECRET')).saved).toBe(true);
  for (const step of result.secretSteps) {
    expect(step.body).not.toHaveProperty('value');
    const applied = await f.request(step.path, step.method, step.kind === 'write' ? { ...step.body, value } : step.body); expect(applied.status).toBe(200);
  }
  expect((await f.app.state.environment.summary('project', 'REMOVE_SECRET')).saved).toBe(false);
  expect((await f.app.state.environment.summary('project', 'NEW_SECRET')).saved).toBe(true);
  const repeated = await f.request(path, 'POST', request); expect(repeated.status).toBe(200); expect((await repeated.json()).secretSteps).toEqual(result.secretSteps);
});

test('general save keeps canonical CAS and first validation issue without changing settings on refusal', async () => {
  const { f, base } = await prepare(), draft = { ...base, riskyAreas: 'x'.repeat(2001) };
  const invalid = ProjectWorkSettingsSchema.safeParse(draft); expect(invalid.success).toBe(false);
  const response = await f.request(path, 'POST', { schema: 'project-settings-editor-save-v1', clientRequestId: 'settings_editor_invalid', base, draft, secretPresence: {} }); expect(response.status).toBe(400);
  expect((await response.json()).message).toBe(invalid.success ? '' : invalid.error.issues[0]!.message);
  await f.app.projectHub.putSettings({ ...base, instructions: 'A newer owner edit.' }, base.revision);
  expect((await f.request(path, 'POST', { schema: 'project-settings-editor-save-v1', clientRequestId: 'settings_editor_stale', base, draft: { ...base, riskyAreas: 'A local draft.' }, secretPresence: {} })).status).toBe(409);
  expect((await f.app.projectWork.settingsView('project')).settings).toEqual({ ...base, revision: base.revision + 1, instructions: 'A newer owner edit.' });
});

test('status commands save only the supplied base and acknowledge a raw-draft patch from canonical state', async () => {
  const { f, base } = await prepare(), request = { schema: 'project-settings-editor-status-v1', clientRequestId: 'settings_editor_pause', base, status: 'paused' };
  const response = await f.request(path, 'POST', request); expect(response.status).toBe(200); const saved = await response.json();
  expect(saved.settingsView.settings).toEqual({ ...base, revision: base.revision + 1, status: 'paused' });
  expect(saved.statusPatch).toEqual({ status: 'paused', revision: base.revision + 1 }); expect(saved.secretSteps).toEqual([]);
  const localDraft = { ...base, instructions: 'Unsaved local instructions.', ...saved.statusPatch };
  expect(localDraft).toMatchObject({ instructions: 'Unsaved local instructions.', status: 'paused', revision: saved.settingsView.settings.revision });
  const current = saved.settingsView.settings;
  await f.app.projectHub.putSettings({ ...current, status: 'archived' }, current.revision);
  const repeated = await f.request(path, 'POST', request); expect(repeated.status).toBe(200);
  expect((await repeated.json()).statusPatch).toEqual({ status: 'archived', revision: current.revision + 1 });
});

test('member general settings reads and saves use the same canonical resources and reject foreign snapshots', async () => {
  const { f, base } = await prepare(), member = await projectMember(f), response = await member.request(path); expect(response.status).toBe(200);
  const view = await response.json(); expect(view.secretStates.map((row: { name: string; saved: boolean }) => ({ name: row.name, saved: row.saved }))).toEqual([{ name: 'KEEP_SECRET', saved: true }, { name: 'REMOVE_SECRET', saved: true }, { name: 'MISSING_SECRET', saved: false }]);
  const request = { schema: 'project-settings-editor-save-v1', clientRequestId: 'member_settings_editor', base, draft: { ...base, instructions: 'Member draft.' }, secretPresence: {} };
  expect((await member.request(path, 'POST', request)).status).toBe(200);
  expect((await f.app.projectWork.settingsView('project')).settings.instructions).toBe('Member draft.');
  expect((await member.request(path, 'POST', { ...request, base: { ...base, projectId: 'another' } })).status).toBe(400);
});
