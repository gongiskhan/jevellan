import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/config/placement-editor';

test('placement editor supplies enabled model snapshots, nullable effort and canonical guidance metadata', async () => {
  const f = fixture = await projectFixture(), response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-placement-editor-v1', projectId: 'project', fields: { allModels: true, modelIds: ['fixture'], minEffort: '', guidance: '' },
    models: [{ id: 'fixture', label: 'Fixture' }], restrictedModelIds: ['fixture'], guidance: { maxLength: 2000 },
    request: { previewPath: path, savePath: '/api/projects/project/config/placement-save', base: { projectId: 'project', revision: 0 } } });
  expect(view.efforts[0]).toEqual({ value: '', label: 'No minimum' }); expect(view.apply.enabled).toBe(true);
  expect(view.patch).toEqual({ allowedModelIds: null, minEffort: null, guidance: '' }); expect(f.fake.runs).toHaveLength(0);
});

test('placement previews preserve explicit hidden ids and verbatim guidance while preparing normal saves', async () => {
  const f = fixture = await projectFixture(), base = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...base, placement: { allowedModelIds: ['retired_model'], minEffort: null, guidance: '' } }, base.revision);
  const response = await f.request(path); expect(response.status).toBe(200); const editor = await response.json();
  expect(editor.fields).toMatchObject({ allModels: false, modelIds: ['retired_model'] }); expect(editor.restrictedModelIds).toEqual(['fixture']);
  const fields = { ...editor.fields, modelIds: editor.restrictedModelIds, minEffort: 'high', guidance: '  Keep this guidance verbatim.  ' };
  const preview = await f.request(path, 'POST', { ...editor.request.base, fields }); expect(preview.status).toBe(200); const next = await preview.json();
  expect(next.patch).toEqual({ allowedModelIds: ['fixture'], minEffort: 'high', guidance: fields.guidance });
  expect((await f.app.projectWork.settingsView('project')).settings.placement.allowedModelIds).toEqual(['retired_model']);
  const saved = await f.request(next.request.savePath, 'POST', next.saveRequest); expect(saved.status).toBe(200); const result = await saved.json();
  expect(result.settings.placement).toEqual(next.patch);
  const repeated = await f.request(next.request.savePath, 'POST', next.saveRequest); expect(repeated.status).toBe(200); expect((await repeated.json()).settings.revision).toBe(result.settings.revision);
  expect(f.fake.runs).toHaveLength(0);
});

test('placement metadata refuses stale and foreign previews and reports invalid drafts without writes', async () => {
  const f = fixture = await projectFixture(), response = await f.request(path); expect(response.status).toBe(200); const editor = await response.json();
  const invalid = await f.request(path, 'POST', { ...editor.request.base, fields: { ...editor.fields, allModels: false, minEffort: 'ultra' } }); expect(invalid.status).toBe(200);
  const rejected = await invalid.json(); expect(rejected.apply.enabled).toBe(false); expect(rejected.patch).toBeNull(); expect(rejected.saveRequest).toBeNull(); expect(rejected.apply.errors.length).toBeGreaterThan(0);
  expect((await f.request(path, 'POST', { ...editor.request.base, projectId: 'other', fields: editor.fields })).status).toBe(400);
  const base = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...base, instructions: 'A newer owner edit.' }, base.revision);
  expect((await f.request(path, 'POST', { ...editor.request.base, fields: editor.fields })).status).toBe(409);
  expect((await f.request(editor.request.savePath, 'POST', editor.saveRequest)).status).toBe(409);
  expect((await f.app.projectWork.settingsView('project')).settings.instructions).toBe('A newer owner edit.');
});

test('member placement editor reads and prepared saves share the hub resources', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), response = await member.request(path); expect(response.status).toBe(200); const editor = await response.json();
  const preview = await member.request(path, 'POST', { ...editor.request.base, fields: { ...editor.fields, allModels: false, modelIds: [], minEffort: '' } }); expect(preview.status).toBe(200); const next = await preview.json();
  expect(next.patch).toEqual({ allowedModelIds: [], minEffort: null, guidance: '' });
  const saved = await member.request(next.request.savePath, 'POST', next.saveRequest); expect(saved.status).toBe(200);
  expect((await f.app.projectWork.settingsView('project')).settings.placement).toEqual(next.patch);
});
