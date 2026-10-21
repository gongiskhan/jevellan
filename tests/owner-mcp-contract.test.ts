import { accountEditorFixture } from './helpers/account-editor-fixture.js';
import { ProjectEnvironmentEditorSchema } from '../packages/core/dist/index.js';
import { ProjectPlacementEditorSchema } from '../packages/core/dist/index.js';
import { ConversationDecisionWhyViewSchema, StepCorrectionEditorSchema } from '../packages/core/dist/index.js';
import { ConfigRevisionSchema, DecisionsSettingsEditorSchema } from '../packages/core/dist/index.js';
import { ImproverStateSchema } from '../packages/core/dist/index.js';
import { ProjectCoordinatorEditorSchema } from '../packages/core/dist/index.js';
import { ProjectSettingsChangeViewSchema } from '../packages/core/dist/index.js';
import { ProjectLandingEditorSchema } from '../packages/core/dist/index.js';
import { ProjectSettingsEditorSchema } from '../packages/core/dist/index.js';
import { seedConversationDecision } from './helpers/conversation-decision-fixture.js';
import { ConversationComposerViewSchema } from '../packages/core/dist/index.js';
import { seedRouteDecision } from './helpers/route-fixtures.js';
import { afterEach, expect, test } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProjectRouteWhyViewSchema, ProjectThreadOverrideEditorSchema, ThreadCreatedViewSchema, OWNER_TOOLS, OwnerToolResultSchema, ProjectGoalEditorSchema, ProjectJobEditorSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { reportStep, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close().catch(() => undefined); client = undefined; await f?.close(); f = undefined; });
async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'bin', 'jevellan.mjs'), 'mcp'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, cwd: f!.checkout, stderr: 'ignore' });
  client = new Client({ name: 'contract', version: '1.0.0' }); await client.connect(transport); return client;
}

test('MCP task mirror preview owns token-removal disabling without writing or starting login', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const request = { schema: 'ekoa-editor-preview-v1', revision: 0, fields: { url: '', enabled: true }, operation: 'remove-token', credentialPresent: false };
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'mirror_preview', request } })).structuredContent); expect(result).toMatchObject({ ok: true, data: { schema: 'ekoa-editor-v1', canSave: true, plan: { body: { enabled: false, removeToken: true } } } });
  expect(f.app.ekoa!.settings().revision).toBe(0); expect(f.fake.runs).toHaveLength(0);
});

test('MCP settings navigation and cleanup writer share the engine model', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const navigation = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'navigation' } })).structuredContent); expect(navigation).toMatchObject({ ok: true, data: { schema: 'settings-navigation-v1', defaultPage: 'runtimes' } });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'cleanup_editor' } })).structuredContent); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected cleanup editor.'); const view = result.data as { revision: number; fields: object };
  const request = { schema: 'cleanup-settings-save-v1', revision: view.revision, fields: { ...view.fields, freeDiskFloorGb: '52.5' }, clientRequestId: 'cleanup_mcp_fixture' };
  for (let attempt = 0; attempt < 2; attempt++) expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'cleanup_save', request } })).structuredContent)).toMatchObject({ ok: true });
  expect((await f.app.configuration()).configuration['x-jevellan'].cleanup.freeDiskFloorGb).toBe(52.5); expect(f.fake.runs).toHaveLength(0);
});

test('MCP Projects editors share folder commands and leave project creation explicit', async () => {
  f = await projectFixture({ control: true }); const before = await f.app.state.projects.list(), mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'project_editor' } })).structuredContent); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected project editor.'); const view = result.data as { context: object; fields: object };
  const request = { schema: 'project-definition-preview-v1', context: view.context, fields: view.fields, command: { type: 'path', deviceId: f.app.device.deviceId, value: f.checkout + '/mcp-folder/' } };
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'project_preview', request } })).structuredContent)).toMatchObject({ ok: true, data: { fields: { name: 'mcp-folder' } } });
  expect(await f.app.state.projects.list()).toEqual(before); expect(f.fake.runs).toHaveLength(0);
});

test('MCP account editor shares nonsecret preparation and never starts a provider login', async () => {
  f = await accountEditorFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'account_editor', runtime: 'claude' } })).structuredContent); expect(result.ok).toBe(true);
  const view = result.ok ? result.data as { context: object; fields: object } : undefined;
  const request = { schema: 'account-editor-preview-v1', context: view!.context, fields: { ...view!.fields, label: 'MCP editor fixture', kind: 'api-key', paidUse: 'never' }, credentialPresent: true };
  const prepared = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'account_preview', request } })).structuredContent); expect(prepared).toMatchObject({ ok: true, data: { schema: 'account-editor-view-v1', canSave: true, plan: { primary: { path: '/hub/accounts', body: { kind: 'api-key', paidUse: 'never' } }, startLogin: false } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP runtime settings share the engine reader and scoped enable writer', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'runtimes_editor' } })).structuredContent); expect(result.ok).toBe(true);
  const view = result.ok ? result.data as { rows: Array<{ write: { body: object } }> } : undefined;
  const request = { ...view!.rows[0]!.write.body, patch: { enabled: false }, clientRequestId: 'runtime_mcp_save' };
  const saved = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'runtimes_save', request } })).structuredContent); expect(saved).toMatchObject({ ok: true, data: { configuration: { 'x-jevellan': { runtimes: { fake: { enabled: false } } } } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP account read model shares runtime grouping and eligibility without checking accounts', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'accounts_view' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'accounts-settings-view-v1', currentDeviceId: f.app.device.deviceId, runtimes: [expect.objectContaining({ id: 'fake', accounts: [expect.objectContaining({ kindLabel: 'Subscription', availability: expect.objectContaining({ label: 'Ready', eligible: true }) })] })] } });
  expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected account actions.');
  const { AccountsSettingsViewSchema } = await import('../packages/core/dist/index.js'); const actions = AccountsSettingsViewSchema.parse(result.data).runtimes.find(row => row.id === 'fake')!.accounts[0]!;
  expect(actions).toMatchObject({ actions: expect.arrayContaining([expect.objectContaining({ id: 'toggle', kind: 'write', body: expect.objectContaining({ enabled: false }) })]), deepLinkAction: { id: 'login', kind: 'login', expected: { accountId: 'acc_fixture', deviceId: f.app.device.deviceId } } });
});

test('MCP configuration import uses the shared preview and canonical revision receipt', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const { exportConfiguration } = await import('../packages/core/dist/index.js'), current = await f.app.configuration(), proposed = structuredClone(current.configuration); proposed['x-jevellan'].maxRunningThreadsAll++;
  const reply = await mcp.callTool({ name: 'config', arguments: { action: 'configuration_preview', yaml: exportConfiguration(proposed) } }); expect(reply.isError).toBeFalsy();
  const result = OwnerToolResultSchema.parse(reply.structuredContent); expect(result).toMatchObject({ ok: true, data: { schema: 'configuration-import-view-v1', canApply: true } });
  if (!result.ok) throw new Error('Expected configuration import preview.');
  const data = result.data as { write: { body: object } }; const request = { ...data.write.body, clientRequestId: 'mcp_configuration_import' };
  const saved = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'configuration_apply', request } })).structuredContent);
  expect(saved).toMatchObject({ ok: true, data: { revision: current.revision + 1, configuration: proposed } });
  const repeated = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'configuration_apply', request } })).structuredContent); expect(repeated).toEqual(saved);
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP config About shares device identity and command text without maintenance', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'about' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'device-about-view-v1', currentDeviceId: f.app.device.deviceId, commands: { update: 'jevellan update', uninstall: 'jevellan uninstall' } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP config usage exposes the engine table projection without starting work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'usage', range: '30d' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-usage-view-v1', range: '30d', presentation: { schema: 'project-usage-presentation-v1', empty: true, tables: expect.arrayContaining([expect.objectContaining({ key: 'byThread', label: 'By thread' })]) } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP config notification editor shares unknown browser state and notification actions', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'notification_editor' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'notification-editor-v1', active: null, canEnable: false, devices: [], actions: { test: { path: '/api/notifications/test', method: 'POST' } } } });
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'notification_test' } })).structuredContent)).toMatchObject({ ok: true, data: { schema: 'notification-editor-v1' } });
  const subscribed = await f.request('/api/notifications/subscriptions', 'POST', { schema: 'push-subscription-input-v1', endpoint: 'https://push.example/mcp-fixture', keys: { p256dh: 'fixture_public', auth: 'fixture_auth' }, label: 'MCP fixture' }); expect(subscribed.status).toBe(200);
  const id = (await subscribed.json()).subscriptions[0].id;
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'notification_remove', id } })).structuredContent)).toMatchObject({ ok: true, data: { schema: 'notification-editor-v1', devices: [] } });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP config environment editor exposes canonical limits without password values', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const reply = await mcp.callTool({ name: 'config', arguments: { action: 'environment_editor' } }); expect(reply.isError).toBeFalsy();
  const result = OwnerToolResultSchema.parse(reply.structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-environment-editor-v1', limits: { variables: 200, secrets: 100, name: 64 }, fields: { variables: [], secrets: [] } } });
  if (!result.ok) throw new Error('Expected environment editor.'); const view = ProjectEnvironmentEditorSchema.parse(result.data);
  const preview = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'environment_preview', request: { ...view.request.base, fields: { ...view.fields, copyFiles: ' local.env \n', variables: [{ name: 'FIXTURE_VAR', value: 'MCP value' }] } } } })).structuredContent); if (!preview.ok) throw new Error('Expected environment preview.');
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'environment_save', request: ProjectEnvironmentEditorSchema.parse(preview.data).saveRequest } })).structuredContent)).toMatchObject({ ok: true });
  expect((await f.app.projectWork.settingsView('project')).settings.environment).toMatchObject({ copyFiles: ['local.env'], variables: [{ name: 'FIXTURE_VAR', value: 'MCP value' }] });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP config placement editor exposes the shared constraint form', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'placement_editor' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-placement-editor-v1', fields: { allModels: true, modelIds: ['fixture'], minEffort: '' }, guidance: { maxLength: 2000 } } });
  if (!result.ok) throw new Error('Expected placement editor.'); const view = ProjectPlacementEditorSchema.parse(result.data);
  const preview = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'placement_preview', request: { ...view.request.base, fields: { ...view.fields, allModels: false, minEffort: 'low', guidance: 'MCP placement guidance.' } } } })).structuredContent); if (!preview.ok) throw new Error('Expected placement preview.');
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'placement_save', request: ProjectPlacementEditorSchema.parse(preview.data).saveRequest } })).structuredContent)).toMatchObject({ ok: true });
  expect((await f.app.projectWork.settingsView('project')).settings.placement).toEqual({ allowedModelIds: ['fixture'], minEffort: 'low', guidance: 'MCP placement guidance.' });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP config settings editor exposes the shared project form and value-free summaries', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root }), settings = (await f.app.projectWork.settingsView('project')).settings;
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'settings_editor' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-settings-editor-v1', settingsView: { settings }, secretStates: [], savePath: '/api/projects/project/config/editor', controls: { schema: 'project-settings-controls-v1', numbers: { maxRunningThreads: { min: 1, max: 20 } } }, rigging: { schema: 'project-settings-rigging-v1', editPath: '/settings/rigging' } } }); expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected project settings editor.'); const view = ProjectSettingsEditorSchema.parse(result.data);
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'settings_save', request: { schema: 'project-settings-editor-save-v1', clientRequestId: 'mcp_form_settings', base: view.settingsView.settings, draft: { ...view.settingsView.settings, instructions: 'MCP draft.' }, secretPresence: {} } } })).structuredContent)).toMatchObject({ ok: true, data: { settingsView: { settings: { instructions: 'MCP draft.' } } } });
  await f.app.state.environment.put('project', 'MCP_SECRET', 'owned fixture value');
  expect((await mcp.callTool({ name: 'config', arguments: { action: 'remove_secret', name: 'MCP_SECRET' } })).isError).toBeFalsy(); expect((await f.app.state.environment.summary('project', 'MCP_SECRET')).saved).toBe(false);
});

test('MCP config landing editor exposes raw draft constraints and canonical save data', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root }), settings = (await f.app.projectWork.settingsView('project')).settings;
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'landing_editor' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-landing-editor-v1', fields: { delivery: settings.delivery }, limits: { checks: 30 }, saveRequest: { projectId: 'project', settingsRequest: { revision: settings.revision } } } }); expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected landing editor.'); const view = ProjectLandingEditorSchema.parse(result.data);
  const preview = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'landing_preview', request: { ...view.request.base, fields: { ...view.fields, smokeCheck: 'true' } } } })).structuredContent); if (!preview.ok) throw new Error('Expected landing preview.');
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'landing_save', request: ProjectLandingEditorSchema.parse(preview.data).saveRequest } })).structuredContent)).toMatchObject({ ok: true });
  expect((await f.app.projectWork.settingsView('project')).settings.smokeCheck).toBe('true');
});

test('MCP config settings change views include canonical sentences and Undo data', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const { change } = await f.app.projectWork.coordinatorSettings('project', { maxRunningThreads: 7, ownerWords: 'Use seven.' }, 'mcp_settings_change');
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'settings_change', request: { schema: 'project-settings-change-view-request-v1', change } } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-settings-change-view-v1', changeId: change.id, items: [{ field: 'maxRunningThreads', undo: { body: { schema: 'project-settings-undo-request-v1' } } }] } }); expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected settings change view.'); const view = ProjectSettingsChangeViewSchema.parse(result.data);
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'settings_undo', request: view.items[0]!.undo!.body } })).structuredContent)).toMatchObject({ ok: true });
  expect((await f.app.projectWork.settingsView('project')).settings.maxRunningThreads).toBe(change.changes[0]!.before);
});

test('MCP config coordinator editor exposes engine choices and canonical save data', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root }), settings = (await f.app.projectWork.settingsView('project')).settings;
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'coordinator_editor' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-coordinator-editor-v1', fields: { modelId: settings.coordinator.modelId ?? '', effort: settings.coordinator.effort, fresh: false }, saveRequest: { projectId: 'project', settingsRequest: { revision: settings.revision } } } });
  if (!result.ok) throw new Error('Expected coordinator editor.'); const view = ProjectCoordinatorEditorSchema.parse(result.data);
  const preview = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'coordinator_preview', request: { ...view.request.base, presentation: 'project-settings', fields: { ...view.fields, modelId: 'fixture', effort: 'low' } } } })).structuredContent); if (!preview.ok) throw new Error('Expected coordinator preview.');
  expect(preview.data).toMatchObject({ request: { base: { presentation: 'project-settings' } }, efforts: expect.arrayContaining([{ value: 'xhigh', label: 'Extra high' }]) });
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'coordinator_save', request: ProjectCoordinatorEditorSchema.parse(preview.data).saveRequest } })).structuredContent)).toMatchObject({ ok: true });
  expect((await f.app.projectWork.settingsView('project')).settings.coordinator).toMatchObject({ modelId: 'fixture', effort: 'low' });
  expect(f.fake.runs).toHaveLength(0);
});

test('MCP config project reads include the canonical configuration metadata', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const expected = await (await f.request('/api/projects/project/work-settings')).json();
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'get', section: 'project' } })).structuredContent);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected MCP project configuration.');
  expect(result.data).toEqual(expected); expect(result.data).toHaveProperty('configuration.guidance.maxLength', 2000); expect(f.fake.runs).toHaveLength(0);
});

test('improver read projections reach the official MCP client without starting work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root }), history = f.app.hub.configuration.history();
  const expected = await f.json('/api/improver', ImproverStateSchema), response = await mcp.callTool({ name: 'jev', arguments: { action: 'improver' } }); expect(response.isError).toBeFalsy();
  const result = OwnerToolResultSchema.parse(response.structuredContent); expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected improver read projection.');
  expect(ImproverStateSchema.parse(result.data)).toEqual(expected); expect(f.fake.runs).toHaveLength(0); expect(f.app.hub.configuration.history()).toEqual(history);
});

test('official MCP Decisions editor and scoped save preserve their typed request and receipt', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const read = await mcp.callTool({ name: 'jev', arguments: { action: 'settings_editor' } }), result = OwnerToolResultSchema.parse(read.structuredContent); expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected MCP settings editor.');
  const view = DecisionsSettingsEditorSchema.parse(result.data), fields = { ...view.fields, routingProfile: 'MCP settings guidance.' };
  const response = await mcp.callTool({ name: 'jev', arguments: { action: 'settings_preview', request: { ...view.preview.request, fields } } }), previewed = OwnerToolResultSchema.parse(response.structuredContent); expect(previewed.ok).toBe(true); if (!previewed.ok) throw new Error('Expected MCP settings preview.');
  const draft = DecisionsSettingsEditorSchema.parse(previewed.data), before = f.app.hub.configuration.current()!.revision;
  for (let attempt = 0; attempt < 2; attempt++) { const saved = await mcp.callTool({ name: 'jev', arguments: { action: 'settings_save', request: draft.saveRequest } }), value = OwnerToolResultSchema.parse(saved.structuredContent); expect(saved.isError).toBeFalsy(); expect(value.ok).toBe(true); if (!value.ok) throw new Error('Expected MCP settings save.'); expect(ConfigRevisionSchema.parse(value.data).revision).toBe(before + 1); }
  expect(f.app.hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe(fields.routingProfile); expect(f.fake.runs).toHaveLength(0);
});

test('the forwarder lists exactly the twelve tools with their descriptions and forwards calls to the tool route', async () => {
  f = await projectFixture({ control: true });
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const listed = (await mcp.listTools()).tools;
  expect(listed.map(tool => tool.name)).toEqual(['status', 'activity', 'ask_coordinator', 'work', 'goals', 'jobs', 'thread', 'respond', 'override', 'jev', 'config', 'login']);
  for (const tool of OWNER_TOOLS) expect(listed.find(row => row.name === tool.name)?.description).toBe(tool.description);
  expect((listed.find(row => row.name === "work")!.inputSchema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(['list', 'add', 'reorder', 'cancel', 'inspect']);
  expect((listed.find(row => row.name === 'ask_coordinator')!.inputSchema as unknown as { properties: { mode: { enum: string[] } } }).properties.mode.enum).toEqual(['ask', 'tell', 'restart']);
  expect(mcp.getServerCapabilities()?.experimental).toBeUndefined();
  const status = await mcp.callTool({ name: 'status', arguments: {} });
  expect(status.isError).toBeFalsy();
  expect((status.content as Array<{ text: string }>)[0]!.text).toContain('Nothing waiting on you.');
  const refused = await mcp.callTool({ name: 'work', arguments: { action: 'cancel', task: 'T9' } });
  expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: `T9 is not a task or thread of ${f.project.name}.` }] });
  const log = f.app.ownerTools.callerLog();
  expect(log.map(entry => [entry.tool, entry.action, entry.access, entry.ok])).toEqual([['status', 'status', 'read', true], ['work', 'cancel', 'write', false]]);
  expect(log.every(entry => entry.caller.startsWith('session:'))).toBe(true);
});

test('with a role set the forwarder registers zero tools; in the bridge it declares the channel', async () => {
  f = await projectFixture({ control: true });
  const guarded = await connect({ JEVELLAN_HOME: f.homes.root, JEVELLAN_ROLE: 'thread', JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: 'project' });
  expect((await guarded.listTools()).tools).toEqual([]);
  expect(guarded.getServerCapabilities()?.experimental).toBeUndefined();
  await guarded.close(); client = undefined;
  const bridge = await connect({ JEVELLAN_HOME: f.homes.root, JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: f.project.name });
  expect(bridge.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
  expect((await bridge.listTools()).tools).toHaveLength(12);
  await bridge.callTool({ name: 'status', arguments: {} });
  expect(f.app.ownerTools.callerLog().at(-1)?.caller).toBe(`bridge:${f.project.name.replace(/[^A-Za-z0-9._-]/gu, '_')}`);
});

test('a forwarder without a running service says so in one sentence', async () => {
  f = await projectFixture();
  const mcp = await connect({ JEVELLAN_HOME: join(f.root, 'nowhere') });
  const result = await mcp.callTool({ name: 'status', arguments: {} });
  expect(result).toMatchObject({ isError: true, content: [{ text: 'Jevellan is not running on this device (no installation control file).' }] });
});

test('editor request templates survive the official MCP transport and create one retry-safe definition', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const read = await mcp.callTool({ name: 'jobs', arguments: { action: 'editor', kind: 'job' } });
  expect(read.isError).toBeFalsy();
  const result = OwnerToolResultSchema.parse(read.structuredContent); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected the editor model.');
  const view = ProjectJobEditorSchema.parse(result.data);
  expect((read.content as Array<{ text: string }>).some(item => item.text.includes('"schema":"project-job-editor-v1"'))).toBe(true);
  const request = { ...view.request.base, fields: { ...view.defaults, name: 'MCP editor fixture', command: 'true', enabled: false } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const saved = await mcp.callTool({ name: 'jobs', arguments: { action: 'save', request } });
    expect(saved.isError).toBeFalsy();
    expect(OwnerToolResultSchema.parse(saved.structuredContent)).toMatchObject({ ok: true, data: { name: 'MCP editor fixture', enabled: false } });
  }
  expect((await f.app.projectWork.daily.jobs('project')).map(job => job.name)).toEqual(['MCP editor fixture']);
});

test.each(['list', 'night'])('the official MCP transport preserves the shared jobs projection for %s', async action => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const answer = await mcp.callTool({ name: 'jobs', arguments: { action } }); expect(answer.isError).toBeFalsy();
  expect(OwnerToolResultSchema.parse(answer.structuredContent)).toMatchObject({ ok: true, data: { schema: 'project-jobs-view-v1', projectId: 'project' } });
  expect((answer.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"project-jobs-view-v1"'))).toBe(true);
});


test('goal models and retry-safe editor saves reach the official MCP client', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const read = await mcp.callTool({ name: 'goals', arguments: { action: 'editor' } });
  const result = OwnerToolResultSchema.parse(read.structuredContent); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected the goal editor.');
  const view = ProjectGoalEditorSchema.parse(result.data), request = { ...view.request.base, fields: { ...view.defaults, name: 'MCP goal fixture', motivation: 'Shared goal transport.' } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const saved = await mcp.callTool({ name: 'goals', arguments: { action: 'save', request } });
    expect(saved.isError).toBeFalsy(); expect(OwnerToolResultSchema.parse(saved.structuredContent)).toMatchObject({ ok: true, data: { goal: { name: 'MCP goal fixture', openPrCap: 2 } } });
  }
  expect((await f.app.projectWork.goalList('project')).goals).toHaveLength(1);
  const listed = await mcp.callTool({ name: 'goals', arguments: { action: 'list' } });
  expect(OwnerToolResultSchema.parse(listed.structuredContent)).toMatchObject({ ok: true, data: { schema: 'project-goal-views-v1', projectId: 'project', rows: [{ name: 'MCP goal fixture' }] } });
  expect((listed.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"project-goal-views-v1"'))).toBe(true);
});


test('the official MCP transport preserves the shared thread placement explanation', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'MCP explanation fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'mcp_why', title: 'MCP explanation', task: 'Inspect the simulated fixture.' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle');
  const ui = await (await f.request(`/api/projects/project/threads/${made.threadId}/why-view`)).json(), mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = await mcp.callTool({ name: 'jev', arguments: { action: 'why', thread: made.threadId } }); expect(result.isError).toBeFalsy();
  expect(OwnerToolResultSchema.parse(result.structuredContent)).toMatchObject({ ok: true, data: ui });
  expect((result.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"project-thread-why-view-v1"'))).toBe(true);
});


test('the official MCP editor previews and saves a next-turn override through the canonical writer', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'MCP override editor.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'mcp_override_editor', title: 'MCP override editor', task: 'Inspect the simulated fixture.', effort: 'medium' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle');
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root }), read = await mcp.callTool({ name: 'jev', arguments: { action: 'override_editor', thread: made.threadId } });
  const result = OwnerToolResultSchema.parse(read.structuredContent); expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected the override editor.');
  const editor = ProjectThreadOverrideEditorSchema.parse(result.data); expect(editor.fields.effort).toBe('medium');
  const previewed = await mcp.callTool({ name: 'jev', arguments: { action: 'override_preview', thread: made.threadId, request: { schema: 'thread-override-editor-preview-request-v1', changed: 'effort', fields: { ...editor.fields, effort: 'high' } } } });
  const previewResult = OwnerToolResultSchema.parse(previewed.structuredContent); expect(previewResult.ok).toBe(true); if (!previewResult.ok) throw new Error('Expected the preview.');
  const preview = ProjectThreadOverrideEditorSchema.parse(previewResult.data); expect(preview.apply.enabled).toBe(true);
  const request = { ...editor.request.base, fields: preview.fields };
  for (let attempt = 0; attempt < 2; attempt++) expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'override_save', thread: made.threadId, request } })).structuredContent)).toMatchObject({ ok: true, data: { schema: 'thread-override-view-v1' } });
  expect(await f.app.projectHub.recentOverrides('project', 8)).toHaveLength(1);
  expect(f.thread(made.threadId).placement.effortRequested).toBe('high');
});


test('the official MCP transport reads route models and retries the same canonical correction', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'MCP route fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'mcp_route_model', title: 'MCP route model', task: 'Inspect the simulated route.' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle'); const commit = 'a'.repeat(40);
  const identity = { projectId: 'project', threadId: made.threadId, deviceId: f.app.device.deviceId, commit, at: f.thread(made.threadId).createdAt };
  await seedRouteDecision(f.app.projectHub, identity, 'landing'); await seedRouteDecision(f.app.projectHub, identity, 'merge');
  const ui = await (await f.request(`/api/projects/project/threads/${made.threadId}/pr/why-view`, 'POST', { schema: 'project-merge-why-request-v1', commit })).json();
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root }), read = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'why', kind: 'merge', thread: made.threadId, commit } })).structuredContent);
  expect(read.ok).toBe(true); if (!read.ok) throw new Error('Expected the route model.'); const model = ProjectRouteWhyViewSchema.parse(read.data);
  expect(model).toMatchObject({ route: ui.route, verifications: ui.verifications, shadowLine: ui.shadowLine, commit: ui.commit });
  const request = model.correctionActions[0]!.request.body;
  for (let n = 0; n < 2; n++) expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'route_correct', thread: made.threadId, request } })).structuredContent)).toMatchObject({ ok: true, data: { kind: 'merge', savedNotice: 'Saved for future merge decisions.' } });
  expect((await f.app.projectHub.mergeDocuments('project')).records.filter(row => row.schema === 'merge-correction-v1')).toHaveLength(1);
  expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'why', kind: 'landing', thread: made.threadId } })).structuredContent)).toMatchObject({ ok: true, data: { kind: 'landing', route: { id: 'route_landing_fixture' } } });
});


test('the official MCP composer model preserves pins and saves through the canonical conversation writer', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const initial = { schema: 'composer-initial-v1', once: { effort: 'high' }, pins: { effort: 'low' } };
  const draft = await mcp.callTool({ name: 'jev', arguments: { action: 'composer_editor', initial } });
  expect(draft.isError).toBeFalsy(); const draftResult = OwnerToolResultSchema.parse(draft.structuredContent); if (!draftResult.ok) throw new Error('Expected the composer model.');
  const model = ConversationComposerViewSchema.parse(draftResult.data);
  expect(model.fields.find(field => field.id === 'effort')).toMatchObject({ selected: 'high', scope: 'once-then-pin', scopeLabel: 'Once, then low' });
  expect((draft.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"conversation-composer-view-v1"'))).toBe(true);
  const preview = await mcp.callTool({ name: 'jev', arguments: { action: 'composer_preview', initial, request: model.fields.find(field => field.id === 'effort')!.keep } });
  expect(OwnerToolResultSchema.parse(preview.structuredContent)).toMatchObject({ ok: true, data: { initial: { once: {}, pins: { effort: 'high' } } } });
  await f.app.conversations.create({ schema: 'start-conversation-v1', id: 'mcp_composer', projectId: 'project', title: 'MCP composer', message: 'Explain the fixture.', clientMessageId: 'mcp_composer_first' }); await f.app.conversations.wait('mcp_composer');
  const read = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'composer_editor', conversation: 'mcp_composer' } })).structuredContent);
  if (!read.ok) throw new Error('Expected the existing composer model.');
  const editor = ConversationComposerViewSchema.parse(read.data), request = editor.fields.find(field => field.id === 'effort')!.options.find(option => option.value === 'high')!.choice;
  for (let attempt = 0; attempt < 2; attempt++) expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'composer_save', conversation: 'mcp_composer', request } })).structuredContent)).toMatchObject({ ok: true, data: { initial: { once: { effort: 'high' } } } });
  expect((await f.app.conversations.view('mcp_composer')).composerOverrides.filter(row => row.request.clientRequestId === request.clientRequestId)).toHaveLength(1);
  expect(f.fake.starts).toHaveLength(0);
});


test('the official MCP transport exposes recorded conversation Why and canonical step correction templates', async () => {
  f = await projectFixture({ control: true, testCommand: 'true' }); const { id, path, decision } = await seedConversationDecision(f, 'mcp_decision_fixture'), mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const why = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'conversation_why', conversation: id, decision: decision.id } })).structuredContent);
  if (!why.ok) throw new Error('Expected the recorded explanation.'); expect(ConversationDecisionWhyViewSchema.parse(why.data).action.options.map(row => row.id)).toEqual(['implement', 'plan', 'reply']);
  const read = await mcp.callTool({ name: 'jev', arguments: { action: 'correction_editor', conversation: id, stretch: 1 } });
  expect((read.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"step-correction-editor-v1"'))).toBe(true);
  const editorResult = OwnerToolResultSchema.parse(read.structuredContent); if (!editorResult.ok) throw new Error('Expected the correction editor.'); const editor = StepCorrectionEditorSchema.parse(editorResult.data);
  const request = { ...editor.preview.request, fields: { ...editor.fields, effort: 'high' } };
  const reply = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'correction_preview', conversation: id, request } })).structuredContent); if (!reply.ok) throw new Error('Expected the correction preview.');
  const preview = StepCorrectionEditorSchema.parse(reply.data), ui = StepCorrectionEditorSchema.parse(await (await f.request(`${path}/step-preview`, 'POST', request)).json());
  expect(preview.requests).toEqual(ui.requests);
  for (let attempt = 0; attempt < 2; attempt++) expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'correction_save', conversation: id, request: preview.requests.noted } })).structuredContent)).toMatchObject({ ok: true });
  expect((await f.app.conversations.view(id)).overrides.filter(row => row.request.clientRequestId === preview.requests.noted!.clientRequestId)).toHaveLength(1); expect(f.fake.starts.length).toBe(1);
});
