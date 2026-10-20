import { existsSync } from 'node:fs';
import { seedRouteDecision } from './helpers/route-fixtures.js';
import { afterEach, expect, test, vi } from 'vitest';
import { LandingRouteSchema, MergeRouteSchema, ThreadCreatedViewSchema, VerificationRunSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectPageView } from '../packages/projects/dist/page-view.js';
import { projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
const commit = (char: string) => char.repeat(40);
async function setup() {
  const f = fixture = await projectFixture(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Route explanation fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'route_why_fixture', title: 'Route explanation fixture', task: 'Inspect the simulated route.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  const id = made.threadId, at = f.thread(id).createdAt, path = `/api/projects/project/threads/${id}`;
  const identity = (key: string, char: string) => ({ id: key, projectId: 'project', threadId: id, deviceId: f.app.device.deviceId, revision: 0, commit: commit(char), at });
  const task = { type: 'feature' as const, needs: [], goal: null };
  const landing = (key: string, char: string, patch: object = {}) => LandingRouteSchema.parse({ schema: 'landing-route-v1', ...identity(key, char), questionSet: 'l-v1', route: 'land', source: 'guard', state: 'landed', reason: 'Recorded fixture landing.', calls: [],
    packet: { schema: 'landing-route-state-v1', title: 'Fixture route', task, summary: 'Fixture context.', riskyAreas: '', files: [{ path: 'fixture.txt', bytes: 12, additions: 2, deletions: 1 }], checks: [{ name: 'Fixture check', passed: true, at }], corrections: [] }, ...patch });
  const merge = (key: string, char: string) => MergeRouteSchema.parse({ schema: 'merge-route-v1', ...identity(key, char), questionSet: 'm-v1', prNumber: 1, route: 'ask-owner', source: 'guard', state: 'waiting', reason: 'Recorded fixture merge.', calls: [], failures: 0, decisionId: null, verificationId: null,
    probabilities: { merge: 0.12, 'test-then-merge': 0.33, 'ask-owner': 0.55 }, packet: { schema: 'merge-route-state-v1', title: 'Fixture merge', task, summary: 'Fixture merge context.', riskyAreas: 'Fixture files.', files: [{ path: 'fixture.txt', additions: 2, deletions: 1 }], totalSize: 3, corrections: [] } });
  return { f, id, at, path, identity, landing, merge };
}

test('landing Why selects the newest route and prepares corrections for its original commit', async () => {
  const { f, path, at, landing } = await setup();
  await f.app.projectHub.putMergeDocument(landing('landing_older', 'a'), 0);
  await f.app.projectHub.putMergeDocument(landing('landing_later', 'b', { at: new Date(Date.parse(at) + 1000).toISOString(), checkedCommit: commit('c') }), 0);
  const response = await f.request(`${path}/landing/why-view`); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-route-why-view-v1', kind: 'landing', route: { id: 'landing_later', checkedCommit: commit('c'), riskyLine: 'Risky areas: None specified.', checks: [{ name: 'Fixture check', resultLabel: 'passed' }] } });
  expect(view.correctionActions).toHaveLength(2); expect(view.correctionActions[0].request.body).toMatchObject({ schema: 'landing-correction-input-v1', commit: commit('b') });
});

test('merge Why pins its route and verification runs to the requested commit using canonical merge mode', async () => {
  const { f, path, identity, merge } = await setup();
  const settings = await f.app.projectWork.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, delivery: 'land', autoLand: false, pullRequestAutoMerge: true }, settings.revision);
  await f.app.projectHub.putMergeDocument(merge('merge_current', 'b'), 0); await f.app.projectHub.putMergeDocument(merge('merge_old', 'a'), 0);
  for (const char of ['a', 'b']) await f.app.projectHub.putMergeDocument(VerificationRunSchema.parse({ schema: 'verification-run-v1', ...identity(`verification_${char}`, char), runtime: 'fake', modelId: 'fixture', model: 'scripted-model', modelLabel: 'Fixture', providerChoice: 'other-provider', state: 'passed', report: { result: 'passed', commands: ['true'], failures: [] } }), 0);
  const response = await f.request(`${path}/pr/why-view`, 'POST', { schema: 'project-merge-why-request-v1', commit: commit('b') }); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ kind: 'merge', commit: commit('b'), shadowLine: null, route: { id: 'merge_current', routeLabel: 'Ask owner', sourceLabel: 'Guard', changeLine: '3 added and removed lines across 1 files.', probabilities: ['merge: 12%', 'test-then-merge: 33%', 'ask-owner: 55%'] } });
  expect(view.verifications.map((row: { id: string }) => row.id)).toEqual(['verification_b']); expect(view.pollHintMs).toBe(60000);
});

test.each(['landing', 'merge'] as const)('%s Why UI and tool corrections use the same canonical retry path', async kind => {
  const { f, id, path, landing, merge } = await setup(); await f.app.projectHub.putMergeDocument(kind === 'landing' ? landing('landing_correction_fixture', 'a') : merge('merge_correction_fixture', 'a'), 0);
  const response = kind === 'landing' ? await f.request(`${path}/landing/why-view`) : await f.request(`${path}/pr/why-view`, 'POST', { schema: 'project-merge-why-request-v1', commit: commit('a') });
  expect(response.status).toBe(200); const view = await response.json(), action = view.correctionActions[0];
  expect((await f.request(action.request.path, 'POST', action.request.body)).status).toBe(200);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'route_correct', args: { project: 'project', thread: id, request: action.request.body } })).toMatchObject({ ok: true, data: { schema: 'project-route-why-view-v1', kind } });
  const rows = (await f.app.projectHub.mergeDocuments('project')).records; expect(rows.filter(row => row.schema === `${kind}-correction-v1`)).toHaveLength(1);
});

test('route Why has no correction action before a matching decision exists', async () => {
  const { f, path } = await setup();
  for (const response of [await f.request(`${path}/landing/why-view`), await f.request(`${path}/pr/why-view`, 'POST', { schema: 'project-merge-why-request-v1', commit: commit('d') })]) {
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ route: null, correctionActions: [], verifications: [] });
  }
});

test('Overview merge shadow follows the pull-request switch independently of automatic landing', async () => {
  const f = fixture = await projectFixture(), page = await f.app.projectWork.pageView('project');
  const pr = { number: 1, url: 'https://example.invalid/pull/1', state: 'open' as const, headSha: commit('a'), checks: 'passing' as const, mergeable: 'clean' as const, updatedAt: page.at };
  const input = { work: { ...page.work, settings: { ...page.work.settings, delivery: 'land' as const, autoLand: false, pullRequestAutoMerge: true }, pullRequests: [{ threadId: 'projection_thread', title: 'Fixture PR', pr }] }, tasks: page.tasks, goals: page.goals, daily: page.daily };
  expect(projectPageView(input).overview.pullRequests[0]?.shadow).toBe(false);
  input.work.settings.autoLand = true; input.work.settings.pullRequestAutoMerge = false;
  expect(projectPageView(input).overview.pullRequests[0]?.shadow).toBe(true);
});


test.each(['landing', 'merge'] as const)('%s correction retry survives a lost projection response after the canonical write', async kind => {
  const { f, id, path, landing, merge } = await setup(); await f.app.projectHub.putMergeDocument(kind === 'landing' ? landing('landing_partial_fixture', 'a') : merge('merge_partial_fixture', 'a'), 0);
  const response = kind === 'landing' ? await f.request(`${path}/landing/why-view`) : await f.request(`${path}/pr/why-view`, 'POST', { schema: 'project-merge-why-request-v1', commit: commit('a') });
  expect(response.status).toBe(200); const view = await response.json(), action = view.correctionActions[0], fault = Object.assign(new Error('Fixture projection unavailable after save.'), { status: 503 });
  if (kind === 'landing') vi.spyOn(f.app.projectWork.landings, 'whyView').mockRejectedValueOnce(fault); else vi.spyOn(f.app.projectWork.mergeGate, 'whyView').mockRejectedValueOnce(fault);
  expect((await f.request(action.request.path, 'POST', action.request.body)).status).toBe(503);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'route_correct', args: { project: 'project', thread: id, request: action.request.body } })).toMatchObject({ ok: true, data: { kind, savedNotice: `Saved for future ${kind} decisions.` } });
  expect((await f.app.projectHub.mergeDocuments('project')).records.filter(row => row.schema === `${kind}-correction-v1`)).toHaveLength(1);
});

test('member route models and correction writes retain the thread owner', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  member.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Member route fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'member_route_model', title: 'Member route model', task: 'Inspect the simulated member route.', deviceId: member.deviceId });
  await f.waitFor(async () => { await member.app.projectWork.pulse(); return existsSync(member.app.projectWork.paths.threadFile('project', made.threadId)) ? member.thread(made.threadId).state : 'not-arrived'; }, state => state === 'idle');
  await member.app.projectWork.pulse(); await f.app.projectWork.pulse();
  await seedRouteDecision(member.app.projectHub, { projectId: 'project', threadId: made.threadId, deviceId: member.deviceId, commit: commit('a'), at: member.thread(made.threadId).createdAt }, 'landing');
  const response = await f.request(`/api/projects/project/threads/${made.threadId}/landing/why-view`); expect(response.status).toBe(200); const view = await response.json(), action = view.correctionActions[0];
  const hubWrite = vi.spyOn(f.app.projectWork, 'landingCorrection'), memberWrite = vi.spyOn(member.app.projectWork, 'landingCorrection');
  expect((await f.request(action.request.path, 'POST', action.request.body)).status).toBe(200);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'route_correct', args: { project: 'project', thread: made.threadId, request: action.request.body } })).toMatchObject({ ok: true, data: { kind: 'landing' } });
  expect(hubWrite).not.toHaveBeenCalled(); expect(memberWrite).toHaveBeenCalledTimes(2); expect(f.app.projectWork.store.get(made.threadId)).toBeUndefined();
  expect((await f.app.projectHub.mergeDocuments('project')).records.filter(row => row.schema === 'landing-correction-v1')).toHaveLength(1);
});
