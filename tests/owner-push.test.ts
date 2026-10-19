import { afterEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OwnerPushes } from '../apps/daemon/dist/owner-pushes.js';
import { OwnerBridges } from '../apps/daemon/dist/owner-bridge.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close().catch(() => undefined); client = undefined; await f?.close(); f = undefined; });
const quietAll = async (enabled: boolean) => {
  const view = await f!.app.projectWork.settingsView('project');
  await f!.app.projectWork.putSettings('project', { schema: 'project-work-settings-request-v1', revision: view.settings.revision,
    settings: { ...view.settings, notifications: { level: 'standard', quietHours: { enabled, start: '00:00', end: '00:00', timezone: 'Europe/Lisbon' } } } } as never);
};

test('a waiting item reaches the bridge as a channel push, is acked, and comes back after a reconnect only while unacked', async () => {
  f = await projectFixture({ control: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'bin', 'jevellan.mjs'), 'mcp'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JEVELLAN_HOME: f.homes.root, JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: f.project.name }, stderr: 'ignore' });
  const received: Array<{ content: string; meta: Record<string, string> }> = [];
  client = new Client({ name: 'bridge-test', version: '1.0.0' });
  client.fallbackNotificationHandler = async (notification) => { if (notification.method === 'notifications/claude/channel') received.push(notification.params as never); };
  await client.connect(transport);
  await f.app.projectWork.decisions.ask('project', { question: 'Which fixture should the tests use?', options: [{ label: 'Existing' }, { label: 'New' }] }, 'coordinator');
  await f.app.ownerPushes.sweep();
  await f.waitFor(() => received.length >= 1);
  expect(received[0]).toEqual({ content: '[Jevellan] W1 waiting on you: Which fixture should the tests use? Options: Existing, New', meta: { kind: 'waiting_created', id: 'W1' } });
  await f.waitFor(() => f!.app.ownerPushes.messages('project').length === 0);
  await f.app.ownerPushes.sweep();
  expect(f.app.ownerPushes.messages('project')).toEqual([]);
});

test('quiet hours hold ordinary pushes and send one summary when they end; urgent ones go at once; bursts batch', async () => {
  f = await projectFixture({ control: true });
  let now = Date.now(); const pushes = new OwnerPushes(f.app, () => now);
  await quietAll(true);
  pushes.add({ projectId: 'project', kind: 'waiting_created', key: 'a', text: 'W1 waiting on you: one. Options: yes, no' });
  now += 1000; pushes.add({ projectId: 'project', kind: 'job_failed', key: 'b', text: 'Full suite failed (J2): 3 failed.' });
  pushes.add({ projectId: 'project', kind: 'deploy', key: 'c', text: 'Deploy aaaaaaa broke the app check and was rolled back to bbbbbbb at 14:10.', urgent: true });
  expect(pushes.messages('project').map(message => message.text)).toEqual(['[Jevellan] Deploy aaaaaaa broke the app check and was rolled back to bbbbbbb at 14:10.']);
  pushes.ack('project', pushes.messages('project')[0]!.pushIds);
  await quietAll(false); now += 60_000;
  expect(pushes.messages('project').map(message => message.text)).toEqual(['[Jevellan] 2 updates while you were away:\nW1 waiting on you: one. Options: yes, no\nFull suite failed (J2): 3 failed.']);
  pushes.ack('project', pushes.messages('project')[0]!.pushIds);
  for (const key of ['d', 'e', 'f', 'g']) { now += 1000; pushes.add({ projectId: 'project', kind: 'waiting_created', key, text: `W ${key}` }); }
  expect(pushes.messages('project')).toMatchObject([{ kind: 'batch', text: '[Jevellan] 4 updates:\nW d\nW e\nW f\nW g' }]);
  f.app.ownerTools.updateProjectSettings('project', settings => ({ ...settings, push: { ...settings.push, kinds: { job_failed: false } } }));
  expect(pushes.add({ projectId: 'project', kind: 'job_failed', key: 'h', text: 'off' })).toBeNull();
});

test('the bridge starts in tmux with the specified flags, refuses an account without an interactive login, and comes back when its session is gone', async () => {
  f = await projectFixture({ control: true });
  const calls: string[][] = []; let alive = false;
  const tmux = (args: string[]) => { calls.push(args);
    if (args[0] === 'new-session') { alive = true; return { status: 0, stdout: '' }; }
    if (args[0] === 'has-session') return { status: alive ? 0 : 1, stdout: '' };
    if (args[0] === 'list-panes') return { status: 0, stdout: alive ? 'claude\n' : '' };
    if (args[0] === 'capture-pane') return { status: 0, stdout: calls.filter(row => row[0] === 'capture-pane').length < 2 ? 'I am using this for local development' : 'Claude Code v2\n❯ ' };
    return { status: 0, stdout: '' }; };
  const bridges = new OwnerBridges(f.app, tmux, '/usr/bin/claude');
  const project = (await f.app.ownerTools.projects())[0]!;
  const config = join(f.root, 'bridge-account'); mkdirSync(config, { recursive: true });
  await expect(bridges.startBridge(project, { claudeConfigDir: config })).rejects.toThrow('has no interactive Claude login, which remote control needs.');
  writeFileSync(join(config, '.credentials.json'), '{}');
  const text = await bridges.startBridge(project, { claudeConfigDir: config });
  expect(text).toMatch(new RegExp(`^Started the bridge for ${project.name} in tmux jv-bridge-`, 'u'));
  expect(calls.some(row => row[0] === 'send-keys' && row.includes('Enter'))).toBe(true);
  const start = readFileSync(join(f.homes.root, 'bridges', bridges.sessionName(project).slice('jv-bridge-'.length), 'start.sh'), 'utf8');
  expect(start).toContain(`export JEVELLAN_BRIDGE='1'`); expect(start).toContain(`export JEVELLAN_PROJECT='${project.name}'`); expect(start).toContain('unset CLAUDE_CODE_OAUTH_TOKEN');
  for (const flag of [`'--model' 'sonnet' '--effort' 'medium' '--remote-control' 'Jevellan · ${project.name}'`, `'--dangerously-load-development-channels' 'plugin:jevellan@inline'`, `'--allowedTools' 'mcp__plugin_jevellan_jevellan__*' '--disallowedTools' 'Bash' 'Edit' 'Write' 'NotebookEdit'`, "'--append-system-prompt-file'"]) expect(start).toContain(flag);
  expect(start).not.toContain('--continue');
  expect(await bridges.startBridge(project)).toBe(`The bridge for ${project.name} is already running (tmux ${bridges.sessionName(project)}).`);
  const prompt = readFileSync(join(f.homes.root, 'bridges', bridges.sessionName(project).slice('jv-bridge-'.length), 'system-prompt.md'), 'utf8');
  expect(prompt.startsWith(`You are the Jevellan bridge for the project ${project.name}.`)).toBe(true);
  alive = false; const sessions = join(config, 'projects', join(f.homes.root, 'bridges', bridges.sessionName(project).slice('jv-bridge-'.length)).replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(sessions, { recursive: true }); writeFileSync(join(sessions, 'one.jsonl'), '{}\n');
  await bridges.check();
  expect(alive).toBe(true);
  expect(readFileSync(join(f.homes.root, 'bridges', bridges.sessionName(project).slice('jv-bridge-'.length), 'start.sh'), 'utf8')).toContain("'--continue'");
  expect(existsSync(join(f.homes.root, 'plugin-dist', 'claude', 'jevellan', '.mcp.json'))).toBe(true);
});
