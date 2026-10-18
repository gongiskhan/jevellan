import { afterEach, expect, test } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { coordinatorPrompt } from '../packages/projects/dist/coordinator.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
test('setup is a scoped coordinator tool with a versioned proposal schema', () => {
  expect(core.COORDINATOR_TOOLS).toContain('jevellan_setup_propose');
  expect('ProjectSetupProposalSchema' in core).toBe(true);
});
test('setup triggers add the prescribed repository exploration before events, including resumed turns', () => {
  const input = Object.assign({ events: [], notebook: null, threads: [], decisions: [], history: [], runtimeName: (id: string) => id, deviceName: (id: string) => id, base: 'main', askedDirectly: new Set<string>() }, { setupTriggerId: 'first' });
  for (const resumed of [false, true]) {
    const prompt = coordinatorPrompt(input, resumed);
    expect(prompt).toContain('This project is new to you. Before anything else, read the README, AGENTS.md or CLAUDE.md');
    expect(prompt.indexOf('This project is new')).toBeLessThan(prompt.indexOf('Events since your last turn:'));
  }
});

import { forCoordinator, type FakeTurn } from '../packages/runtime-contract/dist/index.js';
async function run(f: ProjectFixture, text: string, action: (turn: FakeTurn) => Promise<unknown>) {
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const called = new Promise((yes, no) => { resolve = yes; reject = no; });
  f.fake.enqueueTurn(async turn => { try { resolve(await action(turn)); } catch (error) { reject(error); } turn.say('Setup checked.'); return { status: 'completed' }; }, forCoordinator);
  await f.app.projectWork.postMessage(f.project.id, { schema: 'coordinator-message-request-v1', clientMessageId: `message_${f.fake.turnStarts.length}`, text });
  const value = await called; await f.waitFor(() => f.app.projectWork.coordinators.get(f.project.id).state().state, state => state === 'idle'); return value;
}
const items = [{ key: 'testCommand' as const, value: 'npm test' }, { key: 'instructions' as const, value: 'Keep changes small.' }, { key: 'goal' as const, value: 'Make tests reliable\nKeep the relevant checks dependable.' }];
test('first-turn trigger survives notebook writing, refuses a second proposal and does not repeat on later or fresh turns', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true }), work = f.app.projectWork;
  const result = core.SetupProposalResultSchema.parse(await run(f, 'Hello.', async turn => {
    expect(turn.input.prompt).toContain('This project is new to you.');
    await turn.bridge('jevellan_notebook_write', { content: 'A small fixture.', expectedRevision: 0 });
    const result = await turn.bridge('jevellan_setup_propose', { items });
    await expect(turn.bridge('jevellan_setup_propose', { items })).rejects.toThrow('Setup was already proposed for this project.'); return result;
  }));
  expect(result.proposal.items).toEqual(items); expect((await work.settingsView(f.project.id)).settings.instructions).toBe('');
  await run(f, 'Status?', async turn => { expect(turn.input.prompt).not.toContain('This project is new to you.'); await expect(turn.bridge('jevellan_setup_propose', { items })).rejects.toThrow('Setup was already proposed'); });
  await work.coordinators.get(f.project.id).fresh();
  await run(f, 'Still there?', async turn => { expect(turn.input.prompt).not.toContain('This project is new to you.'); });
});
test('existing notebook suppresses setup; an explicit menu trigger permits exactly one new proposal', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  await f.app.projectHub.putNotebook({ schema: 'project-notebook-v1', projectId: f.project.id, revision: 0, content: 'Existing work.', updatedAt: new Date().toISOString(), updatedBy: 'owner' }, 0);
  await run(f, 'Hello.', async turn => { expect(turn.input.prompt).not.toContain('This project is new to you.'); await expect(turn.bridge('jevellan_setup_propose', { items })).rejects.toThrow('Setup was already proposed'); });
  let done!: () => void; const checked = new Promise<void>(resolve => { done = resolve; });
  f.fake.enqueueTurn(async turn => { expect(turn.input.prompt).toContain('This project is new to you.'); await turn.bridge('jevellan_setup_propose', { items }); done(); return { status: 'completed' }; }, forCoordinator);
  expect((await f.request(`/api/projects/${f.project.id}/setup-request`, 'POST', { schema: 'project-run-request-v1', clientRequestId: 'requested_setup' })).status).toBe(202);
  await checked;
});
async function proposed(f: ProjectFixture, proposedItems = items) {
  await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  return core.SetupProposalResultSchema.parse(await f.app.projectWork.proposeSetup(f.project.id, 'test_trigger', { items: proposedItems })).proposal;
}
test('Apply writes exactly selected edited values and paused proposed goals, with an idempotent owner receipt', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true }), work = f.app.projectWork, proposal = await proposed(f);
  const beforeProject = await f.app.state.projects.get(f.project.id), beforeSettings = (await work.settingsView(f.project.id)).settings;
  const view = await work.setupView(f.project.id, proposal.id), input = { schema: 'setup-action-request-v1', clientRequestId: 'apply_setup', expectedRevision: proposal.revision, action: 'apply', settingsRevision: view.settingsRevision, projectRevision: view.projectRevision, selected: [{ index: 0, value: 'npm run narrow' }, { index: 2, value: items[2]!.value }] };
  const response = await f.request(`/api/projects/${f.project.id}/setup-proposals/${proposal.id}/actions`, 'POST', input); expect(response.status).toBe(200);
  const applied = core.SetupProposalViewSchema.parse(await response.json()); expect(applied.proposal.applied).toEqual([0, 2]);
  expect((await f.app.state.projects.get(f.project.id))?.project).toEqual({ ...beforeProject!.project, testCommand: 'npm run narrow' });
  expect((await work.settingsView(f.project.id)).settings).toEqual(beforeSettings);
  expect(await work.goals.list(f.project.id)).toMatchObject([{ name: 'Make tests reliable', state: 'paused', autonomy: 'propose', motivation: 'Keep the relevant checks dependable.' }]);
  expect((await f.request(`/api/projects/${f.project.id}/setup-proposals/${proposal.id}/actions`, 'POST', input)).status).toBe(200);
  expect(await work.goals.list(f.project.id)).toHaveLength(1);
});
test('a changed settings revision or invalid selected value leaves every setup write untouched', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true }), work = f.app.projectWork, proposal = await proposed(f), view = await work.setupView(f.project.id, proposal.id);
  const settings = (await work.settingsView(f.project.id)).settings; await f.app.projectHub.putSettings({ ...settings, maxRunningThreads: 2 }, settings.revision);
  const input = { schema: 'setup-action-request-v1', clientRequestId: 'stale_setup', expectedRevision: proposal.revision, action: 'apply', settingsRevision: view.settingsRevision, projectRevision: view.projectRevision, selected: [{ index: 0, value: 'changed' }, { index: 2, value: items[2]!.value }] };
  expect((await f.request(`/api/projects/${f.project.id}/setup-proposals/${proposal.id}/actions`, 'POST', input)).status).toBe(409);
  expect((await f.app.state.projects.get(f.project.id))?.project.testCommand).toBe(f.project.testCommand); expect(await work.goals.list(f.project.id)).toEqual([]);
  const current = await work.setupView(f.project.id, proposal.id);
  expect((await f.request(`/api/projects/${f.project.id}/setup-proposals/${proposal.id}/actions`, 'POST', { ...input, clientRequestId: 'bad_setup', settingsRevision: current.settingsRevision, selected: [{ index: 0, value: 'changed' }, { index: 2, value: 'No motivation' }] })).status).toBe(400);
  expect((await f.app.state.projects.get(f.project.id))?.project.testCommand).toBe(f.project.testCommand); expect((await work.setupView(f.project.id, proposal.id)).proposal.appliedAt).toBeUndefined();
});
test('Not now changes only the proposal; private names and file paths remain validated', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true }), work = f.app.projectWork, proposal = await proposed(f), before = await work.settingsView(f.project.id);
  await work.setupAction(f.project.id, proposal.id, { schema: 'setup-action-request-v1', clientRequestId: 'dismiss_setup', expectedRevision: proposal.revision, action: 'dismiss' });
  expect((await work.setupView(f.project.id, proposal.id)).proposal.dismissedAt).toBeTruthy(); expect(await work.settingsView(f.project.id)).toEqual(before); expect(await work.goals.list(f.project.id)).toEqual([]);
  const envProposal = core.ProjectSetupProposalSchema.parse({ ...proposal, items: [{ key: 'variables', value: 'SANDBOX_DATA_DIR' }, { key: 'secrets', value: 'SERVICE_TOKEN' }, { key: 'copyFiles', value: '.env.local' }] });
  const settings = core.defaultProjectWorkSettings(f.project.id); settings.environment.variables = [{ name: 'EXISTING', value: 'kept' }];
  const plan = core.projectSetupPlan(envProposal, envProposal.items.map((item, index) => ({ index, value: item.value })), settings, f.project, new Date().toISOString());
  expect(plan.settings.environment).toEqual({ variables: [{ name: 'EXISTING', value: 'kept' }, { name: 'SANDBOX_DATA_DIR', value: '' }], secrets: ['SERVICE_TOKEN'], copyFiles: ['.env.local'] });
  expect(() => core.projectSetupPlan(envProposal, [{ index: 0, value: 'HOME' }], settings, f.project, new Date().toISOString())).toThrow('HOME is reserved');
  expect(() => core.projectSetupPlan(envProposal, [{ index: 2, value: '../outside' }], settings, f.project, new Date().toISOString())).toThrow('Use a path inside');
});

test('a prior thread suppresses first-run exploration', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  const at = new Date().toISOString();
  await f.app.projectHub.publishThread(core.ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 'prior_thread', projectId: f.project.id, title: 'Earlier work', state: 'done', isolation: 'worktree', ownerDeviceId: f.app.device.deviceId, runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Fixture', turns: 1, createdAt: at, updatedAt: at }), 1);
  await run(f, 'Hello.', async turn => { expect(turn.input.prompt).not.toContain('This project is new to you.'); });
});
test('member owner setup actions use the shared hub proposal, and non-coordinator proposals are refused', { timeout: 120000 }, async () => {
  const { projectMember } = await import('./helpers/project-fixture.js');
  const f = fixture = await projectFixture({ coordinator: true }), member = await projectMember(f), proposal = await proposed(f);
  const path = `/api/projects/${f.project.id}/setup-proposals/${proposal.id}`, view = core.SetupProposalViewSchema.parse(await (await member.request(path)).json());
  expect(view.proposal.id).toBe(proposal.id);
  expect((await member.request(`${path}/actions`, 'POST', { schema: 'setup-action-request-v1', action: 'apply', clientRequestId: 'member_setup', expectedRevision: proposal.revision, projectRevision: view.projectRevision, settingsRevision: view.settingsRevision, selected: [{ index: 1, value: 'Shared owner instruction.' }] })).status).toBe(200);
  expect((await f.app.projectWork.settingsView(f.project.id)).settings.instructions).toBe('Shared owner instruction.');
  await expect(member.app.projectWork.proposeSetup(f.project.id, 'member_not_coordinator', { items })).rejects.toThrow('Only the coordinator device can propose setup.');
});

test('an out-of-range setup item is a bad owner request and cannot partly apply earlier items', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true }), proposal = await proposed(f), view = await f.app.projectWork.setupView(f.project.id, proposal.id);
  const response = await f.request(`/api/projects/${f.project.id}/setup-proposals/${proposal.id}/actions`, 'POST', { schema: 'setup-action-request-v1', action: 'apply', clientRequestId: 'invalid_index', expectedRevision: proposal.revision, settingsRevision: view.settingsRevision, projectRevision: view.projectRevision, selected: [{ index: 1, value: 'Must not be written.' }, { index: 11, value: 'Invalid item.' }] });
  expect(response.status).toBe(400); expect((await f.app.projectWork.settingsView(f.project.id)).settings.instructions).toBe('');
});

test('a durable first proposal prevents exploration repeating with an empty new coordinator ledger', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  await f.app.projectWork.proposeSetup(f.project.id, 'first', { items });
  expect(await f.app.projectHub.notebook(f.project.id)).toBeNull();
  await run(f, 'Hello.', async turn => { expect(turn.input.prompt).not.toContain('This project is new to you.'); await expect(turn.bridge('jevellan_setup_propose', { items })).rejects.toThrow('Setup was already proposed'); });
});
