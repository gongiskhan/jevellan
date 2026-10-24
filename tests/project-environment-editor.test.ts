import { ProjectEnvNameSchema, ProjectEnvSecretSummarySchema } from '../packages/core/dist/index.js';
import { environmentSecretSummary } from '../packages/projects/dist/index.js';
import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/config/environment-editor';

test('the check environment editor starts empty instead of copying work inputs', async () => {
  const f = fixture = await projectFixture(), base = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...base, environment: { variables: [{ name: 'WORK_INPUT', value: 'synthetic-work-only-value' }], secrets: ['WORK_CREDENTIAL'], copyFiles: ['.env.work'] } }, base.revision);
  const response = await f.request(path + '?purpose=check'); expect(response.status).toBe(200);
  const view = await response.json();
  expect(view.fields.variables).toEqual([]);
  expect(view.fields.secrets).toEqual([]);
  expect(view.fields.copyFiles).toBe('');
  expect(view).toMatchObject({ purpose: 'check', fields: { enabled: false }, patch: { checkEnvironment: null } });
  expect(f.fake.runs).toHaveLength(0);
});

test('check previews and member saves change only the explicit check profile', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), base = (await f.app.projectWork.settingsView('project')).settings;
  const environment = { variables: [{ name: 'SHARED_NAME', value: 'work-only' }], secrets: [], copyFiles: ['.env.work'] };
  await f.app.projectHub.putSettings({ ...base, setupCommand: 'same configured setup', environment }, base.revision);
  const editor = await (await member.request(path + '?purpose=check')).json();
  const fields = { ...editor.fields, enabled: true, setupCommand: 'must not replace setup', variables: [{ name: 'SHARED_NAME', value: 'check-only' }], secrets: ['CHECK_SECRET'], copyFiles: ' fixtures/test.env => .env.local \n fixtures/config.json \n' };
  const preview = await member.request(path, 'POST', { ...editor.request.base, fields }); expect(preview.status).toBe(200);
  const next = await preview.json(); expect(next.apply.enabled).toBe(true);
  expect(next.patch).toEqual({ checkEnvironment: { schema: 'project-check-environment-v1', variables: fields.variables, secrets: fields.secrets,
    copyFiles: [{ source: 'fixtures/test.env', target: '.env.local' }, { source: 'fixtures/config.json', target: 'fixtures/config.json' }] } });
  const saved = await member.request(next.request.savePath, 'POST', next.saveRequest); expect(saved.status).toBe(200);
  const settings = (await saved.json()).settings; expect(settings.environment).toEqual(environment); expect(settings.setupCommand).toBe('same configured setup');
  expect(settings.checkEnvironment).toEqual(next.patch.checkEnvironment);
  const fresh = await (await member.request(path + '?purpose=check')).json();
  const off = await member.request(path, 'POST', { ...fresh.request.base, fields: { ...fresh.fields, enabled: false } });
  expect(off.status).toBe(200); const disabled = await off.json(); expect(disabled.patch).toEqual({ checkEnvironment: null });
  expect((await member.request(disabled.request.savePath, 'POST', disabled.saveRequest)).status).toBe(200);
  expect((await f.app.projectWork.settingsView('project')).settings).toMatchObject({ environment, checkEnvironment: null, setupCommand: 'same configured setup' });
  expect(f.fake.runs).toHaveLength(0);
});

test('check file previews reject escaping paths and duplicate targets without changing saved inputs', async () => {
  const f = fixture = await projectFixture(), editor = await (await f.request(path + '?purpose=check')).json();
  for (const copyFiles of ['../outside => .env.local', 'fixtures/check.env => ../outside', 'fixtures/a => .env.local\nfixtures/b => .env.local']) {
    const response = await f.request(path, 'POST', { ...editor.request.base, fields: { ...editor.fields, enabled: true, copyFiles } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ apply: { enabled: false }, patch: null, saveRequest: null });
  }
  expect((await f.app.projectWork.settingsView('project')).settings.checkEnvironment).toBeUndefined();
  expect((await f.request(path + '?purpose=production')).status).toBe(400);
});

test('check secret summaries never read a work secret with the same name', async () => {
  const f = fixture = await projectFixture();
  await f.app.state.environment.put('project', 'SHARED_NAME', 'synthetic-work-only-value');
  const response = await f.request('/api/projects/project/env-secrets/SHARED_NAME?purpose=check');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: 'SHARED_NAME', saved: false });
  expect(await f.app.state.environment.summary('project', 'SHARED_NAME')).toMatchObject({ saved: true });
});

test('removing a check secret leaves the work secret with the same name intact', async () => {
  const f = fixture = await projectFixture();
  await f.app.state.environment.put('project', 'SHARED_NAME', 'synthetic-work-only-value');
  const response = await f.request('/api/projects/project/env-secrets/SHARED_NAME?purpose=check', 'DELETE', { schema: 'empty-request-v1' });
  expect(response.status).toBe(200);
  expect(await f.app.state.environment.summary('project', 'SHARED_NAME')).toMatchObject({ saved: true });
});

test('check secrets are stored independently under the same environment name', async () => {
  const f = fixture = await projectFixture(), base = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...base, environment: { variables: [], secrets: ['SHARED_NAME'], copyFiles: [] },
    checkEnvironment: { schema: 'project-check-environment-v1', variables: [], secrets: ['SHARED_NAME'], copyFiles: [] } }, base.revision);
  await f.app.state.environment.put('project', 'SHARED_NAME', 'synthetic-work-only-value');
  const response = await f.request('/api/projects/project/env-secrets/SHARED_NAME?purpose=check', 'PUT', { schema: 'save-secret-v1', value: 'synthetic-check-only-value' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ purpose: 'check', saved: true });
  expect(await f.app.state.environment.credentials('project')).toEqual({ SHARED_NAME: 'synthetic-work-only-value' });
  expect(await f.app.state.environment.credentials('project', 'check')).toEqual({ SHARED_NAME: 'synthetic-check-only-value' });
  const member = await projectMember(f);
  expect(await member.app.state.environment.credentials('project', 'check')).toEqual({ SHARED_NAME: 'synthetic-check-only-value' });
  expect(await member.app.state.environment.credentials('project')).toEqual({ SHARED_NAME: 'synthetic-work-only-value' });
});

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
