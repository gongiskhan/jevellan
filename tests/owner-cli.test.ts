import { afterEach, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlugin, callCommand, hookCommand, pluginCommand, statuslineCommand } from '../packages/cli/dist/owner-commands.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { reportStep, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { ThreadCreatedViewSchema, OwnerToolResultSchema, ProjectGoalEditorSchema, ProjectJobEditorSchema } from '../packages/core/dist/index.js';

let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
const claudeAvailable = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;

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
