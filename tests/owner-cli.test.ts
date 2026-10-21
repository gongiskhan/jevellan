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
