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
import { ProjectSettingsEditorSchema, ProjectSettingsEditorSavedSchema } from '../packages/core/dist/index.js';
import { seedConversationDecision } from './helpers/conversation-decision-fixture.js';
import { ConversationComposerViewSchema } from '../packages/core/dist/index.js';
import { seedRouteDecision } from './helpers/route-fixtures.js';
import { afterEach, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlugin, callCommand, hookCommand, pluginCommand, statuslineCommand } from '../packages/cli/dist/owner-commands.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { reportStep, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { ProjectRouteWhyViewSchema, ProjectThreadOverrideEditorSchema, ThreadCreatedViewSchema, OwnerToolResultSchema, ProjectGoalEditorSchema, ProjectJobEditorSchema } from '../packages/core/dist/index.js';

let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
const claudeAvailable = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;

test('CLI status exposes the shared cache view without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['status'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { cacheView: { schema: 'session-cache-view-v1', projectId: 'project', line: { ratio: 'Unknown', coldStarts: 0 }, table: { rows: [] } } } }); expect(f.fake.runs).toHaveLength(0);
  expect(result).toMatchObject({ ok: true, data: { historyView: { schema: 'session-history-view-v1', projectId: 'project', visible: false, entries: [] } } });
});

test('CLI native conversation view send and cancel share canonical presentation and receipts', async () => {
  f = await projectFixture({ control: true }); const core = await import('../packages/core/dist/index.js'), id = 'cursor_' + '7'.repeat(32), owner = f.app.device.deviceId, at = new Date().toISOString(), scope = { schema: 'native-session-ref-v1' as const, id, ownerDeviceId: owner, gatewayDeviceId: owner }, session = core.CursorSessionSchema.parse({ schema: 'cursor-session-v1', id, runtime: 'cursor', ownerDeviceId: owner, deviceName: 'Fixture', title: 'Native CLI conversation', cwd: null, project: 'Fixture', state: 'working', lastActivityAt: at, connected: true, canSteer: true, canSend: true }); let messages:Array<ReturnType<typeof core.CursorMessageSchema.parse>>=[]; f.app.cursor.read = async () => core.CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session, turns: [], activity: [], messages, truncated: false, observedAt: at }); f.app.cursor.send = async (_device,_id,input) => { const parsed=core.CursorMessageInputSchema.parse(input),message=core.CursorMessageSchema.parse({...parsed,schema:'cursor-message-v1',sessionId:id,createdAt:at,state:'queued',generation:'fixture'});messages=[message];return message; };f.app.cursor.cancel=async(_device,_id,messageId)=>{const message=core.CursorMessageSchema.parse({...messages.find(row=>row.clientMessageId===messageId)!,state:'cancelled'});messages=[message];return message;};const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
  expect(await callCommand(['jev','native_conversation_view','--request',JSON.stringify(scope)],f.homes)).toBe(0);const view=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(view).toMatchObject({ok:true,data:{presentation:{title:'Native CLI conversation',composer:{primaryMode:'steer'}}}});const command=core.nativeMessageAttempt(null,scope,'  CLI message.  ','next','message_cli_conversation').command;output.mockClear();expect(await callCommand(['jev','native_message_send','--request',JSON.stringify(command)],f.homes)).toBe(0);expect(OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])))).toMatchObject({ok:true,data:{schema:'native-message-receipt-v1',message:{text:'CLI message.',state:'queued'}}});output.mockClear();expect(await callCommand(['jev','native_message_cancel','--request',JSON.stringify({schema:'native-conversation-command-v1',operation:'cancel',ref:scope,clientMessageId:'message_cli_conversation'})],f.homes)).toBe(0);expect(messages[0]!.state).toBe('cancelled');expect(f.fake.runs).toHaveLength(0);
});

test('CLI native reading purposes share list policy and scoped transcript presentation', async () => {
  f = await projectFixture({ control: true }); const core = await import('../packages/core/dist/index.js'), id = 'cursor_' + '3'.repeat(32), at = new Date().toISOString(), owner = f.app.device.deviceId, session = core.CursorSessionSchema.parse({ schema: 'cursor-session-v1', id, runtime: 'cursor', ownerDeviceId: owner, deviceName: 'Fixture', title: 'Native CLI reader', cwd: null, project: 'Fixture', state: 'idle', lastActivityAt: at, connected: true, canSteer: false, canSend: true }); f.app.cursor.list = async () => core.CursorListSchema.parse({ schema: 'cursor-list-v1', sessions: [session], unavailable: [], observedAt: at }); f.app.cursor.read = async () => core.CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session, turns: [], activity: [], messages: [], truncated: false, observedAt: at });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined); expect(await callCommand(['jev', 'native_list_view'], f.homes)).toBe(0); const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result).toMatchObject({ ok: true, data: { kind: 'ready', policy: { listPollMs: 3000 }, list: { sessions: [{ id, gatewayDeviceId: owner }] } } });
  output.mockClear(); expect(await callCommand(['jev', 'native_transcript_view', '--request', JSON.stringify({ schema: 'native-session-ref-v1', id, ownerDeviceId: owner, gatewayDeviceId: owner })], f.homes)).toBe(0); const transcript = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(transcript).toMatchObject({ ok: true, data: { kind: 'ready', policy: { transcriptPollMs: 1500 }, presentation: { connected: true, working: false, stateLabel: 'Idle' } } }); expect(f.fake.runs).toHaveLength(0);
});

test('CLI native connection editor and captured command share normalized canonical settings', async () => {
  f = await projectFixture({ control: true }); const core = await import('../packages/core/dist/index.js'); f.app.cursor.list = async () => core.CursorListSchema.parse({ schema: 'cursor-list-v1', sessions: [], unavailable: [], observedAt: new Date().toISOString() }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'native_connections_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result.ok).toBe(true); if (!result.ok) throw new Error('Editor refused.'); const editor = core.NativeConnectionsEditorSchema.parse(result.data);
  const command = core.nativeConnectionAddCommand(editor.context, { ...editor.fields, name: 'CLI fixture', user: 'fixture', port: '2222', host: ' host.test ', helperPath: '/simulated/cursor-stdio.mjs', home: '/simulated/home' }); output.mockClear(); expect(await callCommand(['config', 'native_connections_command', '--request', JSON.stringify(command)], f.homes)).toBe(0);
  const saved = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(saved).toMatchObject({ ok: true, data: { schema: 'native-connections-saved-v1', editor: { rows: [{ connection: { id: editor.context.draftId, host: 'host.test', port: 2222 }, summary: { text: 'Existing SSH · host.test' } }] } } }); expect(f.app.cursor.connections().connections).toHaveLength(1); expect(f.fake.runs).toHaveLength(0);
});

test('CLI native policy returns canonical runtime eligibility without reading native sessions', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'native_policy'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'native-conversation-policy-v1', historyDays: 5, followupHours: 7, runtimes: [{ runtime: 'cursor', canCompose: true }, { runtime: 'claude', canCompose: false }, { runtime: 'codex', canCompose: false }] } }); expect(f.fake.runs).toHaveLength(0);
});

test('CLI thread view returns the shared presentation without steering work', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated CLI thread ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'cli_thread_presentation', title: 'CLI thread view', task: 'Inspect the simulated fixture.' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle'); f.app.projectWork.store.update(made.threadId,row=>({...row,stateReason:'Wait until 2026-10-22T04:00:00.000Z'})); const before = structuredClone(f.thread(made.threadId));
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['thread', 'view', '--thread', made.threadId], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-thread-view-v1', presentation: { schema: 'project-thread-presentation-v1', actions: { allowTurnsStep: 10 }, composer: { block: null } } } }); expect(f.thread(made.threadId)).toEqual(before);
  expect(result).toMatchObject({ ok: true, data: { timeline: { schema: 'project-thread-timeline-v1', projectId: 'project', threadId: made.threadId } } });
  expect(result).toMatchObject({ ok: true, data: { presentation: { controls: { schema: 'project-thread-controls-v1', browserTakeover: true, attachPanel: true, stop: { title: 'Stop this thread?' } } } } });
  expect(result).toMatchObject({ ok: true, data: { images: { schema: 'project-thread-images-v1', projectId: 'project', threadId: made.threadId } } });
  expect(result).toMatchObject({ ok: true, data: { presentation: { composer: { steering: { schema: 'project-thread-steering-view-v1', offered: false, label: 'Interrupt current turn' } } } } });
  expect(result).toMatchObject({ ok: true, data: { historyView: { schema: 'session-history-view-v1', projectId: 'project', visible: false, entries: [] } } });
  expect(result).toMatchObject({ok:true,data:{readHint:{schema:'project-thread-read-hint-v1',pollHintMs:10000,policy:{liveMs:1500,restMs:10000,afterActionMs:6000}}}});
  expect(result).toMatchObject({ok:true,data:{presentation:{reason:{display:{schema:'project-thread-display-text-v1',text:'Wait until 2026-10-22T04:00:00.000Z',parts:[{kind:'text',value:'Wait until '},{kind:'time',value:'2026-10-22T04:00:00.000Z'}]}}}}});
});

test('CLI task compose editor shares defaults and explicit form normalization', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['work', 'editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result).toMatchObject({ ok: true, data: { schema: 'project-task-editor-v1', fields: { type: 'feature', now: false } } });
  if (!result.ok) throw new Error('Expected task compose editor.'); const fields = (result.data as { fields: object }).fields;
  output.mockClear(); expect(await callCommand(['work', 'preview', '--request', JSON.stringify({ schema: 'project-task-editor-preview-v1', fields: { ...fields, title: '  CLI draft  ', task: '  Preserve queue admission.  ', needs: 'mac, residential' } })], f.homes)).toBe(0);
  const prepared = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(prepared).toMatchObject({ ok: true, data: { canSave: true, plan: { body: { title: 'CLI draft', brief: 'Preserve queue admission.', needs: ['mac', 'residential'], fixed: {} } } } }); expect(f.fake.runs).toHaveLength(0);
});

test('CLI setup proposal reader shares engine labels without applying work', async () => {
  f = await projectFixture({ control: true }); await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  const { proposal } = await f.app.projectWork.proposeSetup(f.project.id, 'cli_setup_copy', { items: [{ key: 'testCommand', value: 'npm test' }] });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'setup_view', '--proposal', proposal.id], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result).toMatchObject({ ok: true, data: { presentation: { schema: 'project-setup-presentation-v1', appliedLine: null, items: [{ index: 0, label: 'Test command' }] } } }); expect(f.fake.runs).toHaveLength(0);
});

test('CLI task mirror editor shares nonsecret defaults and the canonical scoped save', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'mirror_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result).toMatchObject({ ok: true, data: { schema: 'ekoa-editor-v1', fields: { enabled: false }, connect: { defaultUrl: 'https://mcp.ekoa.io/mcp' } } });
  if (!result.ok) throw new Error('Expected mirror editor.'); const view = result.data as { state: { settings: { revision: number } }; fields: object };
  const request = { schema: 'ekoa-editor-save-v1', revision: view.state.settings.revision, fields: view.fields, operation: 'save', clientRequestId: 'mirror_cli_save' };
  output.mockClear(); expect(await callCommand(['config', 'mirror_save', '--request', JSON.stringify(request)], f.homes)).toBe(0); expect(f.app.ekoa!.settings()).toMatchObject({ revision: 1, enabled: false }); expect(f.fake.runs).toHaveLength(0);
});

test('CLI settings navigation and cleanup writer share the engine model', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'navigation'], f.homes)).toBe(0);
  const navigation = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(navigation).toMatchObject({ ok: true, data: { schema: 'settings-navigation-v1', defaultPage: 'runtimes' } });
  output.mockClear(); expect(await callCommand(['config', 'cleanup_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected cleanup editor.'); const view = result.data as { revision: number; fields: object };
  const request = { schema: 'cleanup-settings-save-v1', revision: view.revision, fields: { ...view.fields, freeDiskFloorGb: '51.5' }, clientRequestId: 'cleanup_cli_fixture' };
  output.mockClear(); expect(await callCommand(['config', 'cleanup_save', '--request', JSON.stringify(request)], f.homes)).toBe(0);
  expect((await f.app.configuration()).configuration['x-jevellan'].cleanup.freeDiskFloorGb).toBe(51.5); expect(f.fake.runs).toHaveLength(0);
});

test('CLI Projects editors share global limit bounds and draft project defaults without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'limits_editor'], f.homes)).toBe(0);
  const limit = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(limit).toMatchObject({ ok: true, data: { schema: 'global-thread-limit-editor-v1', input: { min: 1, max: 20, step: 1 } } });
  output.mockClear(); expect(await callCommand(['config', 'project_editor'], f.homes)).toBe(0);
  const project = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(project).toMatchObject({ ok: true, data: { schema: 'project-definition-editor-v1', fields: { branchPolicy: 'main', memory: { mode: 'hub', dir: '.jevellan/memory' } } } }); expect(f.fake.runs).toHaveLength(0);
});

test('CLI account editor shares defaults and canonical subscription save without starting login', async () => {
  f = await accountEditorFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'account_editor', '--runtime', 'claude'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result.ok).toBe(true);
  const view = result.ok ? result.data as { context: object; fields: object } : undefined;
  const request = { schema: 'account-editor-save-v1', context: view!.context, fields: { ...view!.fields, label: 'CLI editor fixture' }, clientRequestId: 'account_editor_cli' };
  output.mockClear(); expect(await callCommand(['config', 'account_save', '--request', JSON.stringify(request)], f.homes)).toBe(0);
  const saved = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(saved).toMatchObject({ ok: true, data: { schema: 'account-editor-saved-v1', startLogin: true, account: { account: { label: 'CLI editor fixture', kind: 'subscription', ceilingPct: 90 } } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI runtime settings share canonical controls and scoped cache saves', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'runtimes_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result.ok).toBe(true);
  const view = result.ok ? result.data as { rows: Array<{ write: { body: object } }> } : undefined;
  const request = { ...view!.rows[0]!.write.body, patch: { cacheWindowMinutes: '42' }, clientRequestId: 'runtime_cli_save' };
  output.mockClear(); expect(await callCommand(['config', 'runtimes_save', '--request', JSON.stringify(request)], f.homes)).toBe(0);
  expect((await f.app.configuration()).configuration['x-jevellan'].runtimes.fake?.cacheWindowMinutes).toBe(42); expect(f.fake.runs).toHaveLength(0);
});

test('CLI account read model uses the shared device-bound projection without checking accounts', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'accounts_view'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'accounts-settings-view-v1', currentDeviceId: f.app.device.deviceId, refreshMs: 30000 } });
  expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected account actions.');
  const { AccountsSettingsViewSchema } = await import('../packages/core/dist/index.js'); const actions = AccountsSettingsViewSchema.parse(result.data).runtimes.find(row => row.id === 'fake')!.accounts[0]!;
  expect(actions).toMatchObject({ actions: expect.arrayContaining([expect.objectContaining({ id: 'toggle', kind: 'write', body: expect.objectContaining({ enabled: false }) })]), deepLinkAction: { id: 'login', kind: 'login', expected: { accountId: 'acc_fixture', deviceId: f.app.device.deviceId } } });
});

test('CLI configuration editor exposes shared history and canonical export metadata', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'configuration_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'configuration-editor-v1', yaml: { downloadName: 'apm.yml' }, import: { previewPath: '/api/config/import-preview' } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI config About returns device identity and command text without maintenance', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'about'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'device-about-view-v1', currentDeviceId: f.app.device.deviceId, commands: { update: 'jevellan update', uninstall: 'jevellan uninstall' } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI config usage exposes canonical ranges and empty presentation without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'usage', '--range', '7d'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-usage-view-v1', range: '7d', presentation: { schema: 'project-usage-presentation-v1', empty: true, defaultRange: 'today' } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI config notification editor reports browser state as unknown without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'notification_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'notification-editor-v1', active: null, canEnable: false, devices: [], native: { workerWaitMs: 15000 } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI config environment editor exposes canonical limits without password values', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'environment_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-environment-editor-v1', limits: { variables: 200, secrets: 100, name: 64 }, fields: { variables: [], secrets: [] } } });
  if (!result.ok) throw new Error('Expected environment editor.'); const view = ProjectEnvironmentEditorSchema.parse(result.data);
  output.mockClear(); expect(await callCommand(['config', 'environment_preview', '--request', JSON.stringify({ ...view.request.base, fields: { ...view.fields, copyFiles: ' local.env \n', variables: [{ name: 'FIXTURE_VAR', value: 'CLI value' }] } })], f.homes)).toBe(0);
  const preview = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); if (!preview.ok) throw new Error('Expected environment preview.');
  output.mockClear(); expect(await callCommand(['config', 'environment_save', '--request', JSON.stringify(ProjectEnvironmentEditorSchema.parse(preview.data).saveRequest)], f.homes)).toBe(0);
  expect((await f.app.projectWork.settingsView('project')).settings.environment).toMatchObject({ copyFiles: ['local.env'], variables: [{ name: 'FIXTURE_VAR', value: 'CLI value' }] });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI config placement editor exposes the shared constraint form', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['config', 'placement_editor'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-placement-editor-v1', fields: { allModels: true, modelIds: ['fixture'], minEffort: '' }, guidance: { maxLength: 2000 } } });
  if (!result.ok) throw new Error('Expected placement editor.'); const view = ProjectPlacementEditorSchema.parse(result.data);
  output.mockClear(); expect(await callCommand(['config', 'placement_preview', '--request', JSON.stringify({ ...view.request.base, fields: { ...view.fields, allModels: false, minEffort: 'low', guidance: 'CLI placement guidance.' } })], f.homes)).toBe(0);
  const preview = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); if (!preview.ok) throw new Error('Expected placement preview.');
  output.mockClear(); expect(await callCommand(['config', 'placement_save', '--request', JSON.stringify(ProjectPlacementEditorSchema.parse(preview.data).saveRequest)], f.homes)).toBe(0);
  expect((await f.app.projectWork.settingsView('project')).settings.placement).toEqual({ allowedModelIds: ['fixture'], minEffort: 'low', guidance: 'CLI placement guidance.' });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI config settings editor exposes the shared project form and value-free summaries', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const settings = (await f.app.projectWork.settingsView('project')).settings;
  expect(await callCommand(['config', 'settings_editor'], f.homes)).toBe(0);
  const encoded = output.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-settings-editor-v1', settingsView: { settings }, secretStates: [], savePath: '/api/projects/project/config/editor', controls: { schema: 'project-settings-controls-v1', numbers: { maxRunningThreads: { min: 1, max: 20 } } }, rigging: { schema: 'project-settings-rigging-v1', editPath: '/settings/rigging' } } }); expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected project settings editor.'); const view = ProjectSettingsEditorSchema.parse(result.data);
  output.mockClear(); expect(await callCommand(['config', 'settings_save', '--request', JSON.stringify({ schema: 'project-settings-editor-save-v1', clientRequestId: 'cli_form_settings', base: view.settingsView.settings, draft: { ...view.settingsView.settings, instructions: 'CLI draft.' }, secretPresence: {} })], f.homes)).toBe(0);
  const saved = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); if (!saved.ok) throw new Error('Expected project settings save.');
  expect(ProjectSettingsEditorSavedSchema.parse(saved.data).settingsView.settings.instructions).toBe('CLI draft.');
  await f.app.state.environment.put('project', 'CLI_SECRET', 'owned fixture value');
  expect(await callCommand(['config', 'remove_secret', '--name', 'CLI_SECRET'], f.homes)).toBe(0); expect((await f.app.state.environment.summary('project', 'CLI_SECRET')).saved).toBe(false);
});

test('CLI config landing editor exposes raw draft constraints and canonical save data', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const settings = (await f.app.projectWork.settingsView('project')).settings;
  expect(await callCommand(['config', 'landing_editor'], f.homes)).toBe(0);
  const encoded = output.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-landing-editor-v1', fields: { delivery: settings.delivery }, limits: { checks: 30 }, saveRequest: { projectId: 'project', settingsRequest: { revision: settings.revision } } } }); expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected landing editor.'); const view = ProjectLandingEditorSchema.parse(result.data);
  output.mockClear(); expect(await callCommand(['config', 'landing_preview', '--request', JSON.stringify({ ...view.request.base, fields: { ...view.fields, smokeCheck: 'true' } })], f.homes)).toBe(0);
  const preview = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); if (!preview.ok) throw new Error('Expected landing preview.');
  expect(await callCommand(['config', 'landing_save', '--request', JSON.stringify(ProjectLandingEditorSchema.parse(preview.data).saveRequest)], f.homes)).toBe(0);
  expect((await f.app.projectWork.settingsView('project')).settings.smokeCheck).toBe('true');
});

test('CLI config settings change views include canonical sentences and Undo data', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { change } = await f.app.projectWork.coordinatorSettings('project', { maxRunningThreads: 7, ownerWords: 'Use seven.' }, 'cli_settings_change');
  expect(await callCommand(['config', 'settings_change', '--request', JSON.stringify({ schema: 'project-settings-change-view-request-v1', change })], f.homes)).toBe(0);
  const encoded = output.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-settings-change-view-v1', changeId: change.id, items: [{ field: 'maxRunningThreads', undo: { body: { schema: 'project-settings-undo-request-v1' } } }] } }); expect(f.fake.runs).toHaveLength(0);
  if (!result.ok) throw new Error('Expected settings change view.'); const view = ProjectSettingsChangeViewSchema.parse(result.data);
  expect(await callCommand(['config', 'settings_undo', '--request', JSON.stringify(view.items[0]!.undo!.body)], f.homes)).toBe(0);
  expect((await f.app.projectWork.settingsView('project')).settings.maxRunningThreads).toBe(change.changes[0]!.before);
});

test('CLI config coordinator editor exposes engine choices and canonical save data', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const settings = (await f.app.projectWork.settingsView('project')).settings;
  expect(await callCommand(['config', 'coordinator_editor'], f.homes)).toBe(0);
  const encoded = output.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-coordinator-editor-v1', fields: { modelId: settings.coordinator.modelId ?? '', effort: settings.coordinator.effort, fresh: false }, saveRequest: { projectId: 'project', settingsRequest: { revision: settings.revision } } } });
  if (!result.ok) throw new Error('Expected coordinator editor.'); const view = ProjectCoordinatorEditorSchema.parse(result.data);
  output.mockClear(); expect(await callCommand(['config', 'coordinator_preview', '--request', JSON.stringify({ ...view.request.base, presentation: 'project-settings', fields: { ...view.fields, modelId: 'fixture', effort: 'low' } })], f.homes)).toBe(0);
  const preview = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); if (!preview.ok) throw new Error('Expected coordinator preview.');
  expect(preview.data).toMatchObject({ request: { base: { presentation: 'project-settings' } }, efforts: expect.arrayContaining([{ value: 'xhigh', label: 'Extra high' }]) });
  output.mockClear(); expect(await callCommand(['config', 'coordinator_save', '--request', JSON.stringify(ProjectCoordinatorEditorSchema.parse(preview.data).saveRequest)], f.homes)).toBe(0);
  expect((await f.app.projectWork.settingsView('project')).settings.coordinator).toMatchObject({ modelId: 'fixture', effort: 'low' });
  expect(f.fake.runs).toHaveLength(0);
});

test('CLI config project reads include the canonical configuration metadata', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const expected = await (await f.request('/api/projects/project/work-settings')).json();
  expect(await callCommand(['config', 'get', '--section', 'project'], f.homes)).toBe(0);
  const encoded = output.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected CLI project configuration.');
  expect(result.data).toEqual(expected); expect(result.data).toHaveProperty('configuration.instructions.maxLength', 16000); expect(f.fake.runs).toHaveLength(0);
});

test('improver read projections reach the CLI without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const expected = await f.json('/api/improver', ImproverStateSchema), history = f.app.hub.configuration.history();
  expect(await callCommand(['jev', 'improver'], f.homes)).toBe(0);
  const encoded = output.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined); expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected CLI improver read projection.');
  expect(ImproverStateSchema.parse(result.data)).toEqual(expected); expect(f.fake.runs).toHaveLength(0); expect(f.app.hub.configuration.history()).toEqual(history);
});

test('CLI Decisions settings use the shared scoped editor and recover the same save receipt', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'settings_editor'], f.homes)).toBe(0);
  const encoded = output.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected CLI settings editor.');
  const view = DecisionsSettingsEditorSchema.parse(result.data), fields = { ...view.fields, routingProfile: 'CLI settings guidance.' };
  output.mockClear(); expect(await callCommand(['jev', 'settings_preview', '--request', JSON.stringify({ ...view.preview.request, fields })], f.homes)).toBe(0);
  const previewResult = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(previewResult.ok).toBe(true); if (!previewResult.ok) throw new Error('Expected CLI settings preview.');
  const draft = DecisionsSettingsEditorSchema.parse(previewResult.data), before = f.app.hub.configuration.current()!.revision;
  for (let attempt = 0; attempt < 2; attempt++) { output.mockClear(); expect(await callCommand(['jev', 'settings_save', '--request', JSON.stringify(draft.saveRequest)], f.homes)).toBe(0); const saved = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(saved.ok).toBe(true); if (!saved.ok) throw new Error('Expected CLI settings save.'); expect(ConfigRevisionSchema.parse(saved.data).revision).toBe(before + 1); }
  expect(f.app.hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe(fields.routingProfile); expect(f.fake.runs).toHaveLength(0);
});

test('CLI editor templates include their versioned request data', async () => {
  f = await projectFixture({ control: true });
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await callCommand(['jobs', 'editor', '--kind', 'job'], f.homes)).toBe(0);
  const encoded = out.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{'));
  const result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected the CLI editor model.');
  const view = ProjectJobEditorSchema.parse(result.data), request = { ...view.request.base, fields: { ...view.defaults, name: 'CLI editor fixture', command: 'true', enabled: false } };
  expect(await callCommand(['jobs', 'save', '--request', JSON.stringify(request)], f.homes)).toBe(0);
  expect((await f.app.projectWork.daily.jobs('project')).map(job => job.name)).toEqual(['CLI editor fixture']);
});

test('jevellan call reaches every tool from a terminal with positional subjects and typed values', async () => {
  f = await projectFixture({ control: true });
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined), err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['work', 'add', '--title', 'Fix the typo', '--priority', 'urgent'], f.homes)).toBe(0);
  expect(out).toHaveBeenLastCalledWith('Added T1 as urgent. It starts next.');
  expect(await callCommand(['status', '--section', 'queued'], f.homes)).toBe(0);
  expect(await callCommand(['respond', 'W7', 'deploy'], f.homes)).toBe(1);
  expect(err).toHaveBeenLastCalledWith('W7 is not waiting on you. Nothing is waiting on you.');
  expect(await callCommand(['nothing'], f.homes)).toBe(1);
  expect(f.app.ownerTools.callerLog().every(entry => entry.caller === 'cli')).toBe(true);
});

test('the status line answers fast, says when there is no project or service, and wraps another status line', async () => {
  f = await projectFixture({ control: true });
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const input = JSON.stringify({ workspace: { current_dir: f.checkout } });
  const started = Date.now();
  expect(await statuslineCommand([], f.homes, async () => input)).toBe(0);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(String(out.mock.calls.at(-1)![0])).toMatch(new RegExp(`^Jevellan ${f.project.name} · 0 running · 0 queued · 0 waiting`, 'u'));
  expect(await statuslineCommand(['--wrap', 'cat >/dev/null; printf mine'], f.homes, async () => input)).toBe(0);
  expect(String(out.mock.calls.at(-1)![0])).toMatch(/^mine {2}\| {2}Jevellan /u);
  const { Homes } = await import('../packages/core/dist/index.js');
  expect(await statuslineCommand([], new Homes(join(f.root, 'nowhere')), async () => input)).toBe(0);
  expect(out).toHaveBeenLastCalledWith('Jevellan · not running');
});

test('plugin build generates the plugin, its marketplace, hook and forwarder entry outside the repository', async () => {
  f = await projectFixture();
  const root = buildPlugin(f.homes);
  expect(root).toBe(join(f.homes.root, 'plugin-dist', 'claude'));
  const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  expect(marketplace).toMatchObject({ name: 'jevellan-local', plugins: [{ name: 'jevellan', source: './jevellan' }] });
  const mcp = JSON.parse(readFileSync(join(root, 'jevellan', '.mcp.json'), 'utf8'));
  expect(mcp.mcpServers.jevellan.args.at(-1)).toBe('mcp'); expect(mcp.mcpServers.jevellan.env).toEqual({ JEVELLAN_HOME: f.homes.root });
  for (const name of ['status', 'overnight', 'goals', 'configure', 'jev']) expect(existsSync(join(root, 'jevellan', 'commands', `${name}.md`))).toBe(true);
  expect(readFileSync(join(root, 'jevellan', 'commands', 'status.md'), 'utf8')).toContain('Call the jevellan status tool for the current project and show its result exactly as returned.');
  expect(JSON.parse(readFileSync(join(root, 'jevellan', 'hooks', 'hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command).toMatch(/ hook session-start$/u);
  expect(JSON.parse(readFileSync(join(root, 'jevellan', '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'jevellan', channels: [{ server: 'jevellan' }] });
});

test.skipIf(!claudeAvailable)('plugin install registers the local marketplace and installs at user scope in the given config folder', async () => {
  f = await projectFixture();
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const dir = mkdtempSync(join(tmpdir(), 'jevellan-plugin-'));
  expect(pluginCommand(['install', '--claude-config-dir', dir], f.homes)).toBe(0);
  expect(out).toHaveBeenLastCalledWith(`Installed the Jevellan plugin for Claude Code (${dir}). Ask any Claude Code session in a project folder "what's running?".`);
  const listed = spawnSync('claude', ['plugin', 'list'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8' }).stdout;
  expect(listed).toContain('jevellan@jevellan-local');
});

test('the session-start hook adds one line in the bridge and nothing elsewhere', async () => {
  f = await projectFixture({ control: true });
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await hookCommand(['session-start'], f.homes, { JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: f.project.name })).toBe(0);
  expect(out).toHaveBeenLastCalledWith(`Jevellan bridge for ${f.project.name}. Waiting on you: 0. Running: 0.`);
  out.mockClear();
  expect(await hookCommand(['session-start'], f.homes, { JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: f.project.name, JEVELLAN_ROLE: 'thread' })).toBe(0);
  expect(await hookCommand(['session-start'], f.homes, {})).toBe(0);
  expect(out).not.toHaveBeenCalled();
});

test('statusline install wraps an existing status line in the given config folder', async () => {
  f = await projectFixture();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const dir = mkdtempSync(join(tmpdir(), 'jevellan-statusline-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: '~/bin/line.sh' } }));
  expect(await statuslineCommand(['install', '--claude-config-dir', dir], f.homes)).toBe(0);
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  expect(settings.theme).toBe('dark'); expect(settings.statusLine.command).toMatch(/ statusline --wrap '~\/bin\/line\.sh'$/u);
  expect(await statuslineCommand(['install', '--claude-config-dir', dir], f.homes)).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).statusLine.command).toBe(settings.statusLine.command);
});


test('CLI goal editor templates preserve defaults and the canonical save request', async () => {
  f = await projectFixture({ control: true }); const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await callCommand(['goals', 'editor'], f.homes)).toBe(0);
  const encoded = out.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{'));
  const result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected the CLI goal editor.');
  const view = ProjectGoalEditorSchema.parse(result.data), request = { ...view.request.base, fields: { ...view.defaults, name: 'CLI goal fixture', motivation: 'Shared canonical writer.' } };
  expect(await callCommand(['goals', 'save', '--request', JSON.stringify(request)], f.homes)).toBe(0);
  expect((await f.app.projectWork.goalList('project')).goals).toMatchObject([{ goal: { name: 'CLI goal fixture', dailyRefillCap: 3, openPrCap: 2 } }]);
});


test('CLI Jev Why retains the same versioned placement explanation as the UI', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'CLI explanation fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'cli_why', title: 'CLI explanation', task: 'Inspect the simulated fixture.' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle');
  const ui = await (await f.request(`/api/projects/project/threads/${made.threadId}/why-view`)).json(), out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'why', '--thread', made.threadId], f.homes)).toBe(0);
  const encoded = out.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{'));
  expect(OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined)).toMatchObject({ ok: true, data: ui });
});


test('CLI override templates preserve requested effort and save through the canonical writer', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'CLI override editor.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'cli_override_editor', title: 'CLI override editor', task: 'Inspect the simulated fixture.', effort: 'medium' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle');
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'override_editor', '--thread', made.threadId], f.homes)).toBe(0);
  const encoded = out.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected the CLI override editor.');
  const editor = ProjectThreadOverrideEditorSchema.parse(result.data); expect(editor.fields.effort).toBe('medium');
  const request = { ...editor.request.base, fields: { ...editor.fields, effort: 'high' } };
  expect(await callCommand(['jev', 'override_save', '--thread', made.threadId, '--request', JSON.stringify(request)], f.homes)).toBe(0);
  expect(f.thread(made.threadId).placement.effortRequested).toBe('high');
});


test('CLI route models carry a reusable canonical correction request', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'CLI route fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'cli_route_model', title: 'CLI route model', task: 'Inspect the simulated route.' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle');
  await seedRouteDecision(f.app.projectHub, { projectId: 'project', threadId: made.threadId, deviceId: f.app.device.deviceId, commit: 'a'.repeat(40), at: f.thread(made.threadId).createdAt }, 'landing');
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined); expect(await callCommand(['jev', 'why', '--kind', 'landing', '--thread', made.threadId], f.homes)).toBe(0);
  const encoded = out.mock.calls.map(row => String(row[0])).find(text => text.startsWith('{')), result = OwnerToolResultSchema.parse(encoded ? JSON.parse(encoded) : undefined);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected the CLI route model.'); const model = ProjectRouteWhyViewSchema.parse(result.data);
  const request = model.correctionActions[0]!.request.body;
  for (let n = 0; n < 2; n++) expect(await callCommand(['jev', 'route_correct', '--thread', made.threadId, '--request', JSON.stringify(request)], f.homes)).toBe(0);
  expect((await f.app.projectHub.mergeDocuments('project')).records.filter(row => row.schema === 'landing-correction-v1')).toHaveLength(1);
});


test('CLI composer models preview draft scope and retry the same canonical conversation choice', async () => {
  f = await projectFixture({ control: true }); const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const initial = { schema: 'composer-initial-v1', once: { effort: 'high' }, pins: { effort: 'low' } };
  const result = () => { const value = OwnerToolResultSchema.parse(JSON.parse(String(out.mock.calls.at(-1)?.[0]))); if (!value.ok) throw new Error('Expected the CLI composer model.'); return ConversationComposerViewSchema.parse(value.data); };
  expect(await callCommand(['jev', 'composer_editor', '--initial', JSON.stringify(initial)], f.homes)).toBe(0);
  expect(result().fields.find(field => field.id === 'effort')).toMatchObject({ selected: 'high', scope: 'once-then-pin' });
  const keep = result().fields.find(field => field.id === 'effort')!.keep;
  expect(await callCommand(['jev', 'composer_preview', '--initial', JSON.stringify(initial), '--request', JSON.stringify(keep)], f.homes)).toBe(0);
  expect(result().initial).toMatchObject({ once: {}, pins: { effort: 'high' } });
  await f.app.conversations.create({ schema: 'start-conversation-v1', id: 'cli_composer', projectId: 'project', title: 'CLI composer', message: 'Explain the fixture.', clientMessageId: 'cli_composer_first' }); await f.app.conversations.wait('cli_composer');
  expect(await callCommand(['jev', 'composer_editor', '--conversation', 'cli_composer'], f.homes)).toBe(0);
  const request = result().fields.find(field => field.id === 'effort')!.options.find(option => option.value === 'high')!.choice;
  for (let attempt = 0; attempt < 2; attempt++) expect(await callCommand(['jev', 'composer_save', '--conversation', 'cli_composer', '--request', JSON.stringify(request)], f.homes)).toBe(0);
  expect((await f.app.conversations.view('cli_composer')).composerOverrides.filter(row => row.request.clientRequestId === request.clientRequestId)).toHaveLength(1);
  expect(f.fake.starts).toHaveLength(0);
});


test('CLI conversation Why and step correction templates retain the canonical receipt on retry', async () => {
  f = await projectFixture({ control: true, testCommand: 'true' }); const { id, decision } = await seedConversationDecision(f, 'cli_decision_fixture'), out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const result = () => { const value = OwnerToolResultSchema.parse(JSON.parse(String(out.mock.calls.at(-1)?.[0]))); if (!value.ok) throw new Error('Expected CLI model data.'); return value.data; };
  expect(await callCommand(['jev', 'conversation_why', '--conversation', id, '--decision', decision.id], f.homes)).toBe(0);
  expect(ConversationDecisionWhyViewSchema.parse(result()).action.options.map(row => row.id)).toEqual(['implement', 'plan', 'reply']);
  expect(await callCommand(['jev', 'correction_editor', '--conversation', id, '--stretch', '1'], f.homes)).toBe(0);
  const editor = StepCorrectionEditorSchema.parse(result()), request = { ...editor.preview.request, fields: { ...editor.fields, effort: 'high' } };
  expect(await callCommand(['jev', 'correction_preview', '--conversation', id, '--request', JSON.stringify(request)], f.homes)).toBe(0);
  const preview = StepCorrectionEditorSchema.parse(result());
  for (let attempt = 0; attempt < 2; attempt++) expect(await callCommand(['jev', 'correction_save', '--conversation', id, '--request', JSON.stringify(preview.requests.noted)], f.homes)).toBe(0);
  expect((await f.app.conversations.view(id)).overrides.filter(row => row.request.clientRequestId === preview.requests.noted!.clientRequestId)).toHaveLength(1); expect(f.fake.starts.length).toBe(1);
});

test('CLI plan reader shares the typed plan model without starting more work', async () => {
  const made = await conversationPlanFixture(true); f = made.f; const starts = f.fake.starts.length;
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'plan_read', '--project', 'project', '--conversation', made.id, '--request', JSON.stringify({ schema: 'conversation-plan-read-request-v1', pointer: made.pointer })], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-plan-read-v1', projectId: 'project', conversationId: made.id, pointer: made.pointer, view: { schema: 'plan-content-view-v1', root: { kind: 'fields' } } } }); expect(f.fake.starts).toHaveLength(starts);
});

test('CLI plan approval uses the canonical writer and shared approved status', async () => {
  const made = await conversationPlanReviewFixture(true); f = made.f;
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'plan_approve', '--project', 'project', '--conversation', made.id, '--request', JSON.stringify({ schema: 'plan-approval-v1', generation: made.view.conversation.generation, ref: made.pointer })], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { conversation: { work: { approvedPlanRef: made.pointer } }, plans: { reviews: [{ badge: 'Approved', offered: false }] } } });
});

test('CLI evidence reader returns the canonical public view without starting work', async () => {
  const made = await conversationPlanFixture(true); f = made.f; const starts = f.fake.starts.length;
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'evidence_read', '--conversation', made.id, '--request', JSON.stringify({ schema: 'conversation-evidence-request-v1', ref: made.pointer })], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-evidence-view-v1', projectId: 'project', conversationId: made.id, reference: { value: made.pointer }, view: { kind: 'text', text: JSON.stringify(f.app.conversations.ledger(made.id).read(made.pointer), null, 2) } } }); expect(f.fake.starts).toHaveLength(starts);
});

test('CLI conversation reader shares delivery and branch presentation without starting work', async () => {
  const made = await conversationPlanFixture(true); f = made.f; const starts = f.fake.starts.length;
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'conversation_view', '--conversation', made.id], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-view-v1', delivery: { schema: 'message-delivery-view-v1', primaryLabel: 'Send' }, branchChanges: [] } }); expect(f.fake.starts).toHaveLength(starts);
});

test('CLI session preferences use the canonical per-device revision writer', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'session_list_save', '--request', JSON.stringify({ schema: 'session-list-update-v1', revision: 0, operation: 'rename', id: 'cli_session', title: 'CLI fixture title' })], f.homes)).toBe(0);
  expect(await callCommand(['jev', 'session_list'], f.homes)).toBe(0);
  const replies = output.mock.calls.filter(row => String(row[0]).startsWith('{')).map(row => OwnerToolResultSchema.parse(JSON.parse(String(row[0])))); expect(replies).toHaveLength(2);
  for (const result of replies) expect(result).toMatchObject({ ok: true, data: { schema: 'session-list-view-v1', deviceId: f.app.device.deviceId, preferences: { revision: 1, titles: { cli_session: 'CLI fixture title' } } } }); expect(f.fake.runs).toHaveLength(0);
});

test('CLI conversation transcript shares the canonical step snapshot without starting work', async () => {
  const made = await conversationPlanReviewFixture(true); f = made.f; const starts = f.fake.starts.length;
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'conversation_transcript', '--conversation', made.id, '--request', JSON.stringify({ schema: 'conversation-transcript-request-v1', step: 1 })], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'conversation-transcript-view-v1', projectId: 'project', conversationId: made.id, step: 1, running: false, fallbackAnswer: null } }); expect(f.fake.starts).toHaveLength(starts);
});

test('CLI owner-command view reads presentation without executing the command', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'owner_command_view', '--command', JSON.stringify({ command: 'printf fixture', why: 'Simulated owner command.', cwd: 'checkout' }), '--device', f.app.device.deviceId], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { schema: 'owner-command-view-v1', projectId: 'project', presentation: { copyOnly: false, receipt: null, header: `${f.app.device.name} · checkout` } } }); expect(f.app.terminals.manager.list()).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
});

test('CLI project page reads the canonical viewer-bound status without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const request = { schema: 'project-page-request-v1', resolvedDays: 28, timeZone: 'UTC', locale: 'en', ackKnown: ['known'] };
  expect(await callCommand(['jev', 'project_page', '--request', JSON.stringify(request)], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  const ordinary = await (await f.request('/api/projects/project/status-view', 'POST', request)).json();
  expect(result).toMatchObject({ ok: true, data: { schema: 'project-page-view-v1', changeToken: ordinary.changeToken, overview: ordinary.overview } }); expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation presentation uses the canonical recorded page metadata without starting work', async () => {
  const made = await conversationPlanReviewFixture(true); f = made.f; const starts = f.fake.starts.length;
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'conversation_view', '--conversation', made.id], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  expect(result).toMatchObject({ ok: true, data: { presentation: { schema: 'conversation-page-presentation-v1', picker: { shown: false } } } }); expect(f.fake.starts).toHaveLength(starts);
});

test('CLI conversation list source uses the canonical owner reader without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'conversation_list'], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  const ordinary = await (await f.request('/api/conversation-list/view')).json(); expect(ordinary).toMatchObject({ schema: 'conversation-list-source-v1', readPolicy: { pollMs: 5000 } });
  expect(result).toMatchObject({ ok: true, data: ordinary }); expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation sidebar view shares canonical merged presentation without starting work', async () => {
  f = await projectFixture({ control: true }); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await callCommand(['jev', 'conversation_sidebar', '--request', JSON.stringify({ schema: 'conversation-sidebar-request-v1', shells: false, filter: 'Running', q: 'fixture' })], f.homes)).toBe(0);
  const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0])));
  const ordinary = await (await f.request('/api/conversation-list/sidebar?shells=false&filter=Running&q=fixture')).json(); expect(result).toMatchObject({ ok: true, data: ordinary }); expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation sidebar actions rename through the canonical guarded writer', async () => {
  f = await projectFixture({ control: true }); await f.app.conversations.create({schema:'start-conversation-v1',id:'cli_sidebar',projectId:'project',title:'CLI sidebar original',message:'Wait for my next step.',clientMessageId:'start_cli_sidebar'});await f.app.conversations.wait('cli_sidebar');
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined); const request={schema:'conversation-sidebar-rename-request-v1',kind:'owner',id:'cli_sidebar',previousTitle:'CLI sidebar original',title:'CLI sidebar renamed',clientRequestId:'rename_cli_sidebar'};
  expect(await callCommand(['jev','conversation_sidebar_rename','--request',JSON.stringify(request)],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{conversation:{id:'cli_sidebar',title:'CLI sidebar renamed'}}});expect((await f.app.conversations.view('cli_sidebar')).conversation.title).toBe('CLI sidebar renamed');expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation new view uses canonical device-bound composer metadata without starting work',async()=>{
 f=await projectFixture({control:true});const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const request={schema:'conversation-new-request-v1',projectId:'project',message:'A simulated composer draft'};expect(await callCommand(['jev','conversation_new','--request',JSON.stringify(request)],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));const ordinary=await(await f.request('/api/conversation-new/view','POST',request)).json();expect(result).toMatchObject({ok:true,data:ordinary});expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation creation draft prepares canonical identity and title without starting work',async()=>{
 f=await projectFixture({control:true});const raw={schema:'conversation-creation-intent-v1',projectId:'project',message:'CLI creation title\nDetails',choices:{schema:'composer-initial-v1',once:{},pins:{}}};const draft=await(await f.request('/api/conversation-new/draft','POST',raw)).json();const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['jev','conversation_create_draft','--request',JSON.stringify({...raw,previous:draft.pending})],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:draft});expect((await f.app.conversations.list()).conversations).toHaveLength(0);expect(f.fake.starts).toHaveLength(0);
});

test('CLI project setup view reads canonical readiness without starting work',async()=>{
 f=await projectFixture({control:true});const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['jev','project_setup','--request',JSON.stringify({schema:'project-setup-wait-request-v1',waitSeconds:0})],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));const ordinary=await(await f.request('/api/projects/project/setup-view')).json();expect(result).toMatchObject({ok:true,data:ordinary});expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation start writes through the same canonical creation service',async()=>{
 f=await projectFixture({control:true});const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const request={schema:'conversation-start-request-v1',deviceId:f.app.device.deviceId,start:{schema:'start-conversation-v1',id:'cli_start',projectId:'project',title:'CLI created',message:'Wait for the next fixture step.',clientMessageId:'message_cli_start'},waitSeconds:0};expect(await callCommand(['jev','conversation_start','--request',JSON.stringify(request)],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{status:'created',view:{conversation:{id:'cli_start',ownerDeviceId:f.app.device.deviceId}}}});expect((await f.app.conversations.list()).conversations).toHaveLength(1);expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation controls read shares canonical metadata without starting extra work',async()=>{
 f=await projectFixture({control:true});const id='cli_controls';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'CLI controls',message:'Wait for the fixture.',clientMessageId:'cli_controls_first'});await f.app.conversations.wait(id);const ordinary=await(await f.request(`/api/conversations/${id}`)).json(),before=f.app.conversations.ledger(id).events().length;const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['jev','conversation_view','--conversation',id],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{controls:{schema:'conversation-controls-view-v1',...ordinary.controls}}});expect(f.app.conversations.ledger(id).events()).toHaveLength(before);expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation message draft and command use the canonical message writer',async()=>{
 f=await projectFixture({control:true});const id='cli_message';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'CLI message',message:'Wait for the fixture.',clientMessageId:'cli_message_first'});await f.app.conversations.wait(id);const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const request={schema:'conversation-message-draft-request-v1',intent:{mode:'compose',kind:'message',text:'CLI fixture message.'}};expect(await callCommand(['jev','conversation_message_draft','--conversation',id,'--request',JSON.stringify(request)],f.homes)).toBe(0);const draft=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(draft).toMatchObject({ok:true,data:{schema:'conversation-message-draft-v1'}});output.mockClear();expect(await callCommand(['jev','conversation_message','--conversation',id,'--request',JSON.stringify(draft.data.command)],f.homes)).toBe(0);expect((await f.app.conversations.view(id)).messages.at(-1)).toMatchObject({text:'CLI fixture message.'});expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation control editor and command rename through the canonical owner writer',async()=>{
 f=await projectFixture({control:true});const id='cli_control';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'CLI control',message:'Wait for the fixture.',clientMessageId:'cli_control_first'});await f.app.conversations.wait(id);const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['jev','conversation_control_editor','--conversation',id,'--request',JSON.stringify({schema:'conversation-control-editor-request-v1',kind:'rename'})],f.homes)).toBe(0);const editor=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(editor).toMatchObject({ok:true,data:{schema:'conversation-control-editor-v1',maxLength:200}});output.mockClear();expect(await callCommand(['jev','conversation_control_draft','--conversation',id,'--request',JSON.stringify({schema:'conversation-control-draft-request-v1',kind:'rename',context:editor.data.context,value:'CLI renamed'})],f.homes)).toBe(0);const draft=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(draft).toMatchObject({ok:true,data:{schema:'conversation-control-draft-v1'}});expect(await callCommand(['jev','conversation_control','--conversation',id,'--request',JSON.stringify(draft.data.command)],f.homes)).toBe(0);expect((await f.app.conversations.view(id)).conversation.title).toBe('CLI renamed');expect(f.fake.starts).toHaveLength(0);
});

test('CLI conversation settlement editor and command share the canonical receipt',async()=>{
 f=await projectFixture({control:true});const id='cli_settlement';await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'CLI settlement',message:'Preserve the fixture.',clientMessageId:'cli_settlement_first'});await f.app.conversations.wait(id);const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 expect(await callCommand(['jev','conversation_settlement_editor','--conversation',id,'--request',JSON.stringify({schema:'conversation-settlement-editor-request-v1'})],f.homes)).toBe(0);const editor=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(editor).toMatchObject({ok:true,data:{schema:'conversation-settlement-editor-v1'}});output.mockClear();expect(await callCommand(['jev','conversation_settlement_draft','--conversation',id,'--request',JSON.stringify({schema:'conversation-settlement-draft-request-v1',context:editor.data.context,choice:'keep'})],f.homes)).toBe(0);const draft=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(draft).toMatchObject({ok:true,data:{schema:'conversation-settlement-draft-v1'}});expect(await callCommand(['jev','conversation_settle','--conversation',id,'--request',JSON.stringify(draft.data.command)],f.homes)).toBe(0);await f.app.conversations.wait(id);expect((await f.app.conversations.view(id)).settlements).toMatchObject([{status:'completed',choice:'keep'}]);expect(f.fake.starts).toHaveLength(0);
});
import {blockedConversationReview,enqueueConversationHandoff,enqueueHeldConversationHandoff} from './helpers/conversation-recovery-fixture.js';

test('CLI conversation recovery editor and command accept the exact reviewed files',async()=>{
 f=await projectFixture({control:true});const {view,changes}=await blockedConversationReview(f,'cli_recovery'),id=view.conversation.id,output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 expect(await callCommand(['jev','conversation_recovery_editor','--conversation',id,'--request',JSON.stringify({schema:'conversation-recovery-editor-request-v1',kind:'adopt',changes})],f.homes)).toBe(0);const editor=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(editor).toMatchObject({ok:true,data:{schema:'conversation-recovery-editor-v1',enabled:true}});output.mockClear();expect(await callCommand(['jev','conversation_recovery_draft','--conversation',id,'--request',JSON.stringify({schema:'conversation-recovery-draft-request-v1',request:editor.data.request})],f.homes)).toBe(0);const draft=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(draft).toMatchObject({ok:true,data:{schema:'conversation-recovery-draft-v1'}});expect(await callCommand(['jev','conversation_recover','--conversation',id,'--request',JSON.stringify(draft.data.command)],f.homes)).toBe(0);await f.app.conversations.wait(id);expect((await f.app.conversations.view(id)).checkpointBlocks).toHaveLength(0);expect(f.fake.starts).toHaveLength(1);
});

test('CLI conversation manual editor and command preserve running guards and completed continuation',async()=>{
 f=await projectFixture({control:true});const id='cli_manual';f.fake.capabilities.readOnlyEnforced=true;await f.app.conversations.create({schema:'start-conversation-v1',id,projectId:'project',title:'CLI manual',message:'Preserve the manual fixture.',clientMessageId:'cli_manual_first'});await f.app.conversations.wait(id);const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 expect(await callCommand(['jev','conversation_manual_editor','--conversation',id],f.homes)).toBe(0);const editor=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(editor).toMatchObject({ok:true,data:{schema:'conversation-manual-editor-v1',defaults:{model:'fixture',effort:'high'}}});output.mockClear();expect(await callCommand(['jev','conversation_manual_draft','--conversation',id,'--request',JSON.stringify({schema:'conversation-manual-draft-request-v1',context:editor.data.context,selection:editor.data.defaults})],f.homes)).toBe(0);const draft=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(draft).toMatchObject({ok:true,data:{schema:'conversation-manual-draft-v1'}});const held=enqueueHeldConversationHandoff(f);try{expect(await callCommand(['jev','conversation_manual','--conversation',id,'--request',JSON.stringify(draft.data.command)],f.homes)).toBe(0);await held.entered;const count=f.app.conversations.ledger(id).events().length;expect(await callCommand(['jev','conversation_manual','--conversation',id,'--request',JSON.stringify(draft.data.command)],f.homes)).toBe(1);expect(f.app.conversations.ledger(id).events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);}finally{held.release();}await f.app.conversations.wait(id);enqueueConversationHandoff(f);expect(await callCommand(['jev','conversation_manual','--conversation',id,'--request',JSON.stringify(draft.data.command)],f.homes)).toBe(0);await f.app.conversations.wait(id);expect(f.fake.starts).toHaveLength(2);
});
import {conversationReadingFixture} from './helpers/conversation-reading-fixture.js';

test('CLI conversation reading view shares live fixture activity and recorded step metadata',async()=>{
 const made=await conversationReadingFixture(true);f=made.f;const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 expect(await callCommand(['jev','conversation_read_view','--conversation',made.id,'--request',JSON.stringify({schema:'conversation-reading-request-v1',kind:'activity'})],f.homes)).toBe(0);const activity=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(activity).toMatchObject({ok:true,data:{schema:'conversation-reading-view-v1',kind:'activity',description:'Using Read fixture…'}});await made.finish();output.mockClear();const count=f.app.conversations.ledger(made.id).events().length;expect(await callCommand(['jev','conversation_read_view','--conversation',made.id,'--request',JSON.stringify({schema:'conversation-reading-request-v1',kind:'step',step:1})],f.homes)).toBe(0);const step=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(step).toMatchObject({ok:true,data:{kind:'step',actionable:true,editable:true,recordedAnswer:{fallback:'The fixture result is saved.'},transcript:{showFallback:false}}});expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});

test('CLI conversation result metadata shares recorded content and exact detail labels without work',async()=>{
 const made=await conversationReadingFixture(true);f=made.f;const view=await made.finish(),pointer=view.handoffs[0]!.result!.ref,count=f.app.conversations.ledger(made.id).events().length,output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 const request={schema:'conversation-reading-request-v1',kind:'result',pointer,displayKind:'answer',fallback:view.handoffs[0]!.summary};expect(await callCommand(['jev','conversation_read_view','--conversation',made.id,'--request',JSON.stringify(request)],f.homes)).toBe(0);const result=JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]));expect(result).toMatchObject({ok:true,data:{kind:'result',pointer,presentation:{kind:'answer',source:'content',text:'# Recorded reading result\n\nThe fixture result is saved.'}}});
 output.mockClear();expect(await callCommand(['jev','conversation_read_view','--conversation',made.id,'--request',JSON.stringify({schema:'conversation-reading-request-v1',kind:'step',step:1})],f.homes)).toBe(0);expect(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]))).toMatchObject({ok:true,data:{kind:'step',details:{schema:'conversation-step-details-v1',effortLabel:'high'}}});expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});

test('CLI conversation stream source preserves canonical cursor and refresh policy without work',async()=>{
 const made=await conversationReadingFixture(true);f=made.f;await made.finish();const ledger=f.app.conversations.ledger(made.id),count=ledger.events().length,output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const request={schema:'conversation-stream-request-v1',afterId:0,limit:2};
 expect(await callCommand(['jev','conversation_stream','--conversation',made.id,'--request',JSON.stringify(request)],f.homes)).toBe(0);const value=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(value).toMatchObject({ok:true,data:{schema:'conversation-stream-source-v1',request,head:ledger.lastId(),nextAfterId:2,hasMore:true,policy:{schema:'conversation-stream-policy-v1',refreshWindowMs:40},events:ledger.events(0,2).map(event=>({id:event.id}))}});expect(ledger.events()).toHaveLength(count);expect(f.fake.starts).toHaveLength(1);
});
import {taskInteractionFixture} from './helpers/task-interaction-fixture.js';

test('CLI task interaction edits use captured revisions and shared queue controls',async()=>{
 const made=await taskInteractionFixture(true);f=made.f;const id=made.queued.id,starts=f.fake.runs.length,output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 const take=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(await callCommand(['work','queue_view'],f.homes)).toBe(0);expect(take()).toMatchObject({ok:true,data:{schema:'project-task-queue-interaction-v1',projectId:'project',order:[made.proposed.id,id]}});
 output.mockClear();expect(await callCommand(['work','task_edit_view','--task',id],f.homes)).toBe(0);const editor=take();expect(editor.ok).toBe(true);if(!editor.ok)throw new Error('Task edit view refused.');const view=editor.data as{context:unknown;defaults:Record<string,unknown>};
 output.mockClear();expect(await callCommand(['work','task_draft','--task',id,'--request',JSON.stringify({schema:'project-task-intent-v1',context:view.context,intent:{kind:'edit',fields:{...view.defaults,title:'CLI shared task edit'}}})],f.homes)).toBe(0);const draft=take();expect(draft.ok).toBe(true);if(!draft.ok)throw new Error('Task draft refused.');const command=(draft.data as{command:unknown}).command;
 output.mockClear();expect(await callCommand(['work','task_command','--task',id,'--request',JSON.stringify(command)],f.homes)).toBe(0);expect(take()).toMatchObject({ok:true,data:{schema:'task-view-v1',task:{title:'CLI shared task edit',revision:made.queued.revision+1}}});expect((await f.request(`/api/projects/project/tasks/${id}/command`,'POST',command)).status).toBe(409);expect(f.fake.runs.length).toBe(starts);
});

test('CLI task page reads the canonical task navigation and polling policy without work',async()=>{
 const made=await taskInteractionFixture(true);f=made.f;const before=await made.work.tasks.read('project',made.queued.id),starts=f.fake.runs.length,output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 expect(await callCommand(['work','task_page_view','--task',made.queued.id],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{schema:'project-task-page-view-v1',projectId:'project',taskId:made.queued.id,task:before,meta:'feature · queued',policy:{schema:'project-task-page-policy-v1',pollHintMs:30000},back:{label:'Back to project',href:'/projects/project'},threadLink:null,pullRequest:null}});expect(await made.work.tasks.read('project',made.queued.id)).toEqual(before);expect(f.fake.runs.length).toBe(starts);
});
import {projectChatFixture} from './helpers/project-chat-fixture.js';

test('CLI project chat reads canonical recorded headings cards and delivery without work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const before=made.ledger.events(),starts=f.fake.runs.length,output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['work','chat_view'],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{schema:'project-chat-view-v1',projectId:'project',deviceId:f.app.device.deviceId,streamPolicy:{schema:'project-stream-policy-v1',initialRetryMs:5000,maximumRetryMs:60000,retryMultiplier:2},items:expect.arrayContaining([expect.objectContaining({kind:'owner',heading:'You, via CLI',delivered:true}),expect.objectContaining({kind:'reply',text:'Two recorded fixture tasks.'})])}});expect(made.ledger.events()).toEqual(before);expect(f.fake.runs.length).toBe(starts);
});
import {projectChatCardsFixture} from './helpers/project-chat-cards-fixture.js';

test('CLI chat card model shares captured task commands without starting work',async()=>{
 const made=await projectChatCardsFixture(true);f=made.f;const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['work','chat_card_view','--request',JSON.stringify({schema:'project-chat-card-view-request-v1',itemId:made.routed.id})],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{schema:'project-chat-card-view-v1',projectId:'project',deviceId:f.app.device.deviceId,view:{itemId:made.routed.id,batch:{label:'Start all (4)',taskIds:made.tasks.map(row=>row.id)}}}});expect(result.ok).toBe(true);if(!result.ok)throw new Error('Canonical chat cards refused.');const command=(result.data as{view:{rows:Array<{start:unknown}>}}).view.rows[0]!.start;output.mockClear();expect(await callCommand(['work','task_command','--task',made.tasks[0]!.id,'--request',JSON.stringify(command)],f.homes)).toBe(0);expect((await made.work.tasks.read('project',made.tasks[0]!.id)).state).toBe('queued');expect(f.fake.runs.length).toBe(0);
});

test('CLI coordinator composer and typed message command share canonical retry identity without work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['work','coordinator_composer'],f.homes)).toBe(0);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(read()).toMatchObject({ok:true,data:{schema:'project-coordinator-composer-v1',projectId:'project',canSend:true,requestPolicy:{retryIdentity:'payload-until-success',cancelled:'ignore',unauthorized:'global',other:'local'}}});
 const request={schema:'project-coordinator-command-v1',projectId:'project',operation:'message',body:{schema:'coordinator-message-request-v1',clientMessageId:'message_cli_fixture',text:'CLI fixture payload.  '}};for(const repeated of[false,true]){output.mockClear();expect(await callCommand(['work','coordinator_command','--request',JSON.stringify(request)],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{schema:'coordinator-message-receipt-v1',repeated}});}expect(f.fake.runs.length).toBe(0);
});

test('CLI notebook editor and captured command share canonical revision checks without provider work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['work','notebook_view'],f.homes)).toBe(0);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(read()).toMatchObject({ok:true,data:{schema:'project-notebook-editor-v1',projectId:'project',revision:0,content:'',policy:{contentMax:65536,readWhileEditing:false}}});output.mockClear();const request={schema:'project-notebook-command-v1',projectId:'project',body:{schema:'notebook-request-v1',expectedRevision:0,content:'CLI fixture notebook.\n'}};expect(await callCommand(['work','notebook_command','--request',JSON.stringify(request)],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{revision:1,content:'CLI fixture notebook.\n',updatedBy:'owner'}});expect(f.fake.runs.length).toBe(0);
});

test('CLI attachment preparation shares typed canonical library facts without posting a message',async()=>{
 const {Readable}=await import('node:stream');f=await projectFixture({control:true});const item=await f.app.library.upload('project',{name:'fixture.txt',mime:'text/plain',size:5,source:'owner'},Readable.from(['hello'])),output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['work','attachment_policy'],f.homes)).toBe(0);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(read()).toMatchObject({ok:true,data:{projectId:'project',policy:{maximumFiles:10,maximumFileBytes:52428800}}});output.mockClear();expect(await callCommand(['work','attachment_message','--request',JSON.stringify({schema:'project-attachment-request-v1',text:'A fixture request.',itemIds:[item.id]})],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{schema:'project-attachment-message-v1',projectId:'project',text:`A fixture request.\n\nAttached file: library/${item.path} (text/plain, 5 B)`,attachments:[{id:item.id,size:5,kind:'file'}]}});expect(f.fake.runs.length).toBe(0);
});

test('CLI library view shares job source filters and canonical origin metadata without work',async()=>{
 const {Readable}=await import('node:stream');f=await projectFixture({control:true});const item=await f.app.library.upload('project',{name:'job.txt',mime:'text/plain',size:5,source:'job',jobRunId:'job_run_fixture',artifactId:'artifact_fixture'},Readable.from(['hello'])),output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(await callCommand(['work','library_view','--request',JSON.stringify({schema:'project-library-view-request-v1',source:'job'})],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{schema:'project-library-view-v1',projectId:'project',source:'job',policy:{cacheMs:2000,pollMs:15000},rows:[{item:{id:item.id,source:'job'},originLabel:'From a job'}]}});expect(result.ok).toBe(true);if(!result.ok)throw new Error('Library view refused.');const command=(result.data as{rows:Array<{deleteCommand:unknown}>}).rows[0]!.deleteCommand;expect(command).toBeDefined();output.mockClear();expect(await callCommand(['work','library_delete','--request',JSON.stringify(command)],f.homes)).toBe(0);expect(await f.app.library.list('project')).toEqual([]);expect(f.fake.runs.length).toBe(0);
});

test('CLI recorded library message view resolves canonical text without posting work',async()=>{
 const made=await projectChatFixture(true);f=made.f;const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const before=f.ledgerText(),request={schema:'project-library-message-request-v1',kind:'coordinator',itemId:made.owner.id,deviceId:f.app.device.deviceId};expect(await callCommand(['work','library_message_view','--request',JSON.stringify(request)],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{schema:'project-library-message-view-v1',projectId:'project',text:'A recorded fixture request.',attachments:[],imageScope:'project'}});expect(f.ledgerText()).toBe(before);expect(f.fake.runs.length).toBe(0);
});

test('CLI thread read state exposes canonical ready context without steering work',async()=>{
 f=await projectFixture({control:true});f.fake.enqueueTurn(reportStep({status:'progress',summary:'Recorded CLI read-state fixture.'}),forThread());const made=await f.json('/api/projects/project/threads',ThreadCreatedViewSchema,'POST',{schema:'thread-create-request-v1',clientRequestId:'cli_thread_read_state',title:'Read-state fixture',task:'Inspect the simulated state.'});await f.waitFor(()=>f!.thread(made.threadId),row=>row.state==='idle');const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const request={schema:'project-thread-read-request-v1',projectId:'project',threadId:made.threadId};expect(await callCommand(['thread','read_view','--request',JSON.stringify(request)],f.homes)).toBe(0);const result=OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(result).toMatchObject({ok:true,data:{schema:'project-thread-read-view-v1',kind:'ready',projectId:'project',threadId:made.threadId,nextRequest:{viewKnown:true},view:{readHint:{pollHintMs:10000}}}});expect(f.fake.turnStarts).toHaveLength(1);
});

test('CLI terminal launcher create and list share canonical defaults and owned session receipts',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));
 expect(await callCommand(['jev','terminal_launcher_view','--request',JSON.stringify({schema:'terminal-launcher-view-request-v1',projectId:'project'})],f.homes)).toBe(0);const result=read();expect(result.ok).toBe(true);if(!result.ok)throw new Error('CLI launcher refused.');const view=core.TerminalLauncherViewSchema.parse(result.data),command=core.terminalLaunchAttempt(null,view,core.terminalLauncherSelection(view),'terminal_cli_fixture').command;output.mockClear();expect(await callCommand(['jev','terminal_create','--request',JSON.stringify(command)],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{schema:'terminal-open-result-v1',session:{cwd:f.checkout,deviceId:f.app.device.deviceId}}});expect(JSON.stringify(read())).not.toContain('ticket');output.mockClear();expect(await callCommand(['jev','terminal_list_view','--request',JSON.stringify({schema:'terminal-list-request-v1',projectId:'project'})],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{kind:'ready',list:{sessions:[{cwd:f.checkout}]},policy:{pollMs:5000}}});expect(f.app.terminals.manager.list()).toHaveLength(1);expect(f.fake.runs).toHaveLength(0);
});

test('CLI terminal stream read and policy share canonical closed resource metadata without tickets',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(await callCommand(['jev','terminal_stream_policy'],f.homes)).toBe(0);const policy=read();expect(policy).toMatchObject({ok:true,data:{schema:'terminal-stream-policy-v1',initialRetryMs:500,heartbeatMs:15000}});const made=await f.json('/api/terminals',core.TerminalTicketSchema,'POST',{schema:'terminal-create-request-v1',clientRequestId:'terminal_stream_cli_fixture',deviceId:f.app.device.deviceId,cwd:'home',takeover:false});await f.request('/api/terminals/'+made.session.id+'/close','POST',{schema:'empty-request-v1'});output.mockClear();expect(await callCommand(['jev','terminal_read_view','--request',JSON.stringify({schema:'terminal-read-request-v1',sessionId:made.session.id})],f.homes)).toBe(0);const result=read();expect(result).toMatchObject({ok:true,data:{schema:'terminal-read-view-v1',snapshot:{session:{id:made.session.id,status:'closed'}},initial:{terminalClosed:true,connected:false},policy:policy.ok?policy.data:null}});expect(JSON.stringify(result)).not.toContain('ticket');expect(f.fake.runs).toHaveLength(0);
});

test('CLI terminal actions copy plans preview and close share canonical resource guards',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),made=await f.json('/api/terminals',core.TerminalTicketSchema,'POST',{schema:'terminal-create-request-v1',clientRequestId:'terminal_action_cli_fixture',projectId:'project',cwd:'checkout',takeover:false}),id=made.session.id,output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0]))),call=async(action:string,request:unknown)=>{output.mockClear();expect(await callCommand(['jev',action,'--request',JSON.stringify(request)],f!.homes)).toBe(0);return read();};expect(await call('terminal_actions_view',{schema:'terminal-read-request-v1',sessionId:id})).toMatchObject({ok:true,data:{sessionId:id,canSend:true,targets:[{value:'coordinator'}]}});expect(await call('terminal_copy_plan',{schema:'terminal-copy-request-v1',sessionId:id,kind:'all'})).toMatchObject({ok:true,data:{source:'buffer',last:null}});expect(await call('terminal_copy_view',{schema:'terminal-copy-request-v1',sessionId:id,kind:'last'})).toMatchObject({ok:true,data:{source:'snapshot',request:{sessionId:id,kind:'last'}}});expect(await call('terminal_run_plan',{schema:'terminal-run-request-v1',sessionId:id,text:'printf preview-only',transportOpen:true})).toMatchObject({ok:true,data:{allowed:true,frame:{type:'input'}}});expect(f.app.terminals.manager.snapshot(id).commands.some(row=>row.command.includes('preview-only'))).toBe(false);expect(await call('terminal_action',core.terminalCloseCommand(id))).toMatchObject({ok:true,data:{operation:'close',sessionId:id,ack:{ok:true}}});expect(f.app.terminals.manager.session(id).status).toBe('closed');expect(f.fake.runs).toHaveLength(0);
});

test('CLI health editor previews raw drafts and reads canonical health history without work',async()=>{
 f=await projectFixture({control:true});const core=await import('../packages/core/dist/index.js'),output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(await callCommand(['config','health_editor'],f.homes)).toBe(0);const result=read();expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected health editor.');const model=core.HealthEditorSchema.parse(result.data),next=core.healthEditorEdit(model,{schema:'health-editor-command-v1',operation:'add-check'});output.mockClear();expect(await callCommand(['config','health_preview','--request',JSON.stringify({schema:'health-editor-preview-v1',projectId:'project',fields:next.fields})],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{fields:next.fields,patch:null,apply:{enabled:false}}});output.mockClear();expect(await callCommand(['jobs','health_view'],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{schema:'health-history-view-v1',projectId:'project',runs:[]}});expect(f.fake.runs).toHaveLength(0);
});

test('CLI settings setup action shares engine metadata and the canonical guarded preset writer',async()=>{
 f=await projectFixture({control:true,menu:[{id:'discovered_opus',runtime:'claude',model:'reported-native-model',label:'Claude Opus 5.5',description:'Synthetic discovery',efforts:['high'],enabled:true}]});const core=await import('../packages/core/dist/index.js'),projects=await import('../packages/projects/dist/index.js'),project=(await f.app.state.projects.get('project'))!;await f.app.state.projects.put(core.ProjectSchema.parse({...project.project,name:'Ekoa Code',remoteUrl:'https://github.com/gongiskhan/ekoa-code.git',githubTokenScope:'project',allowedDevices:[f.app.device.deviceId],testCommand:projects.EKOA_FAST_CHECKS}),project.revision);const output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(await callCommand(['config','settings_editor'],f.homes)).toBe(0);const result=read();expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected setup metadata.');const view=core.ProjectSettingsEditorSchema.parse(result.data),command=core.projectSettingsSetupAction(view.specialSetup,'project','discovered_opus');expect(command?.enabled).toBe(true);output.mockClear();expect(await callCommand(['config','project_setup','--request',JSON.stringify(command!.body)],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{schema:'ekoa-code-setup-receipt-v1',projectId:'project',completed:true,presetVersion:3}});expect(f.fake.runs).toHaveLength(0);
});

test('CLI first run reads and next navigation work before a project exists without starting work',async()=>{
 f=await projectFixture({control:true});vi.spyOn(f.app.state.projects,'list').mockResolvedValue([]);const core=await import('../packages/core/dist/index.js'),output=vi.spyOn(console,'log').mockImplementation(()=>undefined);vi.spyOn(console,'error').mockImplementation(()=>undefined);const read=()=>OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row=>String(row[0]).startsWith('{'))?.[0])));expect(await callCommand(['config','setup_progress','--request',JSON.stringify({schema:'first-run-read-request-v1',step:'project'})],f.homes)).toBe(0);const result=read();expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected first-run view.');expect(core.FirstRunViewSchema.parse(result.data)).toMatchObject({deviceId:f.app.device.deviceId,projectOnDevice:false,current:{id:'project'}});output.mockClear();expect(await callCommand(['config','setup_next','--request',JSON.stringify({schema:'first-run-next-request-v1',step:'project'})],f.homes)).toBe(0);expect(read()).toMatchObject({ok:true,data:{schema:'first-run-navigation-v1',allowed:false,path:null,refusal:'Add a project on this device before continuing.'}});expect(f.fake.runs).toHaveLength(0);
});
