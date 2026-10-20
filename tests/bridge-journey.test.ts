// Journey B (bridge specification, phase 4), real: a test bridge for a fixture project in tmux, a real Claude Code session (Sonnet,
// medium effort) under remote control named as a test session, and the engine on the simulated runtime. Opt-in: JEVELLAN_BRIDGE_JOURNEY=1
// and a logged-in Claude folder with an interactive login in JEVELLAN_BRIDGE_EVAL_CLAUDE_DIR.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { ProjectNotificationSchema } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

const enabled = process.env.JEVELLAN_BRIDGE_JOURNEY === '1' && !!process.env.JEVELLAN_BRIDGE_EVAL_CLAUDE_DIR;
let f: ProjectFixture | undefined; let session = '';
const pane = () => spawnSync('tmux', ['capture-pane', '-p', '-J', '-S', '-400', '-t', `=${session}`], { encoding: 'utf8' }).stdout;
const type = (text: string) => { spawnSync('tmux', ['send-keys', '-t', `=${session}`, '-l', text]); spawnSync('tmux', ['send-keys', '-t', `=${session}`, 'Enter']); };
async function until(check: () => boolean, ms = 180_000): Promise<void> { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2000)); } throw new Error(`Timed out. Pane:\n${pane().slice(-3000)}`); }
const bridgeWrites = () => f!.app.ownerTools.callerLog().filter(row => row.caller.startsWith('bridge:') && row.access === 'write');

beforeAll(async () => {
  if (!enabled) return;
  process.env.JEVELLAN_BRIDGE_REMOTE_NAME = 'jevellan-test · bridge journey';
  f = await projectFixture({ control: true });
  f.app.ownerPushes.start();
  const project = (await f.app.ownerTools.projects())[0]!;
  session = f.app.ownerBridges.sessionName(project);
  const started = await f.app.ownerBridges.startBridge(project, { claudeConfigDir: process.env.JEVELLAN_BRIDGE_EVAL_CLAUDE_DIR!, remoteName: 'jevellan-test · bridge journey' });
  expect(started).toMatch(/^Started the bridge for /u);
  await until(() => /Jevellan bridge|❯/u.test(pane()), 120_000);
}, 300_000);
afterAll(async () => {
  if (session) { spawnSync('tmux', ['send-keys', '-t', `=${session}`, '/exit', 'Enter']); await new Promise(resolve => setTimeout(resolve, 3000)); spawnSync('tmux', ['kill-session', '-t', `=${session}`]); }
  f?.app.ownerPushes.close(); await f?.close();
});

test.skipIf(!enabled)('Journey B: pushes reach the bridge, it reports without acting, answers what the owner says, and catches up after a restart', async () => {
  const engine = f!.app.projectWork;
  // 1. A waiting item is pushed and reported; no write tool is called for it.
  await engine.decisions.ask('project', { question: 'Which fixture should the parser tests use?', options: [{ label: 'Existing fixture' }, { label: 'New fixture' }] }, 'coordinator');
  await until(() => /W1 waiting on you: Which fixture should the parser tests use\?/u.test(pane()));
  await new Promise(resolve => setTimeout(resolve, 30_000));
  expect(bridgeWrites()).toEqual([]);
  // 2. The owner answers in plain words: respond picks the option.
  await engine.decisions.ask('project', { question: 'Deploy 1 landed thread(s) to production at a1b2c3d?', options: [{ label: 'Deploy a1b2c3d' }, { label: 'Not now' }] }, 'coordinator');
  await until(() => /W2 waiting on you: Deploy 1 landed/u.test(pane()));
  await new Promise(resolve => setTimeout(resolve, 15_000));
  type('deploy');
  await until(() => (f!.app.ownerTools.callerLog().some(row => row.tool === 'respond' && row.ok)));
  expect((await engine.view('project')).decisions.answered.find(row => row.question.startsWith('Deploy 1'))?.answer?.optionLabel).toBe('Deploy a1b2c3d');
  // 3. A coordinator outage is pushed with the existing copy.
  f!.app.hub.put('project-notifications', 'notify_crash', ProjectNotificationSchema, { schema: 'project-notification-v1', revision: 0, id: 'notify_crash', projectId: 'project', kind: 'coordinator-unavailable', title: 'Coordinator stopped', body: 'The coordinator crashed and restarted from its last handoff.', url: '/projects/project', tag: 'project:crash', createdAt: new Date().toISOString() }, 0);
  await until(() => /Coordinator stopped: The coordinator crashed/u.test(pane()));
  // 4. Quiet hours hold ordinary items; an urgent one goes at once; the held ones arrive as one summary when quiet hours end.
  const view = await engine.settingsView('project');
  await engine.putSettings('project', { schema: 'project-work-settings-request-v1', revision: view.settings.revision, settings: { ...view.settings, notifications: { level: 'standard', quietHours: { enabled: true, start: '00:00', end: '00:00', timezone: 'Europe/Lisbon' } } } } as never);
  await engine.decisions.ask('project', { question: 'Quiet question one?' }, 'coordinator');
  await engine.decisions.ask('project', { question: 'Quiet question two?' }, 'coordinator');
  await engine.decisions.ask('project', { question: 'Production is down. Roll back?', options: [{ label: 'Roll back' }, { label: 'Leave it' }], urgent: true }, 'coordinator');
  await until(() => /Production is down\. Roll back\?/u.test(pane()));
  expect(pane()).not.toMatch(/Quiet question one/u);
  const quiet = await engine.settingsView('project');
  await engine.putSettings('project', { schema: 'project-work-settings-request-v1', revision: quiet.settings.revision, settings: { ...quiet.settings, notifications: { level: 'standard', quietHours: { enabled: false, start: '23:00', end: '08:00', timezone: 'Europe/Lisbon' } } } } as never);
  await until(() => /2 updates while you were away/u.test(pane()));
  // 5. With the bridge stopped, two items wait; after a restart with --continue both arrive.
  spawnSync('tmux', ['kill-session', '-t', `=${session}`]);
  await engine.decisions.ask('project', { question: 'While you were gone, question A?' }, 'coordinator');
  await engine.decisions.ask('project', { question: 'While you were gone, question B?' }, 'coordinator');
  await new Promise(resolve => setTimeout(resolve, 5000));
  const project = (await f!.app.ownerTools.projects())[0]!;
  expect(await f!.app.ownerBridges.startBridge(project, { claudeConfigDir: process.env.JEVELLAN_BRIDGE_EVAL_CLAUDE_DIR!, remoteName: 'jevellan-test · bridge journey' })).toMatch(/^Started the bridge/u);
  await until(() => /question A\?/u.test(pane()) && /question B\?/u.test(pane()));
}, 1_200_000);
