import { afterEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

test('a budget push names the window that reached the budget, and a reading from before its window reset pushes nothing', async () => {
  f = await projectFixture({ control: true });
  let clock = Date.now(); const pushes = new OwnerPushes(f.app, () => clock);
  const budget = () => pushes.messages('project').map(message => message.text).filter(text => text.includes('budget'));
  const at = (ms: number) => new Date(clock + ms).toISOString();
  await f.app.accounts.recordUsage('acc_fixture', { source: 'probe', observedAt: at(-60_000), fiveHourPct: 95, weeklyPct: 1, fiveHourResetsAt: at(-30_000), weeklyResetsAt: at(5 * 86_400_000) });
  await pushes.sweep(); expect(budget()).toEqual([]);
  await f.app.accounts.recordUsage('acc_fixture', { source: 'probe', observedAt: at(0), fiveHourPct: 95, weeklyPct: 1, fiveHourResetsAt: at(3_600_000), weeklyResetsAt: at(5 * 86_400_000) });
  clock += 31_000; await pushes.sweep();
  expect(budget()).toEqual([expect.stringMatching(/^\[Jevellan\] Account Fixture reached its 90% budget in its five-hour window \(95%; weekly 1%\)\. New work waits for another eligible account or until \d{2}:\d{2}\.$/u)]);
});

test('a coordinator that runs again after a stop reaches the bridge as a recovery push', async () => {
  f = await projectFixture({ control: true }); const ledger = f.app.projectWork.ledgers.coordinator('project');
  for (const [turn, status] of [[1, 'failed'], [2, 'failed'], [3, 'completed']] as const) ledger.append({ type: 'coordinator-turn-end', turn, data: { schema: 'coordinator-turn-end-v1', turn, status, ...(status === 'failed' ? { error: 'Provider unavailable.' } : {}) } });
  await f.app.projectWork.notifications.flush(); await f.app.ownerPushes.sweep();
  expect(f.app.ownerPushes.messages('project').map(message => [message.kind, message.text])).toEqual(expect.arrayContaining([
    ['coordinator_crashed', `[Jevellan] ${f.project.name}: The coordinator stopped: Provider unavailable.`], ['coordinator_recovered', `[Jevellan] ${f.project.name}: The coordinator is running again.`]]));
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
    // The trust dialog is answered on its second capture and stays on screen for three more, then the channel confirmation shows under it.
    if (args[0] === 'capture-pane') { const n = calls.filter(row => row[0] === 'capture-pane').length;
      return { status: 0, stdout: n <= 5 ? '❯ No, exit\n  Yes, I trust this folder' : n <= 7 ? 'Yes, I trust this folder\n❯ 1. I am using this for local development\n  2. Exit' : `⏺ An earlier reply, replayed by --continue; the version header has scrolled away.\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  /remote-control is active` }; }
    return { status: 0, stdout: '' }; };
  const bridges = new OwnerBridges(f.app, tmux, '/usr/bin/claude');
  const project = (await f.app.ownerTools.projects())[0]!;
  const config = join(f.root, 'bridge-account'); mkdirSync(config, { recursive: true });
  await expect(bridges.startBridge(project, { claudeConfigDir: config })).rejects.toThrow('has no interactive Claude login, which remote control needs.');
  writeFileSync(join(config, '.credentials.json'), '{}');
  const text = await bridges.startBridge(project, { claudeConfigDir: config });
  expect(text).toMatch(new RegExp(`^Started the bridge for ${project.name} in tmux jv-bridge-`, 'u'));
  expect(calls.filter(row => row[0] === 'send-keys').map(row => row.at(-1))).toEqual(['Down', 'Enter', 'Enter']);
  // Pushes wait until three seconds after the prompt showed: Claude drops a channel message sent while it starts.
  expect(bridges.accepting(project.id)).toBe(false); expect(bridges.accepting(project.id, Date.now() + 3000)).toBe(true);
  const start = readFileSync(join(f.homes.root, 'bridges', bridges.sessionName(project).slice('jv-bridge-'.length), 'start.sh'), 'utf8');
  const trusted = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
  expect(trusted.projects[realpathSync(join(f.homes.root, 'bridges', bridges.sessionName(project).slice('jv-bridge-'.length)))]?.hasTrustDialogAccepted).toBe(true);
  expect(start).toContain(`export JEVELLAN_BRIDGE='1'`); expect(start).toContain(`export JEVELLAN_PROJECT='${project.name}'`); expect(start).toContain('unset CLAUDE_CODE_OAUTH_TOKEN'); expect(start).toContain("export ENABLE_CLAUDEAI_MCP_SERVERS='false'");
  // The account folder's advisor stays out of the bridge.
  for (const flag of [`'--model' 'sonnet' '--effort' 'medium' '--settings' '{"advisorModel":""}' '--remote-control' 'Jevellan · ${project.name}'`, `'--dangerously-load-development-channels' 'plugin:jevellan@inline'`, `'--allowedTools' 'mcp__plugin_jevellan_jevellan__*' '--disallowedTools' 'Bash' 'Edit' 'Write' 'NotebookEdit'`, "'--append-system-prompt-file'"]) expect(start).toContain(flag);
  expect(start).not.toContain('--continue');
  // The login shell tmux starts can reorder PATH; the script restores the service's PATH and runs claude by its full path.
  expect(start).toContain(`export PATH='${process.env.PATH}'`); expect(start).toContain("exec '/usr/bin/claude' ");
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

test('a bridge in an account folder that never ran Claude Code starts with onboarding done, and one held at a start-up screen says so instead of started', async () => {
  f = await projectFixture({ control: true });
  // Claude Code's theme picker: its header and selection marker look like a ready prompt.
  const picker = 'Welcome to Claude Code v2.1.305\n Let\'s get started.\n Choose the text style that looks best with your terminal\n ❯ 1. Dark mode ✔\n   2. Light mode';
  let alive = false; const tmux = (args: string[]) => {
    if (args[0] === 'new-session') { alive = true; return { status: 0, stdout: '' }; }
    if (args[0] === 'has-session') return { status: alive ? 0 : 1, stdout: '' };
    if (args[0] === 'list-panes') return { status: 0, stdout: alive ? 'claude\n' : '' };
    if (args[0] === 'capture-pane') return { status: 0, stdout: picker };
    return { status: 0, stdout: '' }; };
  const bridges = new OwnerBridges(f.app, tmux, '/usr/bin/claude', 3000);
  const project = (await f.app.ownerTools.projects())[0]!;
  const config = join(f.root, 'new-account'); mkdirSync(config, { recursive: true }); writeFileSync(join(config, '.credentials.json'), '{}');
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ userID: 'fixture', projects: { '/elsewhere': { hasTrustDialogAccepted: false } } }));
  const text = await bridges.startBridge(project, { claudeConfigDir: config });
  expect(text).toBe(`The bridge for ${project.name} is held at a Claude Code start-up screen: "Choose the text style that looks best with your terminal". Answer it in tmux attach -t ${bridges.sessionName(project)}, then it registers with the Claude app.`);
  const preferences = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')) as { userID: string; hasCompletedOnboarding?: boolean; projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
  expect(preferences).toMatchObject({ userID: 'fixture', hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 100, projects: { '/elsewhere': { hasTrustDialogAccepted: false } } });
  expect(preferences.projects[realpathSync(join(f.homes.root, 'bridges', bridges.sessionName(project).slice('jv-bridge-'.length)))]?.hasTrustDialogAccepted).toBe(true);
});

test('a push acked by a bridge that was shutting down is sent again when the bridge starts again, unless its transcript has it', async () => {
  f = await projectFixture({ control: true });
  const pushes = new OwnerPushes(f.app); const since = Date.now();
  pushes.add({ projectId: 'project', kind: 'waiting_created', key: 'seen', text: 'W1 waiting on you: seen "quoted"?' });
  pushes.add({ projectId: 'project', kind: 'waiting_created', key: 'lost', text: 'W2 waiting on you: lost?' });
  for (const message of pushes.messages('project')) pushes.ack('project', message.pushIds);
  expect(pushes.messages('project')).toEqual([]);
  const transcript = `{"type":"user","message":{"content":${JSON.stringify('<channel source="plugin:jevellan:jevellan">\n[Jevellan] W1 waiting on you: seen "quoted"?\n</channel>')}}}`;
  expect(pushes.requeueUndelivered('project', since + 60_000, transcript)).toBe(0);
  expect(pushes.requeueUndelivered('project', since, transcript)).toBe(1);
  expect(pushes.messages('project').map(message => message.text)).toEqual(['[Jevellan] W2 waiting on you: lost?']);
});
