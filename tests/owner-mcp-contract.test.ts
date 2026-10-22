import { conversationPlanReviewFixture } from './helpers/conversation-plan-review-fixture.js';
import { conversationPlanFixture } from './helpers/conversation-plan-fixture.js';
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

test('MCP status exposes the shared cache view without starting work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'status', arguments: {} })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { cacheView: { schema: 'session-cache-view-v1', projectId: 'project', line: { ratio: 'Unknown', coldStarts: 0 }, table: { rows: [] } } } }); expect(f.fake.runs).toHaveLength(0);
  expect(result).toMatchObject({ ok: true, data: { historyView: { schema: 'session-history-view-v1', projectId: 'project', visible: false, entries: [] } } });
});

test('MCP native conversation view send and cancel share canonical presentation and receipts', async () => {
  f = await projectFixture({ control: true }); const core = await import('../packages/core/dist/index.js'), id = 'cursor_' + '7'.repeat(32), owner = f.app.device.deviceId, at = new Date().toISOString(), scope = { schema: 'native-session-ref-v1' as const, id, ownerDeviceId: owner, gatewayDeviceId: owner }, session = core.CursorSessionSchema.parse({ schema: 'cursor-session-v1', id, runtime: 'cursor', ownerDeviceId: owner, deviceName: 'Fixture', title: 'Native MCP conversation', cwd: null, project: 'Fixture', state: 'working', lastActivityAt: at, connected: true, canSteer: true, canSend: true }); let messages:Array<ReturnType<typeof core.CursorMessageSchema.parse>>=[]; f.app.cursor.read = async () => core.CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session, turns: [], activity: [], messages, truncated: false, observedAt: at }); f.app.cursor.send = async (_device,_id,input) => {const parsed=core.CursorMessageInputSchema.parse(input),message=core.CursorMessageSchema.parse({...parsed,schema:'cursor-message-v1',sessionId:id,createdAt:at,state:'queued',generation:'fixture'});messages=[message];return message;};f.app.cursor.cancel=async(_device,_id,messageId)=>{const message=core.CursorMessageSchema.parse({...messages.find(row=>row.clientMessageId===messageId)!,state:'cancelled'});messages=[message];return message;};const mcp=await connect({JEVELLAN_HOME:f.homes.root});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'native_conversation_view',request:scope}})).structuredContent)).toMatchObject({ok:true,data:{presentation:{title:'Native MCP conversation',composer:{primaryMode:'steer'}}}});const command=core.nativeMessageAttempt(null,scope,'  MCP message.  ','next','message_mcp_conversation').command;expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'native_message_send',request:command}})).structuredContent)).toMatchObject({ok:true,data:{schema:'native-message-receipt-v1',message:{text:'MCP message.',state:'queued'}}});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'native_message_cancel',request:{schema:'native-conversation-command-v1',operation:'cancel',ref:scope,clientMessageId:'message_mcp_conversation'}}})).structuredContent)).toMatchObject({ok:true,data:{message:{state:'cancelled'}}});expect(f.fake.runs).toHaveLength(0);
});

test('MCP native reading purposes share list policy and scoped transcript presentation', async () => {
  f = await projectFixture({ control: true }); const core = await import('../packages/core/dist/index.js'), id = 'cursor_' + '3'.repeat(32), at = new Date().toISOString(), owner = f.app.device.deviceId, session = core.CursorSessionSchema.parse({ schema: 'cursor-session-v1', id, runtime: 'cursor', ownerDeviceId: owner, deviceName: 'Fixture', title: 'Native MCP reader', cwd: null, project: 'Fixture', state: 'idle', lastActivityAt: at, connected: true, canSteer: false, canSend: true }); f.app.cursor.list = async () => core.CursorListSchema.parse({ schema: 'cursor-list-v1', sessions: [session], unavailable: [], observedAt: at }); f.app.cursor.read = async () => core.CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session, turns: [], activity: [], messages: [], truncated: false, observedAt: at }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root }); const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'native_list_view' } })).structuredContent); expect(result).toMatchObject({ ok: true, data: { kind: 'ready', policy: { listPollMs: 3000 }, list: { sessions: [{ id, gatewayDeviceId: owner }] } } });
  const transcript = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'native_transcript_view', request: { schema: 'native-session-ref-v1', id, ownerDeviceId: owner, gatewayDeviceId: owner } } })).structuredContent); expect(transcript).toMatchObject({ ok: true, data: { kind: 'ready', policy: { transcriptPollMs: 1500 }, presentation: { connected: true, working: false, stateLabel: 'Idle' } } }); expect(f.fake.runs).toHaveLength(0);
});

test('MCP native connection editor and captured command share normalized canonical settings', async () => {
  f = await projectFixture({ control: true }); const core = await import('../packages/core/dist/index.js'); f.app.cursor.list = async () => core.CursorListSchema.parse({ schema: 'cursor-list-v1', sessions: [], unavailable: [], observedAt: new Date().toISOString() }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'native_connections_editor' } })).structuredContent); expect(result.ok).toBe(true); if (!result.ok) throw new Error('Editor refused.'); const editor = core.NativeConnectionsEditorSchema.parse(result.data), command = core.nativeConnectionAddCommand(editor.context, { ...editor.fields, name: 'MCP fixture', user: 'fixture', port: '2222', host: ' host.test ', helperPath: '/simulated/cursor-stdio.mjs', home: '/simulated/home' });
  const saved = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'native_connections_command', request: command } })).structuredContent); expect(saved).toMatchObject({ ok: true, data: { schema: 'native-connections-saved-v1', editor: { rows: [{ connection: { id: editor.context.draftId, host: 'host.test', port: 2222 }, summary: { text: 'Existing SSH · host.test' } }] } } }); expect(f.app.cursor.connections().connections).toHaveLength(1); expect(f.fake.runs).toHaveLength(0);
});

test('MCP native policy shares canonical runtime eligibility without starting work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'native_policy' } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'native-conversation-policy-v1', historyDays: 5, followupHours: 7, runtimes: [{ runtime: 'cursor', canCompose: true }, { runtime: 'claude', canCompose: false }, { runtime: 'codex', canCompose: false }] } }); expect(f.fake.runs).toHaveLength(0);
});

test('MCP thread view shares header and composer presentation without steering work', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated MCP thread ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'mcp_thread_presentation', title: 'MCP thread view', task: 'Inspect the simulated fixture.' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle'); f.app.projectWork.store.update(made.threadId,row=>({...row,stateReason:'Wait until 2026-10-22T04:00:00.000Z'})); const before = structuredClone(f.thread(made.threadId)), mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'thread', arguments: { action: 'view', thread: made.threadId } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-thread-view-v1', presentation: { schema: 'project-thread-presentation-v1', actions: { allowTurnsStep: 10 }, composer: { block: null } } } }); expect(f.thread(made.threadId)).toEqual(before);
  expect(result).toMatchObject({ ok: true, data: { timeline: { schema: 'project-thread-timeline-v1', projectId: 'project', threadId: made.threadId } } });
  expect(result).toMatchObject({ ok: true, data: { presentation: { controls: { schema: 'project-thread-controls-v1', browserTakeover: true, attachPanel: true, stop: { title: 'Stop this thread?' } } } } });
  expect(result).toMatchObject({ ok: true, data: { images: { schema: 'project-thread-images-v1', projectId: 'project', threadId: made.threadId } } });
  expect(result).toMatchObject({ ok: true, data: { presentation: { composer: { steering: { schema: 'project-thread-steering-view-v1', offered: false, label: 'Interrupt current turn' } } } } });
  expect(result).toMatchObject({ ok: true, data: { historyView: { schema: 'session-history-view-v1', projectId: 'project', visible: false, entries: [] } } });
  expect(result).toMatchObject({ok:true,data:{readHint:{schema:'project-thread-read-hint-v1',pollHintMs:10000,policy:{liveMs:1500,restMs:10000,afterActionMs:6000}}}});
  expect(result).toMatchObject({ok:true,data:{presentation:{reason:{display:{schema:'project-thread-display-text-v1',text:'Wait until 2026-10-22T04:00:00.000Z',parts:[{kind:'text',value:'Wait until '},{kind:'time',value:'2026-10-22T04:00:00.000Z'}]}}}}});
});

test('MCP task compose editor preserves Automatic placement and performs no work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const read = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'work', arguments: { action: 'editor' } })).structuredContent); expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('Expected task compose editor.'); const fields = (read.data as { fields: object }).fields;
  const request = { schema: 'project-task-editor-preview-v1', fields: { ...fields, title: 'MCP draft', task: 'Preserve all default guards.' } };
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'work', arguments: { action: 'preview', request } })).structuredContent); expect(result).toMatchObject({ ok: true, data: { schema: 'project-task-editor-v1', canSave: true, plan: { body: { fixed: {}, goalId: null, now: false } } } }); expect(f.fake.runs).toHaveLength(0);
});

test('MCP setup proposal reader shares first-line goal labels without applying work', async () => {
  f = await projectFixture({ control: true }); await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  const { proposal } = await f.app.projectWork.proposeSetup(f.project.id, 'mcp_setup_copy', { items: [{ key: 'goal', value: 'Keep the fixture tidy\nMaintain predictable state.' }] });
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'config', arguments: { action: 'setup_view', proposal: proposal.id } })).structuredContent); expect(result).toMatchObject({ ok: true, data: { presentation: { schema: 'project-setup-presentation-v1', items: [{ index: 0, label: 'Goal: Keep the fixture tidy' }] } } }); expect(f.fake.runs).toHaveLength(0);
});

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
  expect((listed.find(row => row.name === "work")!.inputSchema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(['list', 'add', 'reorder', 'cancel', 'inspect', 'editor', 'preview', 'save', 'queue_view', 'task_edit_view', 'task_draft', 'task_command', 'task_page_view', 'chat_view', 'chat_card_view', 'coordinator_composer', 'coordinator_command', 'notebook_view', 'notebook_command', 'attachment_policy', 'attachment_message', 'library_view', 'library_delete', 'library_message_view']);
  expect((listed.find(row=>row.name==='thread')!.inputSchema as unknown as {properties:{action:{enum:string[]}}}).properties.action.enum).toEqual(['say','open','return','stop','actions','act','merge','view','read_view']);
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

test('MCP plan reader shares the typed plan model without starting more work', async () => {
  const made = await conversationPlanFixture(true); f = made.f; const starts = f.fake.starts.length, mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'plan_read', project: 'project', conversation: made.id, request: { schema: 'conversation-plan-read-request-v1', pointer: made.pointer } } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-plan-read-v1', projectId: 'project', conversationId: made.id, pointer: made.pointer, view: { schema: 'plan-content-view-v1', root: { kind: 'fields' } } } }); expect(f.fake.starts).toHaveLength(starts);
});

test('MCP plan approval uses the canonical writer and shared approved status', async () => {
  const made = await conversationPlanReviewFixture(true); f = made.f;
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'plan_approve', project: 'project', conversation: made.id, request: { schema: 'plan-approval-v1', generation: made.view.conversation.generation, ref: made.pointer } } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { conversation: { work: { approvedPlanRef: made.pointer } }, plans: { reviews: [{ badge: 'Approved', offered: false }] } } });
});

test('MCP evidence reader returns the canonical public view without starting work', async () => {
  const made = await conversationPlanFixture(true); f = made.f; const starts = f.fake.starts.length, mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'evidence_read', conversation: made.id, request: { schema: 'conversation-evidence-request-v1', ref: made.pointer } } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-evidence-view-v1', projectId: 'project', conversationId: made.id, reference: { value: made.pointer }, view: { kind: 'text', text: JSON.stringify(f.app.conversations.ledger(made.id).read(made.pointer), null, 2) } } }); expect(f.fake.starts).toHaveLength(starts);
});

test('MCP conversation reader shares delivery and branch presentation without starting work', async () => {
  const made = await conversationPlanFixture(true); f = made.f; const starts = f.fake.starts.length, mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'conversation_view', conversation: made.id } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-view-v1', delivery: { schema: 'message-delivery-view-v1', primaryLabel: 'Send' }, branchChanges: [] } }); expect(f.fake.starts).toHaveLength(starts);
});

test('MCP session preferences use the canonical per-device revision writer', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const saved = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'session_list_save', request: { schema: 'session-list-update-v1', revision: 0, operation: 'rename', id: 'mcp_session', title: 'MCP fixture title' } } })).structuredContent);
  const read = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'session_list' } })).structuredContent);
  expect(saved).toMatchObject({ ok: true, text: 'Session list saved.' }); expect(read).toMatchObject({ ok: true, text: 'This device’s session list.' });
  if (!saved.ok || !read.ok) throw Error('Expected successful preference save and read.');
  expect(saved.data).toEqual(read.data); expect(read).toMatchObject({ ok: true, data: { schema: 'session-list-view-v1', deviceId: f.app.device.deviceId, preferences: { revision: 1, titles: { mcp_session: 'MCP fixture title' } } } }); expect(f.fake.runs).toHaveLength(0);
});

test('MCP conversation transcript shares the canonical step snapshot without starting work', async () => {
  const made = await conversationPlanReviewFixture(true); f = made.f; const starts = f.fake.starts.length, mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'conversation_transcript', conversation: made.id, request: { schema: 'conversation-transcript-request-v1', step: 1 } } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-transcript-view-v1', projectId: 'project', conversationId: made.id, step: 1, running: false, fallbackAnswer: null } }); expect(f.fake.starts).toHaveLength(starts);
});

test('MCP owner-command view reads presentation without executing the command', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'owner_command_view', command: { command: 'printf fixture', why: 'Simulated owner command.', cwd: 'checkout' }, device: f.app.device.deviceId } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { schema: 'owner-command-view-v1', projectId: 'project', presentation: { copyOnly: false, receipt: null, header: `${f.app.device.name} · checkout` } } }); expect(f.app.terminals.manager.list()).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
});

test('MCP project page reads the canonical viewer-bound status without starting work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const request = { schema: 'project-page-request-v1', resolvedDays: 28, timeZone: 'UTC', locale: 'en', ackKnown: ['known'] };
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'project_page', request } })).structuredContent);
  const ordinary = await (await f.request('/api/projects/project/status-view', 'POST', request)).json();
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-page-view-v1', changeToken: ordinary.changeToken, overview: ordinary.overview } }); expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation presentation uses the canonical recorded page metadata without starting work', async () => {
  const made = await conversationPlanReviewFixture(true); f = made.f; const starts = f.fake.starts.length, mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'conversation_view', conversation: made.id } })).structuredContent);
  expect(result).toMatchObject({ ok: true, data: { presentation: { schema: 'conversation-page-presentation-v1', picker: { shown: false } } } }); expect(f.fake.starts).toHaveLength(starts);
});

test('MCP conversation list source uses the canonical owner reader without starting work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'conversation_list' } })).structuredContent);
  const ordinary = await (await f.request('/api/conversation-list/view')).json(); expect(ordinary).toMatchObject({ schema: 'conversation-list-source-v1', readPolicy: { pollMs: 5000 } });
  expect(result).toMatchObject({ ok: true, data: ordinary }); expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation sidebar view shares canonical merged presentation without starting work', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'conversation_sidebar', request: { schema: 'conversation-sidebar-request-v1', shells: false, filter: 'Running', q: 'fixture' } } })).structuredContent);
  const ordinary = await (await f.request('/api/conversation-list/sidebar?shells=false&filter=Running&q=fixture')).json(); expect(result).toMatchObject({ ok: true, data: ordinary }); expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation sidebar actions rename through the canonical guarded writer', async () => {
  f = await projectFixture({ control: true }); await f.app.conversations.create({schema:'start-conversation-v1',id:'mcp_sidebar',projectId:'project',title:'MCP sidebar original',message:'Wait for my next step.',clientMessageId:'start_mcp_sidebar'});await f.app.conversations.wait('mcp_sidebar');const mcp=await connect({JEVELLAN_HOME:f.homes.root});
  const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_sidebar_rename',request:{schema:'conversation-sidebar-rename-request-v1',kind:'owner',id:'mcp_sidebar',previousTitle:'MCP sidebar original',title:'MCP sidebar renamed',clientRequestId:'rename_mcp_sidebar'}}})).structuredContent);expect(result).toMatchObject({ok:true,data:{conversation:{id:'mcp_sidebar',title:'MCP sidebar renamed'}}});expect((await f.app.conversations.view('mcp_sidebar')).conversation.title).toBe('MCP sidebar renamed');expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation new view uses canonical device-bound composer metadata without starting work',async()=>{
 f=await projectFixture({control:true});const mcp=await connect({JEVELLAN_HOME:f.homes.root}),request={schema:'conversation-new-request-v1',projectId:'project',message:'A simulated composer draft'};const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_new',request}})).structuredContent);const ordinary=await(await f.request('/api/conversation-new/view','POST',request)).json();expect(result).toMatchObject({ok:true,data:ordinary});expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation creation draft prepares canonical identity and title without starting work',async()=>{
 f=await projectFixture({control:true});const raw={schema:'conversation-creation-intent-v1',projectId:'project',message:'MCP creation title\nDetails',choices:{schema:'composer-initial-v1',once:{},pins:{}}};const draft=await(await f.request('/api/conversation-new/draft','POST',raw)).json(),mcp=await connect({JEVELLAN_HOME:f.homes.root});const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_create_draft',request:{...raw,previous:draft.pending}}})).structuredContent);expect(result).toMatchObject({ok:true,data:draft});expect((await f.app.conversations.list()).conversations).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});

test('MCP project setup view reads canonical readiness without starting work',async()=>{
 f=await projectFixture({control:true});const mcp=await connect({JEVELLAN_HOME:f.homes.root});const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'project_setup',request:{schema:'project-setup-wait-request-v1',waitSeconds:0}}})).structuredContent);const ordinary=await(await f.request('/api/projects/project/setup-view')).json();expect(result).toMatchObject({ok:true,data:ordinary});expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation start writes through the same canonical creation service',async()=>{
 f=await projectFixture({control:true});const mcp=await connect({JEVELLAN_HOME:f.homes.root});const request={schema:'conversation-start-request-v1',deviceId:f.app.device.deviceId,start:{schema:'start-conversation-v1',id:'mcp_start',projectId:'project',title:'MCP created',message:'Wait for the next fixture step.',clientMessageId:'message_mcp_start'},waitSeconds:0};const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_start',request}})).structuredContent);expect(result).toMatchObject({ok:true,data:{status:'created',view:{conversation:{id:'mcp_start',ownerDeviceId:f.app.device.deviceId}}}});expect((await f.app.conversations.list()).conversations).toHaveLength(1);expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation controls read shares canonical metadata without starting extra work',async()=>{
 f=await projectFixture({control:true});const id='mcp_controls';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'MCP controls',message:'Wait for the fixture.',clientMessageId:'mcp_controls_first'});await f.app.conversations.wait(id);const ordinary=await(await f.request(`/api/conversations/${id}`)).json(),before=f.app.conversations.ledger(id).events().length,mcp=await connect({JEVELLAN_HOME:f.homes.root});const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_view',conversation:id}})).structuredContent);expect(result).toMatchObject({ok:true,data:{controls:{schema:'conversation-controls-view-v1',...ordinary.controls}}});expect(f.app.conversations.ledger(id).events()).toHaveLength(before);expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation message draft and command use the canonical message writer',async()=>{
 f=await projectFixture({control:true});const id='mcp_message';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'MCP message',message:'Wait for the fixture.',clientMessageId:'mcp_message_first'});await f.app.conversations.wait(id);const mcp=await connect({JEVELLAN_HOME:f.homes.root}),request={schema:'conversation-message-draft-request-v1',intent:{mode:'compose',kind:'message',text:'MCP fixture message.'}},draft=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_message_draft',conversation:id,request}})).structuredContent);expect(draft).toMatchObject({ok:true,data:{schema:'conversation-message-draft-v1'}});if(!draft.ok)throw new Error('The fixture message draft was refused.');const data=draft.data as{command:unknown};expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_message',conversation:id,request:data.command}})).structuredContent)).toMatchObject({ok:true});expect((await f.app.conversations.view(id)).messages.at(-1)).toMatchObject({text:'MCP fixture message.'});expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation control editor and command finish through the canonical owner writer',async()=>{
 f=await projectFixture({control:true});const id='mcp_control';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'MCP control',message:'Wait for the fixture.',clientMessageId:'mcp_control_first'});await f.app.conversations.wait(id);const mcp=await connect({JEVELLAN_HOME:f.homes.root}),editor=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_control_editor',conversation:id,request:{schema:'conversation-control-editor-request-v1',kind:'finish'}}})).structuredContent);expect(editor).toMatchObject({ok:true,data:{schema:'conversation-control-editor-v1',maxLength:2000}});if(!editor.ok)throw new Error('The fixture control editor was refused.');const model=editor.data as{context:unknown},draft=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_control_draft',conversation:id,request:{schema:'conversation-control-draft-request-v1',kind:'finish',context:model.context,value:''}}})).structuredContent);expect(draft).toMatchObject({ok:true,data:{schema:'conversation-control-draft-v1'}});if(!draft.ok)throw new Error('The fixture control draft was refused.');const data=draft.data as{command:unknown};expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_control',conversation:id,request:data.command}})).structuredContent)).toMatchObject({ok:true,data:{conversation:{state:'done',outcome:{kind:'finished-elsewhere'}}}});expect(f.fake.starts).toHaveLength(0);
});

test('MCP conversation settlement editor and command share the canonical receipt',async()=>{
 f=await projectFixture({control:true,branchPolicy:'external'});const id='mcp_settlement';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'MCP settlement',message:'Preserve the fixture.',clientMessageId:'mcp_settlement_first'});await f.app.conversations.wait(id);const mcp=await connect({JEVELLAN_HOME:f.homes.root});
 const editor=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_settlement_editor',conversation:id,request:{schema:'conversation-settlement-editor-request-v1'}}})).structuredContent);expect(editor).toMatchObject({ok:true,data:{schema:'conversation-settlement-editor-v1',choices:[{choice:'keep'}],confirmation:null}});if(!editor.ok)throw new Error('The fixture settlement editor was refused.');const model=editor.data as{context:unknown};const draft=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_settlement_draft',conversation:id,request:{schema:'conversation-settlement-draft-request-v1',context:model.context,choice:'keep'}}})).structuredContent);expect(draft).toMatchObject({ok:true,data:{schema:'conversation-settlement-draft-v1'}});if(!draft.ok)throw new Error('The fixture settlement draft was refused.');const data=draft.data as{command:unknown};expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_settle',conversation:id,request:data.command}})).structuredContent)).toMatchObject({ok:true});await f.app.conversations.wait(id);expect((await f.app.conversations.view(id)).settlements).toMatchObject([{status:'completed',choice:'keep'}]);expect(f.fake.starts).toHaveLength(0);
});
import {blockedConversationRedo,enqueueConversationHandoff,enqueueHeldConversationHandoff} from './helpers/conversation-recovery-fixture.js';

test('MCP conversation recovery editor and command resume the exact recorded redo',async()=>{
 f=await projectFixture({control:true});const {view,entry}=await blockedConversationRedo(f,'mcp_recovery'),id=view.conversation.id,mcp=await connect({JEVELLAN_HOME:f.homes.root});
 const editor=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_recovery_editor',conversation:id,request:{schema:'conversation-recovery-editor-request-v1',kind:'redo',id:entry.id}}})).structuredContent);expect(editor).toMatchObject({ok:true,data:{schema:'conversation-recovery-editor-v1',kind:'redo'}});if(!editor.ok)throw new Error('The fixture redo editor was refused.');const model=editor.data as{request:unknown},draft=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_recovery_draft',conversation:id,request:{schema:'conversation-recovery-draft-request-v1',request:model.request}}})).structuredContent);expect(draft).toMatchObject({ok:true,data:{schema:'conversation-recovery-draft-v1'}});if(!draft.ok)throw new Error('The fixture redo draft was refused.');const data=draft.data as{command:unknown};enqueueConversationHandoff(f);expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_recover',conversation:id,request:data.command}})).structuredContent)).toMatchObject({ok:true});await f.app.conversations.wait(id);expect((await f.app.conversations.view(id)).redos.at(-1)).toMatchObject({status:'completed'});expect(f.fake.starts).toHaveLength(2);
});

test('MCP conversation manual editor and command preserve running guards and completed continuation',async()=>{
 f=await projectFixture({control:true});const id='mcp_manual';f.fake.capabilities.readOnlyEnforced=true;await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'MCP manual',message:'Preserve the manual fixture.',clientMessageId:'mcp_manual_first'});await f.app.conversations.wait(id);const mcp=await connect({JEVELLAN_HOME:f.homes.root}),editor=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_manual_editor',conversation:id}})).structuredContent);expect(editor).toMatchObject({ok:true,data:{schema:'conversation-manual-editor-v1'}});if(!editor.ok)throw new Error('The fixture manual editor was refused.');const model=editor.data as{context:unknown;defaults:unknown},draft=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_manual_draft',conversation:id,request:{schema:'conversation-manual-draft-request-v1',context:model.context,selection:model.defaults}}})).structuredContent);expect(draft).toMatchObject({ok:true,data:{schema:'conversation-manual-draft-v1'}});if(!draft.ok)throw new Error('The fixture manual draft was refused.');const data=draft.data as{command:unknown};const held=enqueueHeldConversationHandoff(f);try{expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_manual',conversation:id,request:data.command}})).structuredContent)).toMatchObject({ok:true});await held.entered;const count=f.app.conversations.ledger(id).events().length;expect(await mcp.callTool({name:'jev',arguments:{action:'conversation_manual',conversation:id,request:data.command}})).toMatchObject({isError:true,content:[{type:'text',text:'A step is already running or settling.'}]});expect(f.app.conversations.ledger(id).events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);}finally{held.release();}await f.app.conversations.wait(id);enqueueConversationHandoff(f);expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_manual',conversation:id,request:data.command}})).structuredContent)).toMatchObject({ok:true});await f.app.conversations.wait(id);expect(f.fake.starts).toHaveLength(2);
});
import {conversationReadingFixture} from './helpers/conversation-reading-fixture.js';

test('MCP conversation reading view shares live fixture activity and recorded step metadata',async()=>{
 const made=await conversationReadingFixture(true);f=made.f;const mcp=await connect({JEVELLAN_HOME:f.homes.root}),activity=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_read_view',conversation:made.id,request:{schema:'conversation-reading-request-v1',kind:'activity'}}})).structuredContent);expect(activity).toMatchObject({ok:true,data:{schema:'conversation-reading-view-v1',kind:'activity',description:'Using Read fixture…'}});await made.finish();const count=f.app.conversations.ledger(made.id).events().length,step=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_read_view',conversation:made.id,request:{schema:'conversation-reading-request-v1',kind:'step',step:1}}})).structuredContent);expect(step).toMatchObject({ok:true,data:{kind:'step',actionable:true,editable:true,recordedAnswer:{fallback:'The fixture result is saved.'},transcript:{showFallback:false}}});expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});

test('MCP conversation result metadata shares recorded content and exact detail labels without work',async()=>{
 const made=await conversationReadingFixture(true);f=made.f;const view=await made.finish(),pointer=view.handoffs[0]!.result!.ref,count=f.app.conversations.ledger(made.id).events().length,mcp=await connect({JEVELLAN_HOME:f.homes.root});
 const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_read_view',conversation:made.id,request:{schema:'conversation-reading-request-v1',kind:'result',pointer,displayKind:'answer',fallback:view.handoffs[0]!.summary}}})).structuredContent);expect(result).toMatchObject({ok:true,data:{kind:'result',pointer,presentation:{kind:'answer',source:'content',text:'# Recorded reading result\n\nThe fixture result is saved.'}}});
 const step=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_read_view',conversation:made.id,request:{schema:'conversation-reading-request-v1',kind:'step',step:1}}})).structuredContent);expect(step).toMatchObject({ok:true,data:{kind:'step',details:{schema:'conversation-step-details-v1',effortLabel:'high'}}});expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});

test('MCP conversation stream source preserves canonical cursor and refresh policy without work',async()=>{
 const made=await conversationReadingFixture(true);f=made.f;await made.finish();const ledger=f.app.conversations.ledger(made.id),count=ledger.events().length,mcp=await connect({JEVELLAN_HOME:f.homes.root}),request={schema:'conversation-stream-request-v1',afterId:0,limit:2};
 const value=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'conversation_stream',conversation:made.id,request}})).structuredContent);expect(value).toMatchObject({ok:true,data:{schema:'conversation-stream-source-v1',request,head:ledger.lastId(),nextAfterId:2,hasMore:true,policy:{schema:'conversation-stream-policy-v1',refreshWindowMs:40},events:ledger.events(0,2).map(event=>({id:event.id}))}});expect(ledger.events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});
import {taskInteractionFixture} from './helpers/task-interaction-fixture.js';

test('MCP task interaction edits use captured revisions and shared queue controls',async()=>{
 const made=await taskInteractionFixture(true);f=made.f;const id=made.queued.id,starts=f.fake.runs.length,mcp=await connect({JEVELLAN_HOME:f.homes.root});
 expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'queue_view'}})).structuredContent)).toMatchObject({ok:true,data:{schema:'project-task-queue-interaction-v1',projectId:'project',order:[made.proposed.id,id]}});
 const editor=OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'task_edit_view',task:id}})).structuredContent);expect(editor.ok).toBe(true);if(!editor.ok)throw new Error('Task edit view refused.');const view=editor.data as{context:unknown;defaults:Record<string,unknown>},draft=OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'task_draft',task:id,request:{schema:'project-task-intent-v1',context:view.context,intent:{kind:'edit',fields:{...view.defaults,title:'MCP shared task edit'}}}}})).structuredContent);expect(draft.ok).toBe(true);if(!draft.ok)throw new Error('Task draft refused.');const command=(draft.data as{command:unknown}).command;
 expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'task_command',task:id,request:command}})).structuredContent)).toMatchObject({ok:true,data:{schema:'task-view-v1',task:{title:'MCP shared task edit',revision:made.queued.revision+1}}});expect(await mcp.callTool({name:'work',arguments:{action:'task_command',task:id,request:command}})).toMatchObject({isError:true});expect((await f.request(`/api/projects/project/tasks/${id}/command`,'POST',command)).status).toBe(409);expect(f.fake.runs.length).toBe(starts);
});

test('MCP task page reads the canonical task navigation and polling policy without work',async()=>{
 const made=await taskInteractionFixture(true);f=made.f;const before=await made.work.tasks.read('project',made.queued.id),starts=f.fake.runs.length,mcp=await connect({JEVELLAN_HOME:f.homes.root});const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'task_page_view',task:made.queued.id}})).structuredContent);expect(result).toMatchObject({ok:true,data:{schema:'project-task-page-view-v1',projectId:'project',taskId:made.queued.id,task:before,meta:'feature · queued',policy:{schema:'project-task-page-policy-v1',pollHintMs:30000},back:{label:'Back to project',href:'/projects/project'},threadLink:null,pullRequest:null}});expect(await made.work.tasks.read('project',made.queued.id)).toEqual(before);expect(f.fake.runs.length).toBe(starts);
});
import {projectChatFixture} from './helpers/project-chat-fixture.js';

test('MCP project chat reads canonical recorded headings cards and delivery without work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const before=made.ledger.events(),starts=f.fake.runs.length,mcp=await connect({JEVELLAN_HOME:f.homes.root});const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'chat_view'}})).structuredContent);expect(result).toMatchObject({ok:true,data:{schema:'project-chat-view-v1',projectId:'project',deviceId:f.app.device.deviceId,streamPolicy:{schema:'project-stream-policy-v1',initialRetryMs:5000,maximumRetryMs:60000,retryMultiplier:2},items:expect.arrayContaining([expect.objectContaining({kind:'owner',heading:'You, via CLI',delivered:true}),expect.objectContaining({kind:'reply',text:'Two recorded fixture tasks.'})])}});expect(made.ledger.events()).toEqual(before);expect(f.fake.runs.length).toBe(starts);
});
import {projectChatCardsFixture} from './helpers/project-chat-cards-fixture.js';

test('MCP chat card model shares captured dismissal and preserves sibling work',async()=>{
 const made=await projectChatCardsFixture(true);f=made.f;const mcp=await connect({JEVELLAN_HOME:f.homes.root}),result=OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'chat_card_view',request:{schema:'project-chat-card-view-request-v1',itemId:made.routed.id}}})).structuredContent);expect(result).toMatchObject({ok:true,data:{schema:'project-chat-card-view-v1',projectId:'project',deviceId:f.app.device.deviceId,view:{itemId:made.routed.id,batch:{label:'Start all (4)',taskIds:made.tasks.map(row=>row.id)}}}});expect(result.ok).toBe(true);if(!result.ok)throw new Error('Canonical chat cards refused.');const command=(result.data as{view:{rows:Array<{dismiss:unknown}>}}).view.rows[0]!.dismiss;expect(command).toMatchObject({operation:'action',body:{action:'reject',reason:'Dismissed from the chat.',expectedRevision:made.tasks[0]!.revision}});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'task_command',task:made.tasks[0]!.id,request:command}})).structuredContent)).toMatchObject({ok:true,data:{task:{state:'cancelled',endNote:'Dismissed from the chat.'}}});expect(await made.work.tasks.read('project',made.tasks[1]!.id)).toEqual(made.tasks[1]);expect(f.fake.runs.length).toBe(0);
});

test('MCP coordinator composer and typed message command share canonical retry identity without work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const mcp=await connect({JEVELLAN_HOME:f.homes.root});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'coordinator_composer'}})).structuredContent)).toMatchObject({ok:true,data:{schema:'project-coordinator-composer-v1',projectId:'project',canSend:true,requestPolicy:{retryIdentity:'payload-until-success',cancelled:'ignore',unauthorized:'global',other:'local'}}});
 const request={schema:'project-coordinator-command-v1',projectId:'project',operation:'message',body:{schema:'coordinator-message-request-v1',clientMessageId:'message_mcp_fixture',text:'MCP fixture payload.  '}};for(const repeated of[false,true])expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'coordinator_command',request}})).structuredContent)).toMatchObject({ok:true,data:{schema:'coordinator-message-receipt-v1',repeated}});expect(f.fake.runs.length).toBe(0);
});

test('MCP notebook editor and captured command share canonical revision checks without provider work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const mcp=await connect({JEVELLAN_HOME:f.homes.root});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'notebook_view'}})).structuredContent)).toMatchObject({ok:true,data:{schema:'project-notebook-editor-v1',projectId:'project',revision:0,content:'',policy:{contentMax:65536,readWhileEditing:false}}});const request={schema:'project-notebook-command-v1',projectId:'project',body:{schema:'notebook-request-v1',expectedRevision:0,content:'MCP fixture notebook.\n'}};expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'notebook_command',request}})).structuredContent)).toMatchObject({ok:true,data:{revision:1,content:'MCP fixture notebook.\n',updatedBy:'owner'}});const refusal=await mcp.callTool({name:'work',arguments:{action:'notebook_command',request}});expect(refusal).toMatchObject({isError:true,content:[{type:'text',text:'The coordinator changed the notebook. Reload to see its version.'}]});expect(refusal.structuredContent).toBeUndefined();expect(await f.app.ownerTools.call('work',{schema:'owner-tool-request-v1',caller:'cli',action:'notebook_command',args:{project:'project',request}})).toMatchObject({ok:false,error:{code:'conflict'}});expect(await made.work.notebookView('project')).toMatchObject({revision:1,notebook:{content:'MCP fixture notebook.\n',updatedBy:'owner'}});expect(f.fake.runs.length).toBe(0);
});

test('MCP attachment preparation shares typed canonical library facts without posting a message',async()=>{
 const {Readable}=await import('node:stream');f=await projectFixture({control:true});const item=await f.app.library.upload('project',{name:'fixture.txt',mime:'text/plain',size:5,source:'owner'},Readable.from(['hello'])),mcp=await connect({JEVELLAN_HOME:f.homes.root});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'attachment_policy'}})).structuredContent)).toMatchObject({ok:true,data:{projectId:'project',policy:{maximumFiles:10,maximumFileBytes:52428800}}});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'attachment_message',request:{schema:'project-attachment-request-v1',text:'A fixture request.',itemIds:[item.id]}}})).structuredContent)).toMatchObject({ok:true,data:{schema:'project-attachment-message-v1',projectId:'project',text:`A fixture request.\n\nAttached file: library/${item.path} (text/plain, 5 B)`,attachments:[{id:item.id,size:5,kind:'file'}]}});expect(f.fake.runs.length).toBe(0);
});

test('MCP library view shares job source filters and canonical origin metadata without work',async()=>{
 const {Readable}=await import('node:stream');f=await projectFixture({control:true});const item=await f.app.library.upload('project',{name:'job.txt',mime:'text/plain',size:5,source:'job',jobRunId:'job_run_fixture',artifactId:'artifact_fixture'},Readable.from(['hello'])),mcp=await connect({JEVELLAN_HOME:f.homes.root});expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'library_view',request:{schema:'project-library-view-request-v1',source:'job'}}})).structuredContent)).toMatchObject({ok:true,data:{schema:'project-library-view-v1',projectId:'project',source:'job',policy:{cacheMs:2000,pollMs:15000},rows:[{item:{id:item.id,source:'job'},originLabel:'From a job'}]}});const view=await f.app.library.view('project',{schema:'project-library-view-request-v1',source:'job'});const command=Reflect.get(view.rows[0]!, 'deleteCommand');expect(command).toBeDefined();expect(OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'library_delete',request:command}})).structuredContent)).toMatchObject({ok:true,data:{schema:'empty-request-v1'}});expect(await f.app.library.list('project')).toEqual([]);expect(f.fake.runs.length).toBe(0);
});

test('MCP recorded library message view resolves canonical text without posting work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const mcp=await connect({JEVELLAN_HOME:f.homes.root}),before=f.ledgerText(),request={schema:'project-library-message-request-v1',kind:'coordinator',itemId:made.owner.id,deviceId:f.app.device.deviceId};const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'work',arguments:{action:'library_message_view',request}})).structuredContent);expect(result).toMatchObject({ok:true,data:{schema:'project-library-message-view-v1',projectId:'project',text:'A recorded fixture request.',attachments:[],imageScope:'project'}});expect(f.ledgerText()).toBe(before);expect(f.fake.runs.length).toBe(0);
});

test('MCP thread read state exposes canonical ready context without steering work',async()=>{
 f=await projectFixture({control:true});f.fake.enqueueTurn(reportStep({status:'progress',summary:'Recorded MCP read-state fixture.'}),forThread());const made=await f.json('/api/projects/project/threads',ThreadCreatedViewSchema,'POST',{schema:'thread-create-request-v1',clientRequestId:'mcp_thread_read_state',title:'Read-state fixture',task:'Inspect the simulated state.'});await f.waitFor(()=>f!.thread(made.threadId),row=>row.state==='idle');const mcp=await connect({JEVELLAN_HOME:f.homes.root}),request={schema:'project-thread-read-request-v1',projectId:'project',threadId:made.threadId};const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'thread',arguments:{action:'read_view',request}})).structuredContent);expect(result).toMatchObject({ok:true,data:{schema:'project-thread-read-view-v1',kind:'ready',projectId:'project',threadId:made.threadId,nextRequest:{viewKnown:true},view:{readHint:{pollHintMs:10000}}}});expect(f.fake.turnStarts).toHaveLength(1);
});

test('MCP terminal launcher create and list share canonical defaults and owned session receipts',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),mcp=await connect({JEVELLAN_HOME:f.homes.root}),call=async(action:string,request:unknown)=>OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action,request}})).structuredContent),result=await call('terminal_launcher_view',{schema:'terminal-launcher-view-request-v1',projectId:'project'});expect(result.ok).toBe(true);if(!result.ok)throw new Error('MCP launcher refused.');const view=core.TerminalLauncherViewSchema.parse(result.data),command=core.terminalLaunchAttempt(null,view,core.terminalLauncherSelection(view),'terminal_mcp_fixture').command,created=await call('terminal_create',command);expect(created).toMatchObject({ok:true,data:{schema:'terminal-open-result-v1',session:{cwd:f.checkout,deviceId:f.app.device.deviceId}}});expect(JSON.stringify(created)).not.toContain('ticket');expect(await call('terminal_list_view',{schema:'terminal-list-request-v1',projectId:'project'})).toMatchObject({ok:true,data:{kind:'ready',list:{sessions:[{cwd:f.checkout}]},policy:{pollMs:5000}}});expect(f.app.terminals.manager.list()).toHaveLength(1);expect(f.fake.runs).toHaveLength(0);
});

test('MCP terminal stream read and policy share canonical closed resource metadata without tickets',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),mcp=await connect({JEVELLAN_HOME:f.homes.root}),policy=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'terminal_stream_policy'}})).structuredContent);expect(policy).toMatchObject({ok:true,data:{schema:'terminal-stream-policy-v1',initialRetryMs:500,heartbeatMs:15000}});const made=await f.json('/api/terminals',core.TerminalTicketSchema,'POST',{schema:'terminal-create-request-v1',clientRequestId:'terminal_stream_mcp_fixture',deviceId:f.app.device.deviceId,cwd:'home',takeover:false});await f.request('/api/terminals/'+made.session.id+'/close','POST',{schema:'empty-request-v1'});const result=OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action:'terminal_read_view',request:{schema:'terminal-read-request-v1',sessionId:made.session.id}}})).structuredContent);expect(result).toMatchObject({ok:true,data:{schema:'terminal-read-view-v1',snapshot:{session:{id:made.session.id,status:'closed'}},initial:{terminalClosed:true,connected:false},policy:policy.ok?policy.data:null}});expect(JSON.stringify(result)).not.toContain('ticket');expect(f.fake.runs).toHaveLength(0);
});

test('MCP terminal actions copy plans preview and close share canonical resource guards',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),made=await f.json('/api/terminals',core.TerminalTicketSchema,'POST',{schema:'terminal-create-request-v1',clientRequestId:'terminal_action_mcp_fixture',projectId:'project',cwd:'checkout',takeover:false}),id=made.session.id,mcp=await connect({JEVELLAN_HOME:f.homes.root}),call=async(action:string,request:unknown)=>OwnerToolResultSchema.parse((await mcp.callTool({name:'jev',arguments:{action,request}})).structuredContent);expect(await call('terminal_actions_view',{schema:'terminal-read-request-v1',sessionId:id})).toMatchObject({ok:true,data:{sessionId:id,canSend:true,targets:[{value:'coordinator'}]}});expect(await call('terminal_copy_plan',{schema:'terminal-copy-request-v1',sessionId:id,kind:'all'})).toMatchObject({ok:true,data:{source:'buffer',last:null}});expect(await call('terminal_copy_view',{schema:'terminal-copy-request-v1',sessionId:id,kind:'five'})).toMatchObject({ok:true,data:{source:'snapshot',request:{sessionId:id,kind:'five'}}});expect(await call('terminal_run_plan',{schema:'terminal-run-request-v1',sessionId:id,text:'printf preview-only',transportOpen:true})).toMatchObject({ok:true,data:{allowed:true,frame:{type:'input'}}});expect(f.app.terminals.manager.snapshot(id).commands.some(row=>row.command.includes('preview-only'))).toBe(false);expect(await call('terminal_action',core.terminalCloseCommand(id))).toMatchObject({ok:true,data:{operation:'close',sessionId:id,ack:{ok:true}}});expect(f.app.terminals.manager.session(id).status).toBe('closed');expect(f.fake.runs).toHaveLength(0);
});

test('MCP health editor previews raw drafts and reads canonical health history without work',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),mcp=await connect({JEVELLAN_HOME:f.homes.root}),call=async(name:string,args:Record<string,unknown>)=>OwnerToolResultSchema.parse((await mcp.callTool({name,arguments:args})).structuredContent),result=await call('config',{action:'health_editor'});expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected health editor.');const model=core.HealthEditorSchema.parse(result.data),next=core.healthEditorEdit(model,{schema:'health-editor-command-v1',operation:'add-check'});expect(await call('config',{action:'health_preview',request:{schema:'health-editor-preview-v1',projectId:'project',fields:next.fields}})).toMatchObject({ok:true,data:{fields:next.fields,patch:null,apply:{enabled:false}}});expect(await call('jobs',{action:'health_view'})).toMatchObject({ok:true,data:{schema:'health-history-view-v1',projectId:'project',runs:[]}});expect(f.fake.runs).toHaveLength(0);
});
