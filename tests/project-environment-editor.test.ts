import { ProjectEnvNameSchema, ProjectEnvSecretSummarySchema } from '../packages/core/dist/index.js';
import { environmentSecretSummary } from '../packages/projects/dist/index.js';
import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/config/environment-editor';

test('environment editor exposes canonical counts and text bounds without password values', async () => {
  const f = fixture = await projectFixture(), base = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...base, environment: { ...base.environment, secrets: ['FIXTURE_SECRET'] } }, base.revision);
  const value = 'fixture vault-only value'; await f.app.state.environment.put('project', 'FIXTURE_SECRET', value);
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-environment-editor-v1', limits: { variables: 200, secrets: 100, copyFiles: 20, name: 64, value: 4000, setupCommand: 500, copyPath: 300 },
    fields: { setupCommand: '', copyFiles: '', variables: [], secrets: ['FIXTURE_SECRET'] }, canAddVariable: true, canAddSecret: true });
  expect(JSON.stringify(view).includes(value), 'Password values stay outside editor metadata.').toBe(false); expect(f.fake.runs).toHaveLength(0);
});

test('environment previews normalize copy lines and empty setup while preserving other raw values', async () => {
  const f = fixture = await projectFixture(), response = await f.request(path); expect(response.status).toBe(200); const editor = await response.json();
  const fields = { setupCommand: '  ', copyFiles: ' .env.local \n\n config/local \n', variables: [{ name: 'FIXTURE_PATH', value: ' value with spaces ' }], secrets: ['FIXTURE_SECRET'] };
  const preview = await f.request(path, 'POST', { ...editor.request.base, fields }); expect(preview.status).toBe(200); const next = await preview.json();
  expect(next.fields).toEqual(fields); expect(next.patch).toEqual({ setupCommand: '  ', environment: { variables: fields.variables, secrets: fields.secrets, copyFiles: ['.env.local', 'config/local'] } });
  expect((await f.app.projectWork.settingsView('project')).settings.environment.variables).toEqual([]);
  const saved = await f.request(next.request.savePath, 'POST', next.saveRequest); expect(saved.status).toBe(200); const current = (await saved.json()).settings;
  expect(current.environment).toEqual(next.patch.environment); expect(current.setupCommand).toBe('  ');
  expect((await f.request(next.request.savePath, 'POST', next.saveRequest)).status).toBe(200);
  const fresh = await (await f.request(path)).json();
  const empty = await f.request(path, 'POST', { ...fresh.request.base, fields: { ...fresh.fields, setupCommand: '' } }); expect(empty.status).toBe(200); expect((await empty.json()).patch.setupCommand).toBeNull();
});

test('environment validation rejects duplicate and reserved names, escaping paths and password-shaped fields', async () => {
  const f = fixture = await projectFixture(), response = await f.request(path); expect(response.status).toBe(200); const editor = await response.json();
  const drafts = [{ ...editor.fields, variables: [{ name: 'SAME_NAME', value: '' }], secrets: ['SAME_NAME'] },
    { ...editor.fields, variables: [{ name: 'JEVELLAN_RESERVED', value: '' }] }, { ...editor.fields, copyFiles: '../outside' }];
  for (const fields of drafts) { const result = await f.request(path, 'POST', { ...editor.request.base, fields }); expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ apply: { enabled: false }, patch: null, saveRequest: null }); }
  expect((await f.request(path, 'POST', { ...editor.request.base, fields: { ...editor.fields, secretValues: { FIXTURE_SECRET: 'fixture-only value' } } })).status).toBe(400);
  expect((await f.request(path, 'POST', { ...editor.request.base, projectId: 'other', fields: editor.fields })).status).toBe(400);
  const base = (await f.app.projectWork.settingsView('project')).settings; await f.app.projectHub.putSettings({ ...base, instructions: 'Newer owner instructions.' }, base.revision);
  expect((await f.request(path, 'POST', { ...editor.request.base, fields: editor.fields })).status).toBe(409);
  expect((await f.request(editor.request.savePath, 'POST', editor.saveRequest)).status).toBe(409);
});

test('environment Add availability follows the engine counts beyond the former browser cap', async () => {
  const f = fixture = await projectFixture(), response = await f.request(path); expect(response.status).toBe(200); const editor = await response.json();
  const fields = { ...editor.fields, variables: Array.from({ length: 200 }, (_, index) => ({ name: `VARIABLE_${index}`, value: '' })), secrets: Array.from({ length: 100 }, (_, index) => `SECRET_${index}`) };
  const preview = await f.request(path, 'POST', { ...editor.request.base, fields }); expect(preview.status).toBe(200); const next = await preview.json();
  expect(next).toMatchObject({ canAddVariable: false, canAddSecret: false, apply: { enabled: true } });
  expect(next.patch.environment.variables).toHaveLength(200); expect(next.patch.environment.secrets).toHaveLength(100);
});

test('vault-only replies and the settings reader supply secret status presentations without values', async () => {
  const f = fixture = await projectFixture(), base = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...base, environment: { ...base.environment, secrets: ['FIXTURE_SECRET'] } }, base.revision);
  const value = 'fixture vault-only value', saved = await f.request('/api/projects/project/env-secrets/FIXTURE_SECRET', 'PUT', { schema: 'save-secret-v1', value }); expect(saved.status).toBe(200); const summary = await saved.json();
  expect(summary.presentation, 'The engine supplies secret-status copy.').toBeDefined();
  expect(summary.presentation).toMatchObject({ schema: 'project-env-secret-presentation-v1', parts: [{ kind: 'text', text: 'Saved · updated ' }, { kind: 'time', at: summary.updatedAt }] });
  expect(JSON.stringify(summary).includes(value), 'Vault-only replies never echo their value.').toBe(false);
  const settings = await (await f.request('/api/projects/project/config/editor')).json(); expect(settings.secretStates[0].presentation).toEqual(summary.presentation);
  const removed = await f.request('/api/projects/project/env-secrets/FIXTURE_SECRET', 'DELETE', { schema: 'empty-request-v1' }); expect(removed.status).toBe(200); expect((await removed.json()).presentation.parts).toEqual([{ kind: 'text', text: 'Not set' }]);
});

test('member environment reads and prepared saves use the same canonical settings writer', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), response = await member.request(path); expect(response.status).toBe(200); const editor = await response.json();
  const preview = await member.request(path, 'POST', { ...editor.request.base, fields: { ...editor.fields, copyFiles: ' local.env \n', variables: [{ name: 'FIXTURE_VAR', value: 'member value' }] } }); expect(preview.status).toBe(200); const next = await preview.json();
  const saved = await member.request(next.request.savePath, 'POST', next.saveRequest); expect(saved.status).toBe(200);
  expect((await f.app.projectWork.settingsView('project')).settings.environment).toMatchObject({ copyFiles: ['local.env'], variables: [{ name: 'FIXTURE_VAR', value: 'member value' }] });
});

test('environment name bounds and old value-free summaries keep their existing contracts', () => {
  expect(ProjectEnvNameSchema.safeParse('A'.repeat(64)).success).toBe(true); expect(ProjectEnvNameSchema.safeParse('A'.repeat(65)).success).toBe(false);
  const old = { schema: 'project-env-secret-summary-v1', name: 'FIXTURE_SECRET', saved: true };
  expect(ProjectEnvSecretSummarySchema.safeParse(old).success).toBe(true);
  const next = environmentSecretSummary(ProjectEnvSecretSummarySchema.parse(old)); expect(next.presentation?.parts).toEqual([{ kind: 'text', text: 'Saved' }]);
  expect(ProjectEnvSecretSummarySchema.safeParse({ ...next, presentation: { ...next.presentation, unexpected: true } }).success).toBe(false);
});
