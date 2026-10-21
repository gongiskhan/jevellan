import { afterEach, expect, test } from 'vitest';
import { accountEditorFixture } from './helpers/account-editor-fixture.js';
import { projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });

async function editor(query = 'runtime=claude') {
  const response = await f!.request(`/api/accounts/editor?${query}`); expect(response.status).toBe(200); return response.json();
}
const preview = (view: { context: unknown; fields: unknown }, extra: object = {}) => ({ schema: 'account-editor-preview-v1', context: view.context, fields: view.fields, credentialPresent: false, ...extra });

test('account editor owns canonical defaults, supported kinds and endpoint constraints without credentials', async () => {
  f = await accountEditorFixture(); const view = await editor();
  expect(view).toMatchObject({ schema: 'account-editor-view-v1', context: { mode: 'create', runtime: 'claude', accountId: null, revision: 0 }, fields: { label: '', kind: 'subscription', ceilingPct: '90', paidUse: '', endpoint: { billing: 'subscription', models: [{ id: '', label: '', efforts: ['medium'], description: '' }] } }, inputs: { label: { maxLength: 128 }, ceiling: { min: 0, max: 100, step: 'any' }, kind: { options: [{ value: 'subscription' }, { value: 'api-key' }, { value: 'endpoint' }] } }, endpoint: { limits: { models: 10, modelId: 200, label: 80, description: 600, background: 200 } }, canSave: false, plan: null });
  expect(view).not.toHaveProperty('credentialValue'); expect(view).not.toHaveProperty('secret');
  const fake = await editor('runtime=fake'); expect(fake.inputs.kind.options.map((option: { value: string }) => option.value)).toEqual(['subscription']);
});

test('account editor prepares API key writes with presence facts but accepts secret bytes only at the normal save', async () => {
  f = await accountEditorFixture(); const view = await editor(), fields = { ...view.fields, label: 'Fixture key', kind: 'api-key', paidUse: 'never' };
  let response = await f.request('/api/accounts/editor/preview', 'POST', preview({ ...view, fields })); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ canSave: false, plan: null });
  response = await f.request('/api/accounts/editor/preview', 'POST', preview({ ...view, fields }, { credentialPresent: true })); expect(response.status).toBe(200); const ready = await response.json();
  expect(ready).toMatchObject({ canSave: true, plan: { primary: { path: '/hub/accounts', method: 'POST', body: { schema: 'add-account-v1', runtime: 'claude', kind: 'api-key', paidUse: 'never' } }, startLogin: false } });
  expect(ready.plan.primary.body).not.toHaveProperty('secret');
  expect((await f.request('/api/accounts/editor/preview', 'POST', { ...preview({ ...view, fields }), credential: 'fixture-not-a-real-credential' })).status).toBe(400);
  const saved = await f.request('/api/accounts/editor/save', 'POST', { schema: 'account-editor-save-v1', context: view.context, fields, credential: 'fixture-account-editor-credential', clientRequestId: 'account_editor_create' }); expect(saved.status).toBe(201);
  const result = await saved.json(); expect(result).toMatchObject({ schema: 'account-editor-saved-v1', startLogin: false, account: { account: { kind: 'api-key', label: 'Fixture key', paidUse: 'never' }, secret: { saved: true } } });
  expect(JSON.stringify(result)).not.toContain('fixture-account-editor-credential'); expect(f.fake.runs).toHaveLength(0);
});

test('account editor owns endpoint model commands, metered policy and background normalization', async () => {
  f = await accountEditorFixture(); const view = await editor();
  const fields = { ...view.fields, label: 'Fixture endpoint', kind: 'endpoint', paidUse: 'always', endpoint: { baseUrl: 'https://api.example.test/anthropic', billing: 'metered', models: [{ id: 'alpha', label: 'Alpha', efforts: ['high'], description: 'Fixture model' }], backgroundModel: ' alpha ' } };
  const response = await f.request('/api/accounts/editor/preview', 'POST', preview({ ...view, fields }, { credentialPresent: true })); expect(response.status).toBe(200); const ready = await response.json();
  expect(ready).toMatchObject({ canSave: true, paid: { visible: true }, endpoint: { canAdd: true, canRemove: false, backgroundPlaceholder: 'alpha' }, plan: { primary: { body: { endpoint: { backgroundModel: 'alpha', billing: 'metered' }, paidUse: 'always' } } } });
  const added = await f.request('/api/accounts/editor/preview', 'POST', preview({ ...view, fields }, { credentialPresent: true, command: { kind: 'add-model' } })); expect(added.status).toBe(200); const two = await added.json();
  expect(two.fields.endpoint.models).toEqual([...fields.endpoint.models, { id: '', label: '', efforts: ['medium'], description: '' }]); expect(two.endpoint.canRemove).toBe(true); expect(two.canSave).toBe(false);
  const removed = await f.request('/api/accounts/editor/preview', 'POST', preview(two, { credentialPresent: true, command: { kind: 'remove-model', index: 1 } })); expect(removed.status).toBe(200); expect((await removed.json()).fields.endpoint.models).toEqual(fields.endpoint.models);
});

test('account editor member edits preserve immutable kind and enabled state and enforce canonical revision checks', async () => {
  f = await accountEditorFixture(); const member = await projectMember(f);
  const response = await member.request('/api/accounts/editor?runtime=fake&accountId=acc_fixture'); expect(response.status).toBe(200); const view = await response.json();
  const before = await f.app.accounts.get('acc_fixture'), fields = { ...view.fields, label: 'Edited fixture', ceilingPct: '90.5' }, request = { schema: 'account-editor-save-v1', context: view.context, fields, clientRequestId: 'account_editor_member' };
  const save = await member.request('/api/accounts/editor/save', 'POST', request); expect(save.status).toBe(200); expect(await save.json()).toMatchObject({ schema: 'account-editor-saved-v1', account: { account: { label: 'Edited fixture', ceilingPct: 90.5, kind: before.account.kind, enabled: before.account.enabled } } });
  const stale = await member.request('/api/accounts/editor/save', 'POST', { ...request, clientRequestId: 'account_editor_stale', fields: { ...fields, label: 'Stale edit' } }); expect(stale.status).toBe(409);
  expect((await f.app.accounts.get('acc_fixture')).account.label).toBe('Edited fixture');
});

test('account editor replace-key mode prepares only the canonical credential write', async () => {
  f = await accountEditorFixture(); const account = await f.app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Replace fixture', kind: 'api-key', paidUse: 'never', secret: 'fixture-initial-key' });
  const view = await editor(`runtime=claude&accountId=${account.account.id}&mode=replace-key`);
  expect(view).toMatchObject({ context: { mode: 'replace-key' }, credential: { required: true, label: 'New API key' }, canSave: false });
  const response = await f.request('/api/accounts/editor/preview', 'POST', preview(view, { credentialPresent: true })); expect(response.status).toBe(200); const ready = await response.json();
  expect(ready).toMatchObject({ canSave: true, plan: { primary: { path: `/hub/accounts/${account.account.id}/credential`, method: 'PUT', body: { schema: 'replace-credential-v1', revision: account.revision } }, startLogin: false } }); expect(ready.plan.primary.body).not.toHaveProperty('secret');
});

test('account editor baseline canonical writer already accepts fractional ceilings', async () => {
  f = await accountEditorFixture(); const before = await f.app.accounts.get('acc_fixture');
  const response = await f.request('/hub/accounts/acc_fixture', 'PATCH', { schema: 'update-account-v1', revision: before.revision, label: before.account.label, enabled: before.account.enabled, ceilingPct: 90.5, clientRequestId: 'account_fractional_baseline' });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ account: { ceilingPct: 90.5, kind: before.account.kind, enabled: before.account.enabled, label: before.account.label } });
});
