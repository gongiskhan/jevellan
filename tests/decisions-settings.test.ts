import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConfigRevisionSchema, EffortSchema, OwnerToolResultSchema, suggestedEffortCriteria, DecisionsSettingsEditorSchema, JevConnectionViewSchema, type DecisionsSettingsFields, type DecisionsSettingsPreview, type DecisionsSettingsEditor } from '../packages/core/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { HubUnavailable } from '../packages/mesh/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

type Fields = DecisionsSettingsFields;
type Preview = DecisionsSettingsPreview;
type Editor = DecisionsSettingsEditor;
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
async function setup() {
  const fake = new FakeRuntime();
  fake.listModels = async () => [
    { id: 'scripted-model', label: 'Scripted model', efforts: [...EffortSchema.options] },
    { id: 'second-scripted', label: 'Second scripted model', efforts: ['medium', 'high'] },
  ];
  const provider = vi.fn<typeof fetch>(async () => Response.json({ models: [{ name: 'jev-settings-fixture', description: 'Simulated settings model.', release_date: '2026-10-20' }] }));
  f = await projectFixture({ control: true, runtimes: { fake }, decisionFetch: provider });
  await f.app.accounts.discover('acc_fixture');
  return provider;
}
async function editor(read = f!.request): Promise<Editor> {
  const response = await read('/api/config/decisions'); expect(response.status).toBe(200);
  const value = DecisionsSettingsEditorSchema.parse(await response.json()); expect(value.schema).toBe('decisions-settings-editor-v1'); return value;
}
async function preview(view: Editor, fields: Fields, command?: Preview['command']): Promise<Editor> {
  const response = await f!.request(view.preview.path, 'POST', { ...view.preview.request, fields, ...(command ? { command } : {}) }); expect(response.status).toBe(200); return DecisionsSettingsEditorSchema.parse(await response.json());
}

test('Decisions editor supplies authoritative offers, guard defaults and availability without writing configuration', async () => {
  await setup(); const before = f!.app.hub.configuration.current()!, view = await editor();
  expect(view.revision).toBe(before.revision); expect(view.currentRevision).toBe(before.revision);
  expect(view.fields.model).toBe(before.configuration['x-jevellan'].decisions.model);
  expect(view.fields.guards).toMatchObject({ maxStretchesPerWork: '24', stretchTimeoutMin: '30', reviewCap: '2', noProgressLimit: '2', testFailureLimit: '3', externalActivityWindowMin: '5', workCostCapUsd: '', pauseAfterPlan: true });
  expect(view.rows).toHaveLength(1); expect(view.rows[0]).toMatchObject({ id: 'fixture', canEnable: true });
  expect(view.candidates).toEqual([{ key: 'fake/second-scripted', label: 'Second scripted model', runtime: 'fake' }]);
  expect(view.guardFields.find(row => row.key === 'reviewCap')).toMatchObject({ min: 0, step: '1' });
  expect(view.guardFields.find(row => row.key === 'stretchTimeoutMin')).toMatchObject({ min: 0, step: 'any' });
  expect(view.canSave).toBe(true); expect(view.validation).toEqual([]); expect(f!.app.hub.configuration.current()).toEqual(before);
  expect((await fetch(`${f!.base}/api/config/decisions`)).status).toBe(401);
  expect((await f!.request(view.preview.path, 'POST', { ...view.preview.request, arbitrary: true })).status).toBe(400);
});

test('section saves preserve other settings and recover their committed receipt before later revision changes', async () => {
  await setup(); const current = f!.app.hub.configuration.current()!, outside = structuredClone(current.configuration);
  outside.name = 'Preserved configuration name'; outside['x-jevellan'].maxRunningThreadsAll = 4;
  f!.app.hub.configuration.put(outside, current.revision, { deviceId: 'other_device', source: 'ui' });
  const view = await editor(), fields = structuredClone(view.fields); fields.routingProfile = 'Settings fixture routing.'; fields.guards.workCostCapUsd = '';
  const draft = await preview(view, fields); expect(draft.canSave).toBe(true); expect(draft.saveRequest).not.toBeNull();
  const before = f!.app.hub.configuration.current()!;
  vi.spyOn(f!.app, 'applyRigging').mockRejectedValueOnce(new HubUnavailable('Simulated post-save hub loss'));
  const lost = await f!.request('/api/config/decisions', 'PUT', draft.saveRequest); expect(lost.status).toBe(503); expect(await lost.json()).toMatchObject({ retryable: true });
  const saved = f!.app.hub.configuration.current()!; expect(saved.revision).toBe(before.revision + 1); expect(saved.configuration.name).toBe(outside.name); expect(saved.configuration['x-jevellan'].maxRunningThreadsAll).toBe(4);
  expect(saved.configuration['x-jevellan'].guards.workCostCapUsd).toBeNull(); expect(saved.configuration['x-jevellan'].routingProfile).toBe(fields.routingProfile);
  const later = structuredClone(saved.configuration); later['x-jevellan'].runtimes.fake!.useOwnSetup = false;
  const newest = f!.app.hub.configuration.put(later, saved.revision, { deviceId: 'other_device', source: 'ui' });
  const retry = await f!.request('/api/config/decisions', 'PUT', draft.saveRequest); expect(retry.status).toBe(200); expect(ConfigRevisionSchema.parse(await retry.json())).toEqual(saved); expect(f!.app.hub.configuration.current()).toEqual(newest);
  expect((await f!.request('/api/config/decisions', 'PUT', { ...draft.saveRequest, fields: { ...fields, routingProfile: 'Conflicting retry' } })).status).toBe(409);
  const stale = await preview(view, fields); expect(stale.canSave).toBe(false); expect(stale.staleNotice).toContain('changed'); expect(stale.fields).toEqual(fields);
});

test('menu additions are engine-generated drafts with canonical limits and unavailable models cannot be enabled', async () => {
  await setup(); const candidates = await f!.request('/api/jev/menu-candidates'); expect(candidates.status).toBe(200);
  const view = await editor(), before = f!.app.hub.configuration.current()!;
  const added = await f!.request('/api/jev/menu', 'POST', { ...view.preview.request, command: { kind: 'add-model', offerKey: 'fake/second-scripted' } }); expect(added.status).toBe(200); const draft = DecisionsSettingsEditorSchema.parse(await added.json());
  expect(draft.fields.menu).toHaveLength(2); const row = draft.fields.menu.at(-1)!; expect(row.id).toMatch(/^model_/u); expect(row).toMatchObject({ label: 'Second scripted model', enabled: true, description: 'Describe when this model fits the work.' });
  expect(f!.app.hub.configuration.current()).toEqual(before); expect(draft.candidates).toEqual([]);
  const duplicate = await f!.request('/api/jev/menu', 'POST', { ...draft.preview.request, fields: draft.fields, command: { kind: 'add-model', offerKey: 'fake/second-scripted' } }); expect(duplicate.status).toBe(400);
  const saved = await f!.request('/api/config/decisions', 'PUT', draft.saveRequest); expect(saved.status).toBe(200); const configured = ConfigRevisionSchema.parse(await saved.json());
  expect(configured.configuration['x-jevellan'].menu.at(-1)).toMatchObject({ id: row.id, runtime: 'fake', model: 'second-scripted', efforts: ['medium', 'high'] });
  const changed = structuredClone(configured.configuration); changed['x-jevellan'].menu = Array.from({ length: 19 }, (_, n) => ({ ...changed['x-jevellan'].menu[0]!, id: `menu_${n}`, model: `configured_${n}` }));
  changed['x-jevellan'].menu[0] = { ...changed['x-jevellan'].menu[0]!, enabled: false, unavailableReason: 'Not offered by this runtime right now.' };
  f!.app.hub.configuration.put(changed, configured.revision, { deviceId: 'other_device', source: 'ui' });
  const unavailable = await editor(); expect(unavailable.rows[0]?.canEnable).toBe(false); expect(unavailable.rows[0]?.reasonLine).toContain('Not offered');
  const fields = structuredClone(unavailable.fields); fields.menu[0]!.enabled = true; const refused = await preview(unavailable, fields); expect(refused.canSave).toBe(false); expect(refused.validation.some(issue => issue.path.includes('enabled'))).toBe(true);
  const full = structuredClone(changed); full['x-jevellan'].menu.push({ ...full['x-jevellan'].menu[1]!, id: 'nineteenth_enabled' });
  f!.app.hub.configuration.put(full, f!.app.hub.configuration.current()!.revision, { deviceId: 'other_device', source: 'ui' });
  const capped = await editor(); expect(capped.canAdd).toBe(false); expect(capped.addRefusal).toBe('The model menu holds 19 models. Disable or remove one first.');
});

test('effort reset and guard validation share server defaults without coercing blank required numbers to zero', async () => {
  await setup(); expect((await f!.request('/api/jev/effort-guide')).status).toBe(200);
  const view = await editor(), fields = structuredClone(view.fields); fields.effortGuide.high = 'Temporary guide.';
  const custom = await preview(view, fields); expect(custom.guide.differsFromSuggested).toBe(true);
  const reset = await f!.request('/api/jev/effort-guide/reset', 'POST', { ...custom.preview.request, fields: custom.fields, command: { kind: 'reset-effort-guide' } }); expect(reset.status).toBe(200); const suggested = DecisionsSettingsEditorSchema.parse(await reset.json());
  expect(suggested.fields.effortGuide).toEqual(suggestedEffortCriteria); expect(suggested.guide.differsFromSuggested).toBe(false);
  const invalid = structuredClone(suggested.fields); invalid.guards.reviewCap = ''; invalid.guards.maxStretchesPerWork = '1.5'; invalid.guards.workCostCapUsd = '0'; invalid.routingProfile = ' ';
  const refused = await preview(suggested, invalid); expect(refused.canSave).toBe(false); expect(refused.saveRequest).toBeNull();
  expect(refused.validation.map(issue => issue.path)).toEqual(expect.arrayContaining(['guards.reviewCap', 'guards.maxStretchesPerWork', 'guards.workCostCapUsd', 'routingProfile']));
  const valid = structuredClone(suggested.fields); valid.guards.reviewCap = '0'; valid.guards.stretchTimeoutMin = '0.5'; valid.guards.externalActivityWindowMin = '0.25'; valid.guards.workCostCapUsd = '0.005';
  const previewed = await preview(suggested, valid); expect(previewed.canSave).toBe(true);
  const saved = await f!.request('/api/config/decisions', 'PUT', previewed.saveRequest); expect(saved.status).toBe(200); expect(ConfigRevisionSchema.parse(await saved.json()).configuration['x-jevellan'].guards).toMatchObject({ reviewCap: 0, stretchTimeoutMin: 0.5, externalActivityWindowMin: 0.25, workCostCapUsd: 0.005 });
});

test('connection and model validation use the last successful check for the current managed key only', async () => {
  const provider = await setup(); const empty = await f!.request('/api/jev/connection'); expect(empty.status).toBe(200); expect(await empty.json()).toMatchObject({ saved: false, canTest: false, lastFour: null, result: null });
  const secret = `fixture-${randomUUID()}`; expect((await f!.request('/hub/secrets/jev', 'PUT', { schema: 'save-secret-v1', value: secret, clientRequestId: 'settings_key_one' })).status).toBe(200);
  const check = await f!.request('/api/decisions/check', 'POST', { schema: 'empty-request-v1' }); expect(check.status).toBe(200); expect(await check.json()).toMatchObject({ status: 'connected', savedModelListed: false }); expect(provider).toHaveBeenCalledOnce();
  const connection = JevConnectionViewSchema.parse(await (await f!.request('/api/jev/connection')).json()); expect(connection).toMatchObject({ saved: true, canTest: true, lastFour: secret.slice(-4), result: { heading: 'Connected to Jev.', savedModelListed: false } });
  expect(JSON.stringify(connection).includes(secret)).toBe(false);
  const view = await editor(), missing = { ...view.fields, model: 'not-returned' }; const refused = await preview(view, missing); expect(refused.canSave).toBe(false); expect(refused.validation.some(issue => issue.path === 'model')).toBe(true);
  const fields = { ...view.fields, model: 'jev-settings-fixture' }, allowed = await preview(view, fields); expect(allowed.canSave).toBe(true); expect((await f!.request('/api/config/decisions', 'PUT', allowed.saveRequest)).status).toBe(200);
  expect(JevConnectionViewSchema.parse(await (await f!.request('/api/jev/connection')).json()).result?.savedModelListed).toBe(true);
  const second = `fixture-${randomUUID()}`; expect((await f!.request('/hub/secrets/jev', 'PUT', { schema: 'save-secret-v1', value: second, clientRequestId: 'settings_key_two' })).status).toBe(200);
  expect(JevConnectionViewSchema.parse(await (await f!.request('/api/jev/connection')).json()).result).toBeNull();
  const fresh = await editor(), revalidate = await preview(fresh, { ...fresh.fields, model: 'not-returned' }); expect(revalidate.canSave).toBe(false);
  const unrelated = await preview(fresh, { ...fresh.fields, routingProfile: 'Keep the current configured model.' }); expect(unrelated.canSave).toBe(true);
});

test('member UI and explicit owner tools share section models and the hub canonical save', async () => {
  await setup(); const member = await projectMember(f!); const remote = await editor(member.request), local = await editor(); expect(remote.fields).toEqual(local.fields);
  const answer = OwnerToolResultSchema.parse(await f!.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'bridge:project', args: { action: 'settings_editor' } })); expect(answer.ok).toBe(true); if (!answer.ok) throw new Error('Expected the settings editor.');
  expect(DecisionsSettingsEditorSchema.parse(answer.data).fields).toEqual(local.fields);
  const fields = structuredClone(remote.fields); fields.routingProfile = 'Member settings fixture.';
  const previewResponse = await member.request(remote.preview.path, 'POST', { ...remote.preview.request, fields }); expect(previewResponse.status).toBe(200); const draft = DecisionsSettingsEditorSchema.parse(await previewResponse.json());
  const saved = await member.request('/api/config/decisions', 'PUT', draft.saveRequest); expect(saved.status).toBe(200); expect(ConfigRevisionSchema.parse(await saved.json()).changedBy.deviceId).toBe(member.deviceId);
  expect(f!.app.hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe(fields.routingProfile);
  expect(member.hubCalls.some(call => call.includes('decisions-put'))).toBe(true);
});

test('a key changed during a connection check cannot attest the replacement credential', async () => {
  const provider = await setup();
  await f!.request('/hub/secrets/jev', 'PUT', { schema: 'save-secret-v1', value: `fixture-${randomUUID()}`, clientRequestId: 'check_key_before' });
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  provider.mockImplementationOnce(async () => { entered(); await waiting; return Response.json({ models: [{ name: 'jev-settings-fixture', description: 'Old key response.', release_date: '2026-10-20' }] }); });
  const checking = f!.request('/api/decisions/check', 'POST', { schema: 'empty-request-v1' });
  try {
    await started;
    expect((await f!.request('/hub/secrets/jev', 'PUT', { schema: 'save-secret-v1', value: `fixture-${randomUUID()}`, clientRequestId: 'check_key_after' })).status).toBe(200);
  } finally { release(); }
  expect((await checking).status).toBe(409);
  expect(JevConnectionViewSchema.parse(await (await f!.request('/api/jev/connection')).json()).result).toBeNull();
});

test('saved-menu limits and draft offer identity are enforced independently of browser controls', async () => {
  await setup(); const initial = await editor(), fields = structuredClone(initial.fields);
  fields.menu.push({ id: 'model_forged', offerKey: 'fake/second-scripted', label: 'Forged', description: 'Fixture description.', enabled: true });
  const forged = await preview(initial, fields); expect(forged.canSave).toBe(false); expect(forged.validation.some(issue => issue.path === 'menu.model_forged.id')).toBe(true);
  const raw = { ...initial.preview.request, fields: { ...initial.fields, menu: [{ ...initial.fields.menu[0], runtime: 'unoffered' }] } };
  expect((await f!.request(initial.preview.path, 'POST', raw)).status).toBe(400);
  const current = f!.app.hub.configuration.current()!, configuration = structuredClone(current.configuration);
  configuration['x-jevellan'].menu = Array.from({ length: 200 }, (_, index) => ({ ...configuration['x-jevellan'].menu[0]!, id: `saved_${index}`, model: `not_offered_${index}`, enabled: false }));
  f!.app.hub.configuration.put(configuration, current.revision, { deviceId: 'other_device', source: 'ui' });
  const full = await editor(); expect(full.canAdd).toBe(false); expect(full.addRefusal).toBe('The saved model list is full. Remove a disabled model first.');
  expect((await f!.request('/api/jev/menu', 'POST', { ...full.preview.request, command: { kind: 'add-model', offerKey: 'fake/second-scripted' } })).status).toBe(400);
  expect(f!.app.hub.configuration.current()?.configuration['x-jevellan'].menu).toHaveLength(200);
});

test('failed checks invalidate model evidence and replaying a key-save receipt does not invalidate a successful check', async () => {
  const provider = await setup(), value = `fixture-${randomUUID()}-same`, keySave = { schema: 'save-secret-v1', value, clientRequestId: 'same_key_receipt' };
  expect((await f!.request('/hub/secrets/jev', 'PUT', keySave)).status).toBe(200);
  expect((await f!.request('/api/decisions/check', 'POST', { schema: 'empty-request-v1' })).status).toBe(200);
  expect((await f!.request('/hub/secrets/jev', 'PUT', keySave)).status).toBe(200);
  expect(JevConnectionViewSchema.parse(await (await f!.request('/api/jev/connection')).json()).result).not.toBeNull();
  provider.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await f!.request('/api/decisions/check', 'POST', { schema: 'empty-request-v1' })).status).toBe(200);
  const view = await editor(), fields = { ...view.fields, model: 'jev-settings-fixture' };
  expect((await preview(view, fields)).canSave).toBe(false);
  expect((await f!.request('/api/decisions/check', 'POST', { schema: 'empty-request-v1' })).status).toBe(200);
  expect((await preview(view, fields)).canSave).toBe(true);
  expect((await f!.request('/hub/secrets/jev', 'PUT', { ...keySave, value: `fixture-${randomUUID()}-same`, clientRequestId: 'same_suffix_new_key' })).status).toBe(200);
  expect(JevConnectionViewSchema.parse(await (await f!.request('/api/jev/connection')).json()).result).toBeNull();
  expect((await preview(view, fields)).canSave).toBe(false);
});

test('a member recovers a committed section save after a lost RPC reply without replacing newer configuration', async () => {
  await setup(); const member = await projectMember(f!), view = await editor(member.request), fields = { ...view.fields, routingProfile: 'Recover the member section save.' };
  const response = await member.request(view.preview.path, 'POST', { ...view.preview.request, fields }); expect(response.status).toBe(200); const draft = DecisionsSettingsEditorSchema.parse(await response.json());
  let lose = true; member.loseReply = call => { if (lose && call.endsWith(' decisions-put')) { lose = false; return true; } return false; };
  const interrupted = await member.request('/api/config/decisions', 'PUT', draft.saveRequest); expect(interrupted.status).toBe(503); expect(await interrupted.json()).toMatchObject({ retryable: true });
  const saved = f!.app.hub.configuration.current()!, later = structuredClone(saved.configuration); later.name = 'A newer independent setting';
  const newest = f!.app.hub.configuration.put(later, saved.revision, { deviceId: 'other_device', source: 'ui' });
  const recovered = await member.request('/api/config/decisions', 'PUT', draft.saveRequest); expect(recovered.status).toBe(200); expect(ConfigRevisionSchema.parse(await recovered.json())).toEqual(saved);
  expect(f!.app.hub.configuration.current()).toEqual(newest); expect(saved.changedBy.deviceId).toBe(member.deviceId);
});

test('an enabled legacy unavailable model can be turned off through the engine-projected toggle', async () => {
  await setup(); const current = f!.app.hub.configuration.current()!, configuration = structuredClone(current.configuration);
  configuration['x-jevellan'].menu[0] = { ...configuration['x-jevellan'].menu[0]!, enabled: true, unavailableReason: 'Not offered by this runtime right now.' };
  f!.app.hub.configuration.put(configuration, current.revision, { deviceId: 'other_device', source: 'ui' });
  const view = await editor(); expect(view.rows[0]).toMatchObject({ canEnable: false, canToggle: true });
  const fields = structuredClone(view.fields); fields.menu[0]!.enabled = false; const draft = await preview(view, fields); expect(draft.canSave).toBe(true);
  expect((await f!.request('/api/config/decisions', 'PUT', draft.saveRequest)).status).toBe(200);
  expect((await editor()).rows[0]).toMatchObject({ canEnable: false, canToggle: false });
});
