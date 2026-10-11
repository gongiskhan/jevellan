import { afterEach, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountSchema, MergeDocumentsViewSchema, ProjectWorkSettingsSchema, SecretRedactor, VerificationReportSchema, defaultProjectWorkSettings, type MergeRoute, type ModelOption } from '../packages/core/dist/index.js';
import { decideMergeRoute, type DecisionClient, type JevQuestions } from '../packages/decisions/dist/index.js';
import { FakeRuntime, forThread } from '../packages/runtime-contract/dist/index.js';
import { VERIFICATION_APPEND, VerificationTools, derivedId } from '../packages/projects/dist/index.js';
import { git, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const author: ModelOption = { id: 'author', runtime: 'fake', model: 'scripted-model', label: 'Author', description: 'Fixture author.', enabled: true, efforts: ['medium', 'high'] };
const verifier: ModelOption = { ...author, id: 'verify', runtime: 'fake2', label: 'Verifier' };
const packet = { schema: 'merge-route-state-v1' as const, title: 'Fix greeting', task: { type: 'fix' as const, needs: [], goal: null }, summary: 'The greeting handles empty names.', riskyAreas: 'Stored data.', files: [{ path: 'greeting.txt', additions: 2, deletions: 1 }], totalSize: 3, corrections: [] };
function transport(route: string) {
  const state = { route, fail: false, calls: [] as Array<{ state: string; questions: JevQuestions }> };
  const fetcher: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ models: [{ name: 'jev-latest', description: 'Fixture.', release_date: '2026-01-01' }] });
    const body = JSON.parse(String(init?.body)) as { state: string; questions: JevQuestions };
    const input = JSON.parse(body.state) as { schema: string };
    if (input.schema === 'merge-route-state-v1') { state.calls.push(body); if (state.fail) return new Response('Unavailable', { status: 503 }); }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const keys = question.type === 'choice' ? Object.keys(question.criteria) : [], choice = id === 'merge_route' ? state.route : keys[0]!;
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
    }));
    return Response.json({ model: 'jev-fixture', usage: { input_tokens: 20, output_tokens: 4 }, answers });
  };
  return { state, fetch: fetcher };
}
async function setup(route = 'merge', twoProviders = true) {
  const jev = transport(route), second = new FakeRuntime(); Object.defineProperty(second, 'id', { value: 'fake2' });
  const f = fixture = await projectFixture({ menu: twoProviders ? [author, verifier] : [author], runtimes: twoProviders ? { fake: new FakeRuntime(), fake2: second } : { fake: new FakeRuntime() }, jevKey: true, decisionFetch: jev.fetch });
  if (twoProviders) { f.app.hub.put('accounts', 'verify_account', AccountSchema, { schema: 'account-v1', id: 'verify_account', runtime: 'fake2', label: 'Verification account', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0); await f.app.accounts.check('verify_account'); }
  return { f, jev, second };
}
async function settings(f: ProjectFixture, over: object = {}) {
  const old = await f.app.projectHub.settings(f.project.id);
  await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...(old?.document ?? defaultProjectWorkSettings(f.project.id)), autoMerge: true, riskyAreas: 'Stored data.', ...over }), old?.revision ?? 0);
}
function commitStep(f: ProjectFixture, text: string) {
  f.fake.enqueueTurn(async turn => { writeFileSync(join(turn.input.cwd, 'greeting.txt'), text); git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '-m', 'Fix greeting'); await turn.bridge('jevellan_thread_report', { status: 'done', summary: `Added ${text.trim()}.` }); return { status: 'completed' }; }, forThread());
}
async function published(f: ProjectFixture) {
  commitStep(f, 'hello\n');
  const started = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'create_gate', title: 'Fix greeting', task: 'Handle empty names.', isolation: 'worktree', modelId: author.id, effort: 'medium', deviceId: f.app.device.deviceId, taskContext: packet.task });
  await f.waitFor(() => f.thread(started.threadId), thread => thread.state === 'in-review' && !!thread.pr); await f.app.projectWork.idle();
  return f.thread(started.threadId);
}
async function routes(f: ProjectFixture, id: string) { const view = await f.app.projectWork.mergeRoute(f.project.id, id); return view.records.filter((row): row is MergeRoute => row.schema === 'merge-route-v1'); }
async function gate(f: ProjectFixture) { await f.app.projectWork.pulse(); await f.app.projectWork.idle(); }

test('m-v1 asks one question with the complete packet, records probabilities, and fails closed', async () => {
  const client: DecisionClient = { decide: async request => { expect(Object.keys(request.questions)).toEqual(['merge_route']); expect(JSON.parse(request.state)).toEqual(packet); return { schema: 'jev-response-v1', model: 'jev-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: { merge_route: { type: 'choice', choice: 'test-then-merge', probabilities: { merge: 0.1, 'test-then-merge': 0.8, 'ask-owner': 0.1 }, confidence: 0.8 } } }; } };
  const selected = await decideMergeRoute(client, packet, 'jev-latest', new SecretRedactor(), new AbortController().signal); expect(selected).toMatchObject({ route: 'test-then-merge', source: 'jev', calls: [{ kind: 'merge' }] });
  expect(await decideMergeRoute(undefined, packet, 'jev-latest', new SecretRedactor(), new AbortController().signal)).toMatchObject({ route: 'ask-owner', source: 'unavailable' });
  const cancelled = new AbortController(); cancelled.abort(); expect(await decideMergeRoute(client, packet, 'jev-latest', new SecretRedactor(), cancelled.signal)).toMatchObject({ route: 'ask-owner', source: 'unavailable' });
});
test('verification accepts one durable report and identical retries, rejects a second result and expired tokens', async () => {
  const reports: unknown[] = [], tools = new VerificationTools(async report => { reports.push(report); }, new SecretRedactor());
  const report = { result: 'passed', commands: ['npm test'], failures: [] };
  expect(tools.list().tools.map(tool => tool.name)).toEqual(['jevellan_verification_report']); await tools.call('jevellan_verification_report', report); await tools.call('jevellan_verification_report', report); expect(reports).toHaveLength(1);
  await expect(tools.call('jevellan_verification_report', { result: 'failed', commands: [], failures: [] })).rejects.toMatchObject({ status: 409 });
  await expect(tools.call('jevellan_thread_report', {})).rejects.toMatchObject({ status: 403 }); await tools.close(); expect(() => tools.list()).toThrow('expired');
  expect(VerificationReportSchema.safeParse({ result: 'failed', commands: [], failures: [{ what: 'Test failed', output: 'x'.repeat(2001) }] }).success).toBe(false);
});
test('automatic merging is opt-in and squash-merges only the routed head, with durable recovery', async () => {
  const { f, jev } = await setup(), thread = await published(f), before = git(f.checkout, 'rev-parse', 'HEAD');
  await gate(f); expect(jev.state.calls).toHaveLength(0); expect(await routes(f, thread.id)).toHaveLength(0);
  await settings(f); await gate(f); expect(f.thread(thread.id).pr?.state).toBe('merged'); expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'merge', state: 'merged', commit: thread.pr!.headSha });
  const merges = f.github.requests.filter(row => row.method === 'PUT' && row.path.endsWith('/merge')); expect(merges).toHaveLength(1); expect(merges[0]?.body).toMatchObject({ merge_method: 'squash', sha: thread.pr!.headSha });
  expect(git(f.checkout, 'rev-parse', 'HEAD')).toBe(before); await f.restart(); await gate(f); expect(f.github.requests.filter(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toHaveLength(1);
}, 90_000);
test('a workflow handoff is always ask-owner even when Jev chooses merge', async () => {
  const { f } = await setup(), thread = await published(f);
  await f.app.projectWork.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'handoff', name: 'Nightly', goalId: null, enabled: true, gate: null,
    run: { kind: 'github-workflow', workflow: 'nightly.yml', mode: 'dispatch', timeoutMinutes: 5, dispatchAfterMerge: { schema: 'workflow-dispatch-handoff-v1', pull: thread.pr!.number, watchOrder: 1 } } });
  await settings(f); await gate(f); expect(f.thread(thread.id).pr?.state).toBe('open'); expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'ask-owner', source: 'guard', reason: 'The workflow handoff always needs the owner’s merge decision.' });
  expect(f.github.requests.some(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toBe(false);
}, 90_000);
test('pending checks and unknown mergeability never route; a hold delays the checked-head merge', async () => {
  const { f, jev } = await setup(), thread = await published(f); await settings(f);
  f.github.setChecks(thread.pr!.number, 'pending'); await gate(f); expect(jev.state.calls).toHaveLength(0);
  f.github.setChecks(thread.pr!.number, 'passing'); f.github.setMergeable(thread.pr!.number, 'unknown'); await gate(f); expect(jev.state.calls).toHaveLength(0);
  f.github.setMergeable(thread.pr!.number, 'clean');
  const original = f.app.projectWork.mergeGate.o.assertMerge; f.app.projectWork.mergeGate.o.assertMerge = async () => { throw new Error('Merges held'); };
  await gate(f); expect(f.thread(thread.id).pr?.state).toBe('open'); expect((await routes(f, thread.id))[0]?.state).toBe('waiting');
  f.app.projectWork.mergeGate.o.assertMerge = original; await gate(f); expect(f.thread(thread.id).pr?.state).toBe('merged'); expect(jev.state.calls).toHaveLength(1);
}, 90_000);
test('Jev failure creates an exact-head owner item and the owner can close it', async () => {
  const { f, jev } = await setup(); jev.state.fail = true; const thread = await published(f); await settings(f); await gate(f);
  const route = (await routes(f, thread.id))[0]!; expect(route).toMatchObject({ route: 'ask-owner', source: 'unavailable', state: 'asked' });
  const decision = (await f.app.projectHub.decision(route.decisionId!))!.document; expect(decision.options.map(option => option.label)).toEqual(['Merge', 'Send back with a note', 'Close']); expect(decision.merge?.commit).toBe(thread.pr!.headSha);
  const answer = await f.request(`/api/projects/project/decisions/${decision.id}/answer`, 'POST', { schema: 'decision-answer-request-v1', clientRequestId: 'owner_close', optionLabel: 'Close' }); expect(answer.status).toBe(202); expect(f.thread(thread.id).pr?.state).toBe('closed');
}, 90_000);
test('a changed head refuses its old owner decision and creates a new route', async () => {
  const { f, jev } = await setup('ask-owner'), thread = await published(f); await settings(f); await gate(f); const route = (await routes(f, thread.id))[0]!;
  writeFileSync(join(thread.cwd, 'greeting.txt'), 'new greeting\n'); git(thread.cwd, 'add', '-A'); git(thread.cwd, 'commit', '-m', 'New greeting'); git(thread.cwd, 'push', 'origin', thread.branch!);
  const answer = await f.request(`/api/projects/project/decisions/${route.decisionId}/answer`, 'POST', { schema: 'decision-answer-request-v1', clientRequestId: 'stale_merge', optionLabel: 'Merge' }); expect(answer.status).toBe(409);
  await gate(f); expect(await routes(f, thread.id)).toHaveLength(2); expect((await f.app.projectHub.decision(route.decisionId!))?.document.withdrawnAt).toBeDefined(); expect(jev.state.calls).toHaveLength(2);
}, 90_000);
test('basic verification uses the other provider, medium effort and a fresh clean head before merging', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f), before = git(f.checkout, 'status', '--porcelain=v1');
  second.enqueueTurn(async turn => { expect(turn.input.owner.kind).toBe('verification'); expect(turn.input.systemAppend).toBe(VERIFICATION_APPEND); expect(turn.input.effort).toBe('medium'); expect(turn.input.cwd).not.toBe(thread.cwd); expect(git(turn.input.cwd, 'rev-parse', 'HEAD')).toBe(thread.pr!.headSha); expect(await turn.tools()).toEqual(['jevellan_verification_report']); await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['test -f greeting.txt'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  await settings(f); await gate(f); const view = await f.app.projectWork.mergeRoute(f.project.id, thread.id);
  expect(view.records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ providerChoice: 'other-provider', runtime: 'fake2', state: 'passed' }); expect(f.thread(thread.id).pr?.state).toBe('merged'); expect(git(f.checkout, 'status', '--porcelain=v1')).toBe(before);
}, 90_000);
test('no eligible alternate provider or model asks the owner without starting a verification', async () => {
  const { f } = await setup('test-then-merge', false), thread = await published(f); await settings(f); await gate(f);
  expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'ask-owner', source: 'guard', state: 'asked' }); expect(f.fake.turnStarts.some(input => input.owner.kind === 'verification')).toBe(false);
}, 90_000);
test('verification rejects a dirty worktree, sends failures to the original thread, and reroutes its next push', async () => {
  const { f, second, jev } = await setup('test-then-merge'), thread = await published(f);
  second.enqueueTurn(async turn => { writeFileSync(join(turn.input.cwd, 'illegal.txt'), 'changed'); await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['npm test'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  commitStep(f, 'fixed after verification\n'); await settings(f); await gate(f);
  const first = (await routes(f, thread.id)).find(row => row.commit === thread.pr!.headSha)!; expect(first).toMatchObject({ state: 'failed', failures: 1 });
  expect(f.fake.turnStarts.at(-1)?.prompt).toContain('Verification changed its worktree');
  jev.state.route = 'ask-owner'; await f.waitFor(() => f.thread(thread.id).pr?.headSha, sha => !!sha && sha !== thread.pr!.headSha); await gate(f); expect(await routes(f, thread.id)).toHaveLength(2);
}, 90_000);
test('the newest eight owner corrections are retained in the next m-v1 packet', async () => {
  const { f, jev } = await setup('ask-owner'), thread = await published(f); await settings(f); await gate(f);
  for (let n = 0; n < 10; n++) await f.app.projectWork.mergeCorrection('project', thread.id, { schema: 'merge-correction-input-v1', clientRequestId: `correction_${n}`, commit: thread.pr!.headSha, correction: n % 2 ? 'should-have-asked' : 'did-not-need-asking' });
  const view = await f.json(`/api/projects/project/threads/${thread.id}/pr/route`, MergeDocumentsViewSchema); expect(view.records.filter(row => row.schema === 'merge-correction-v1')).toHaveLength(10);
  writeFileSync(join(thread.cwd, 'greeting.txt'), 'changed\n'); git(thread.cwd, 'add', '-A'); git(thread.cwd, 'commit', '-m', 'New head'); git(thread.cwd, 'push', 'origin', thread.branch!); await gate(f);
  const input = JSON.parse(jev.state.calls.at(-1)!.state) as { corrections: string[] }; expect(input.corrections).toHaveLength(8); expect(input.corrections.every(sentence => sentence.includes('the owner said'))).toBe(true);
}, 90_000);

test('three failed basic verifications on one pull request escalate to one owner item', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  for (let attempt = 1; attempt <= 3; attempt++) second.enqueueTurn(async turn => { await turn.bridge('jevellan_verification_report', { result: 'failed', commands: ['npm test'], failures: [{ what: 'Empty name is still wrong.', output: 'Expected an empty greeting.' }] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  commitStep(f, 'repair one\n'); commitStep(f, 'repair two\n'); await settings(f);
  for (let attempt = 1; attempt <= 3; attempt++) { await gate(f); if (attempt < 3) await f.waitFor(() => f.thread(thread.id).turns, turns => turns === attempt + 1); }
  const rows = await routes(f, thread.id), last = rows.find(row => row.failures === 3)!;
  expect(last).toMatchObject({ route: 'ask-owner', state: 'asked', source: 'guard' }); expect(second.turnStarts.filter(input => input.owner.kind === 'verification')).toHaveLength(3);
  const decisions = await f.app.projectHub.decisions('project'); expect(decisions.filter(row => row.merge && !row.withdrawnAt)).toHaveLength(1);
  await gate(f); expect(second.turnStarts.filter(input => input.owner.kind === 'verification')).toHaveLength(3);
}, 90_000);
test('a verification that commits fails even when its worktree ends clean', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  second.enqueueTurn(async turn => { writeFileSync(join(turn.input.cwd, 'greeting.txt'), 'Illegal commit\n'); git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '-m', 'Not allowed'); await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['npm test'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  f.fake.enqueueTurn(async turn => { await turn.bridge('jevellan_thread_report', { status: 'blocked', summary: 'Waiting for the owner.' }); return { status: 'completed' }; }, forThread());
  await settings(f); await gate(f); const view = await f.app.projectWork.mergeRoute('project', thread.id);
  expect(view.records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ state: 'failed', report: { result: 'failed', failures: [{ what: 'Verification changed its worktree or created a commit.' }] } }); expect(f.thread(thread.id).pr?.state).toBe('open');
}, 90_000);
test('an interrupted verification receipt is not replayed after a daemon restart', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  await settings(f);
  // Lost execution evidence: the worker is gone; the hub receipt still says running.
  const commit = thread.pr!.headSha, id = derivedId('mroute', thread.id, commit), verificationId = derivedId('pver', thread.id, commit, '1'), at = new Date().toISOString();
  await f.app.projectHub.putMergeDocument({ schema: 'verification-run-v1', id: verificationId, projectId: 'project', threadId: thread.id, revision: 0, deviceId: f.app.device.deviceId, commit, at, runtime: 'fake2', modelId: 'verify', model: 'scripted-model', modelLabel: 'Verifier', providerChoice: 'other-provider', state: 'running', report: null }, 0);
  await f.app.projectHub.putMergeDocument({ schema: 'merge-route-v1', id, projectId: 'project', threadId: thread.id, revision: 0, deviceId: f.app.device.deviceId, commit, at, prNumber: thread.pr!.number, route: 'test-then-merge', source: 'jev', questionSet: 'm-v1', packet, calls: [], state: 'verifying', failures: 0, decisionId: null, verificationId, notified: [] }, 0);
  f.fake.enqueueTurn(async turn => { await turn.bridge('jevellan_thread_report', { status: 'blocked', summary: 'Waiting after interrupted verification.' }); return { status: 'completed' }; }, forThread());
  await f.restart(); await gate(f); expect(second.turnStarts.filter(input => input.owner.kind === 'verification')).toHaveLength(0);
  expect((await f.app.projectWork.mergeRoute('project', thread.id)).records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ state: 'failed', report: { failures: [{ what: 'Verification was interrupted by a restart.' }] } }); expect(f.thread(thread.id).pr?.state).toBe('open');
}, 90_000);

test('when the other provider is ineligible verification records a different model on the author provider', async () => {
  const { f } = await setup('test-then-merge'), thread = await published(f);
  const config = f.app.hub.configuration.current()!, alternate = { ...author, id: 'alternate', model: 'alternate-model', label: 'Alternate model' };
  config.configuration['x-jevellan'].menu.push(alternate); f.app.hub.configuration.put(config.configuration, config.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  const account = f.app.hub.get('accounts', 'verify_account', AccountSchema)!; f.app.hub.put('accounts', 'verify_account', AccountSchema, { ...account.document, enabled: false }, account.revision);
  f.fake.enqueueTurn(async turn => { expect(turn.input.model).toBe('alternate-model'); await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['npm test'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  await settings(f); await gate(f);
  expect((await f.app.projectWork.mergeRoute('project', thread.id)).records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ state: 'passed', providerChoice: 'different-model', runtime: 'fake', model: 'alternate-model' }); expect(f.thread(thread.id).pr?.state).toBe('merged');
}, 90_000);


test('the owner Merge button retires its unanswered merge item without an automatic-merge event', async () => {
  const { f } = await setup('ask-owner'), thread = await published(f); await settings(f); await gate(f);
  const route = (await routes(f, thread.id))[0]!;
  await f.app.projectWork.mergePullRequest('project', thread.id); await gate(f);
  expect((await f.app.projectHub.decision(route.decisionId!))?.document.withdrawnAt).toBeDefined();
  expect((await routes(f, thread.id))[0]).toMatchObject({ state: 'merged', notified: ['ask-owner:0'] });
}, 90_000);
