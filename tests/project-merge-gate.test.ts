import { afterEach, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JevLessonSchema,ProjectJobSchema, AccountSchema, GitHubClient, MergeDocumentsViewSchema, ProjectWorkSettingsSchema, SecretRedactor, VerificationReportSchema, defaultProjectWorkSettings, type MergeRoute, type ModelOption } from '../packages/core/dist/index.js';
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
  const state = { route, fail: false, hang: false, calls: [] as Array<{ state: string; questions: JevQuestions }> };
  const fetcher: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ models: [{ name: 'jev-latest', description: 'Fixture.', release_date: '2026-01-01' }] });
    const body = JSON.parse(String(init?.body)) as { state: string; questions: JevQuestions };
    const input = JSON.parse(body.state) as { schema: string };
    if (input.schema === 'merge-route-state-v1') { state.calls.push(body); if (state.fail) return new Response('Unavailable', { status: 503 }); if (state.hang) return new Promise<Response>(() => undefined); }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const keys = question.type === 'choice' ? Object.keys(question.criteria) : [], choice = id === 'merge_route' ? state.route : keys[0]!;
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
    }));
    return Response.json({ model: 'jev-fixture', usage: { input_tokens: 20, output_tokens: 4 }, answers });
  };
  return { state, fetch: fetcher };
}
async function setup(route = 'merge', twoProviders = true, clock?: () => number) {
  const jev = transport(route), second = new FakeRuntime(); Object.defineProperty(second, 'id', { value: 'fake2' });
  const f = fixture = await projectFixture({ menu: twoProviders ? [author, verifier] : [author], runtimes: twoProviders ? { fake: new FakeRuntime(), fake2: second } : { fake: new FakeRuntime() }, jevKey: true, decisionFetch: jev.fetch, ...(clock ? { projectTimers: { now: clock } } : {}) });
  if (twoProviders) { f.app.hub.put('accounts', 'verify_account', AccountSchema, { schema: 'account-v1', id: 'verify_account', runtime: 'fake2', label: 'Verification account', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0); await f.app.accounts.check('verify_account'); }
  await settings(f, { autoLand: false });
  return { f, jev, second };
}
async function settings(f: ProjectFixture, over: object = {}) {
  const old = await f.app.projectHub.settings(f.project.id);
  await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...(old?.document ?? defaultProjectWorkSettings(f.project.id)), delivery: 'pull-request', autoLand: true, riskyAreas: 'Stored data.', ...over }), old?.revision ?? 0);
}
function commitStep(f: ProjectFixture, text: string) {
  f.fake.enqueueTurn(async turn => { writeFileSync(join(turn.input.cwd, 'greeting.txt'), text); git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '-m', 'Fix greeting'); await turn.bridge('jevellan_thread_report', { status: 'done', summary: `Added ${text.trim()}.` }); return { status: 'completed' }; }, forThread());
}
async function published(f: ProjectFixture) {
  commitStep(f, 'hello\n');
  const started = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'create_gate', title: 'Fix greeting', task: 'Handle empty names.', isolation: 'worktree', modelId: author.id, effort: 'medium', deviceId: f.app.device.deviceId, taskContext: packet.task });
  await f.waitFor(() => f.thread(started.threadId), thread => thread.state === 'in-review' && !!thread.pr); await f.app.projectWork.idle();
  f.github.setChecks(f.thread(started.threadId).pr!.number, 'passing');
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
  await gate(f); expect(jev.state.calls).toHaveLength(1); expect(await routes(f, thread.id)).toHaveLength(1); expect(f.thread(thread.id).pr?.state).toBe('open');
  await settings(f); await gate(f); expect(f.thread(thread.id).pr?.state).toBe('merged'); expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'merge', state: 'merged', commit: thread.pr!.headSha });
  const merges = f.github.requests.filter(row => row.method === 'PUT' && row.path.endsWith('/merge')); expect(merges).toHaveLength(1); expect(merges[0]?.body).toMatchObject({ merge_method: 'squash', sha: thread.pr!.headSha });
  expect(git(f.checkout, 'rev-parse', 'HEAD')).toBe(before); await f.restart(); await gate(f); expect(f.github.requests.filter(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toHaveLength(1);
}, 90_000);
test.each(['paused', 'archived'] as const)('%s keeps pull request polling and owner merging available without automatic routing', async status => {
  const { f, jev } = await setup(), thread = await published(f);
  await settings(f, { status });
  f.github.setChecks(thread.pr!.number, 'failing'); await gate(f);
  expect(f.thread(thread.id).pr?.checks).toBe('failing');
  f.github.setChecks(thread.pr!.number, 'passing'); await gate(f);
  expect(f.thread(thread.id).pr).toMatchObject({ state: 'open', checks: 'passing' });
  expect(jev.state.calls).toHaveLength(0);
  expect(f.github.requests.some(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toBe(false);
  const response = await f.request(`/api/projects/project/threads/${thread.id}/pr/merge`, 'POST', { schema: 'empty-request-v1' });
  expect(response.status).toBe(200);
  expect(f.thread(thread.id).pr?.state).toBe('merged');
}, 90_000);
test('a retired workflow hint cannot hold the legacy pull-request route', async () => {
  const { f } = await setup(), thread = await published(f), at = f.app.projectWork.tasks.at();
  f.app.hub.put('project-jobs', 'retired_handoff', ProjectJobSchema, { schema: 'project-job-v1', id: 'retired_handoff', projectId: 'project', revision: 1, name: 'Historical nightly', goalId: null, enabled: false, gate: null,
    run: { kind: 'github-workflow', workflow: 'nightly.yml', mode: 'dispatch', timeoutMinutes: 5, dispatchAfterMerge: { schema: 'workflow-dispatch-handoff-v1', pull: thread.pr!.number, watchOrder: 1 } }, createdAt: at, updatedAt: at }, 0);
  await settings(f); await gate(f); expect(f.thread(thread.id).pr?.state).toBe('merged'); expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'merge', source: 'jev' });
  expect(f.github.requests.some(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toBe(true);
}, 90_000);
test('automatic merging waits for publication and routes the newly pushed head', async () => {
  const { f, jev } = await setup(), thread = await published(f); await settings(f);
  f.app.projectWork.store.update(thread.id, current => ({ ...current, state: 'publishing' }));
  writeFileSync(join(thread.cwd, 'greeting.txt'), 'new greeting\n'); git(thread.cwd, 'add', '-A'); git(thread.cwd, 'commit', '-m', 'New greeting');
  await gate(f); expect(jev.state.calls).toHaveLength(0); expect(f.github.requests.some(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toBe(false);
  const head = git(thread.cwd, 'rev-parse', 'HEAD'); git(thread.cwd, 'push', 'origin', thread.branch!);
  f.app.projectWork.store.update(thread.id, current => ({ ...current, state: 'in-review' }));
  await gate(f); expect(f.thread(thread.id).pr?.state).toBe('merged'); expect((await routes(f, thread.id))[0]?.commit).toBe(head);
  expect(f.github.requests.find(row => row.method === 'PUT' && row.path.endsWith('/merge'))?.body).toMatchObject({ sha: head });
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
test('a Jev route request that never settles and ignores its abort asks the owner within the decision deadline (fix-051)', async () => {
  const { f, jev } = await setup(); jev.state.hang = true; const thread = await published(f); await settings(f);
  const started = Date.now(); await gate(f);
  expect(Date.now() - started).toBeLessThan(2 * 4000 + 1000 + 5000 + 5000);
  const route = (await routes(f, thread.id))[0]!; expect(route).toMatchObject({ route: 'ask-owner', source: 'unavailable', state: 'asked' });
  expect(jev.state.calls).toHaveLength(1);
}, 90_000);
test('a changed head refuses its old owner decision and creates a new route', async () => {
  const { f, jev } = await setup('ask-owner'), thread = await published(f); await settings(f); await gate(f); const route = (await routes(f, thread.id))[0]!;
  writeFileSync(join(thread.cwd, 'greeting.txt'), 'new greeting\n'); git(thread.cwd, 'add', '-A'); git(thread.cwd, 'commit', '-m', 'New greeting'); git(thread.cwd, 'push', 'origin', thread.branch!);
  const answer = await f.request(`/api/projects/project/decisions/${route.decisionId}/answer`, 'POST', { schema: 'decision-answer-request-v1', clientRequestId: 'stale_merge', optionLabel: 'Merge' }); expect(answer.status).toBe(409);
  await gate(f); expect(await routes(f, thread.id)).toHaveLength(2); expect((await f.app.projectHub.decision(route.decisionId!))?.document.withdrawnAt).toBeDefined(); expect(jev.state.calls).toHaveLength(2);
}, 90_000);
test('basic verification uses the other provider, medium effort and a fresh clean head before merging', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f), before = git(f.checkout, 'status', '--porcelain=v1');
  second.enqueueTurn(async turn => { expect(turn.input.owner.kind).toBe('verification'); expect(turn.input.systemAppend).toBe(`- The project journal at ${f.app.projectWork.journal!.path(f.project.id)} has one file per thread, per day and per night, listed in INDEX.md. Read it when you need to know what other work did.\n\n` + VERIFICATION_APPEND); expect(turn.input.readOnlyDirectories).toEqual([f.app.projectWork.journal!.path(f.project.id)]); expect(turn.input.effort).toBe('medium'); expect(turn.input.cwd).not.toBe(thread.cwd); expect(git(turn.input.cwd, 'rev-parse', 'HEAD')).toBe(thread.pr!.headSha); expect(await turn.tools()).toEqual(['jevellan_verification_report', 'memory_search', 'memory_read']); f.app.projectWork.store.update(thread.id, current => ({ ...current, state: 'publishing' })); await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['test -f greeting.txt'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  await settings(f); await gate(f); const view = await f.app.projectWork.mergeRoute(f.project.id, thread.id);
  expect(view.records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ providerChoice: 'other-provider', runtime: 'fake2', state: 'passed' }); expect(f.thread(thread.id).pr?.state).toBe('open');
  f.app.projectWork.store.update(thread.id, current => ({ ...current, state: 'in-review' })); await gate(f);
  expect(f.thread(thread.id).pr?.state).toBe('merged'); expect(second.turnStarts).toHaveLength(1); expect(git(f.checkout, 'status', '--porcelain=v1')).toBe(before);
}, 90_000);
test('no eligible alternate provider or model asks the owner without starting a verification', async () => {
  const { f } = await setup('test-then-merge', false), thread = await published(f); await settings(f); await gate(f);
  expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'ask-owner', source: 'guard', state: 'asked' }); expect(f.fake.turnStarts.some(input => input.owner.kind === 'verification')).toBe(false);
}, 90_000);
test('risky areas changed during verification require a new owner decision before merging', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  second.enqueueTurn(async turn => {
    await settings(f, { riskyAreas: 'Stored data; greeting behaviour.' });
    await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['test -f greeting.txt'], failures: [] });
    return { status: 'completed' };
  }, input => input.owner.kind === 'verification');
  await settings(f); await gate(f);
  const route = (await routes(f, thread.id))[0]!;
  expect(route).toMatchObject({ route: 'ask-owner', source: 'guard', state: 'asked', reason: 'The project’s risky areas changed after this routing decision.' });
  expect((await f.app.projectHub.decision(route.decisionId!))?.document.merge?.commit).toBe(thread.pr!.headSha);
  expect(f.thread(thread.id).pr?.state).toBe('open');
  expect(f.github.requests.some(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toBe(false);
}, 90_000);
test('a dirty verifier cannot merge, count a failed test, or send invented failures to the author', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f); let messages = 0;
  f.app.projectWork.mergeGate.o.message = async () => { messages++; };
  for (let n = 0; n < 2; n++) second.enqueueTurn(async turn => { writeFileSync(join(turn.input.cwd, 'illegal.txt'), 'changed'); await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['npm test'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  await settings(f); await gate(f); await gate(f);
  expect((await routes(f, thread.id))[0]).toMatchObject({ state: 'asked', route: 'ask-owner', failures: 0 }); expect(messages).toBe(0); expect(f.thread(thread.id).pr?.state).toBe('open');
}, 90_000);
test('the newest eight owner corrections are retained in the next m-v1 packet', async () => {
  const { f, jev } = await setup('ask-owner'), thread = await published(f); await settings(f); await gate(f);
  for (let n = 0; n < 10; n++) await f.app.projectWork.mergeCorrection('project', thread.id, { schema: 'merge-correction-input-v1', clientRequestId: `correction_${n}`, commit: thread.pr!.headSha, correction: n % 2 ? 'should-have-asked' : 'did-not-need-asking' });
  const view = await f.json(`/api/projects/project/threads/${thread.id}/pr/route`, MergeDocumentsViewSchema); expect(view.records.filter(row => row.schema === 'merge-correction-v1')).toHaveLength(10);
  writeFileSync(join(thread.cwd, 'greeting.txt'), 'changed\n'); git(thread.cwd, 'add', '-A'); git(thread.cwd, 'commit', '-m', 'New head'); git(thread.cwd, 'push', 'origin', thread.branch!); await gate(f);
  const input = JSON.parse(jev.state.calls.at(-1)!.state) as { corrections: string[] }; expect(input.corrections).toHaveLength(8); expect(input.corrections.every(sentence => sentence.includes('the owner said'))).toBe(true);
}, 90_000);

test('equal-time merge corrections use hub-assigned order rather than IDs or caller order', async () => {
  const { f, jev } = await setup('ask-owner'), thread = await published(f); await settings(f); await gate(f);
  const at = new Date().toISOString();
  for (let n = 0; n < 10; n++) await f.app.projectHub.putMergeDocument({ schema: 'merge-correction-v1', id: `mcor_${9 - n}`, projectId: 'project',
    revision: 0, deviceId: f.app.device.deviceId, threadId: thread.id, commit: thread.pr!.headSha, at, title: `Correction ${n}`, correction: 'should-have-asked', receivedOrder: 9999 }, 0);
  const rows = (await f.app.projectHub.mergeDocuments('project')).records.filter(row => row.schema === 'merge-correction-v1');
  expect(rows.map(row => row.receivedOrder).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await f.app.projectHub.putMergeDocument({ ...rows.find(row => row.id === 'mcor_9')!, revision: 0, receivedOrder: 9999 }, 0);
  writeFileSync(join(thread.cwd, 'greeting.txt'), 'changed\n'); git(thread.cwd, 'add', '-A'); git(thread.cwd, 'commit', '-m', 'New head'); git(thread.cwd, 'push', 'origin', thread.branch!); await gate(f);
  const input = JSON.parse(jev.state.calls.at(-1)!.state) as { corrections: string[] };
  expect(input.corrections).toEqual(Array.from({ length: 8 }, (_, n) => `For “Correction ${9 - n}”, the owner said: Should have asked me.`));
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
  expect(view.records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ state: 'failed', note: 'Verification changed its worktree or created a commit.', report: { result: 'passed', failures: [] } }); expect(f.thread(thread.id).pr?.state).toBe('open');
}, 90_000);
test('an interrupted verification receipt is not replayed after a daemon restart', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  await settings(f);
  // Lost execution evidence: the worker is gone; the hub receipt still says running.
  const commit = thread.pr!.headSha, id = derivedId('mroute', thread.id, commit), verificationId = derivedId('pver', thread.id, commit, '1'), at = new Date().toISOString();
  await f.app.projectHub.putMergeDocument({ schema: 'verification-run-v1', id: verificationId, projectId: 'project', threadId: thread.id, revision: 0, deviceId: f.app.device.deviceId, commit, at, runtime: 'fake2', modelId: 'verify', model: 'scripted-model', modelLabel: 'Verifier', providerChoice: 'other-provider', state: 'running', report: null }, 0);
  await f.app.projectHub.putMergeDocument({ schema: 'merge-route-v1', id, projectId: 'project', threadId: thread.id, revision: 0, deviceId: f.app.device.deviceId, commit, at, prNumber: thread.pr!.number, route: 'test-then-merge', source: 'jev', questionSet: 'm-v1', packet, calls: [], state: 'verifying', failures: 0, decisionId: null, verificationId, notified: [], verificationRetries: 0 }, 0);
  f.fake.enqueueTurn(async turn => { await turn.bridge('jevellan_thread_report', { status: 'blocked', summary: 'Waiting after interrupted verification.' }); return { status: 'completed' }; }, forThread());
  await f.restart(); await gate(f); expect(second.turnStarts.filter(input => input.owner.kind === 'verification')).toHaveLength(0);
  expect((await f.app.projectWork.mergeRoute('project', thread.id)).records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ state: 'failed', note: 'Verification was interrupted by a restart.', report: null }); expect(f.thread(thread.id).pr?.state).toBe('open');
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
test('a malformed routing packet falls back to ask-owner instead of throwing', async () => {
  const jev = transport('merge');
  void jev;
  await expect(decideMergeRoute(undefined, { ...packet, summary: 'x'.repeat(4001) }, 'jev-latest', new SecretRedactor(), new AbortController().signal)).resolves.toMatchObject({ route: 'ask-owner', source: 'unavailable' });
});
test.each(['merge', 'test-then-merge', 'ask-owner'])('shadow mode records %s without merging or verifying', async choice => {
  const { f, jev, second } = await setup(choice), thread = await published(f); await settings(f, { autoLand: false });
  f.github.setChecks(thread.pr!.number, 'passing'); await gate(f);
  expect((await routes(f, thread.id))[0]?.route).toBe(choice); expect(jev.state.calls).toHaveLength(1);
  expect(second.turnStarts).toHaveLength(0); expect(f.github.requests.some(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toBe(false);
});
test('legacy pull requests no longer require a named workflow check', async () => {
  const { f, jev } = await setup(), thread = await published(f);
  await settings(f); f.github.setChecks(thread.pr!.number, 'passing'); await gate(f);
  expect(jev.state.calls).toHaveLength(1); expect(f.thread(thread.id).pr?.state).toBe('merged');
});
test.each(['stopped', 'failed'] as const)('an author thread that is %s asks the owner even when Jev chooses merge', async state => {
  const { f } = await setup(), thread = await published(f); f.app.projectWork.store.update(thread.id, current => ({ ...current, state, endedAt: new Date().toISOString() }));
  await settings(f); f.github.setChecks(thread.pr!.number, 'passing'); await gate(f);
  expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'ask-owner', state: 'asked' }); expect(f.thread(thread.id).pr?.state).toBe('open');
});
test('send back delivers once and never re-asks the returned head', async () => {
  const { f } = await setup('ask-owner'), thread = await published(f); await settings(f); f.github.setChecks(thread.pr!.number, 'passing'); await gate(f);
  const row = (await routes(f, thread.id))[0]!; let messages = 0;
  f.app.projectWork.mergeGate.o.message = async () => { messages++; };
  const answer = await f.request(`/api/projects/project/decisions/${row.decisionId}/answer`, 'POST', { schema: 'decision-answer-request-v1', clientRequestId: 'send_back_once', optionLabel: 'Send back with a note', text: 'Handle the empty name.' }); expect(answer.status).toBe(202);
  for (let n = 0; n < 5; n++) await gate(f);
  expect(messages).toBe(1); expect((await routes(f, thread.id))[0]?.state).toBe('failed');
});
test('an interrupted verifier retries once without counting a test failure or messaging the author', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  let messages = 0; f.app.projectWork.mergeGate.o.message = async () => { messages++; };
  second.enqueueTurn(async () => ({ status: 'failed', error: { kind: 'other', message: 'Temporary provider failure.' } }), input => input.owner.kind === 'verification');
  second.enqueueTurn(async () => ({ status: 'failed', error: { kind: 'other', message: 'Temporary provider failure again.' } }), input => input.owner.kind === 'verification');
  await settings(f); f.github.setChecks(thread.pr!.number, 'passing'); await gate(f); await gate(f); await gate(f);
  expect(second.turnStarts.filter(input => input.owner.kind === 'verification')).toHaveLength(2);
  expect((await routes(f, thread.id))[0]).toMatchObject({ failures: 0, route: 'ask-owner', state: 'asked' }); expect(messages).toBe(0);
});
test('verification failures that cannot reach the author ask once with attached failures', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  second.enqueueTurn(async turn => { await turn.bridge('jevellan_verification_report', { result: 'failed', commands: ['npm test'], failures: [{ what: 'Broken greeting', output: 'Expected a default.' }] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  let messages = 0; f.app.projectWork.mergeGate.o.message = async () => { messages++; throw new Error('The thread cannot take a message.'); };
  await settings(f); f.github.setChecks(thread.pr!.number, 'passing'); await gate(f); await gate(f); await gate(f);
  expect(messages).toBe(1); expect((await routes(f, thread.id))[0]).toMatchObject({ route: 'ask-owner', state: 'asked' });
  const decision = (await f.app.projectHub.decisions('project')).find(row => row.merge)!;
  expect(JSON.stringify(decision)).toContain('Broken greeting');
});
test('without required checks, an empty check list waits five minutes from first seeing the head', async () => {
  const { f, jev } = await setup(), thread = await published(f); let now = Date.now();
  f.github.setChecks(thread.pr!.number, 'none'); f.app.projectWork.mergeGate.o.now = () => now; await settings(f); await gate(f);
  expect(jev.state.calls).toHaveLength(0); expect(f.thread(thread.id).pr?.state).toBe('open');
  now += 5 * 60_000; await gate(f); expect(f.thread(thread.id).pr?.state).toBe('merged');
});
test('an undelivered coordinator message fences the merge until its turn takes it', async () => {
  const { f } = await setup(), thread = await published(f), at = new Date().toISOString();
  f.app.projectWork.store.update(thread.id, current => ({ ...current, queuedMessages: [{ id: 'pending_coordinator', from: 'coordinator', at, interrupt: false, text: 'Fix the nearby empty case before merging.' }] }));
  await settings(f); f.github.setChecks(thread.pr!.number, 'passing');
  f.app.projectWork.mergeGate.sweep(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).pr?.state).toBe('open');
});
test('five owner-waiting PRs over a simulated hour use fewer than 1000 GitHub requests', { timeout: 300_000 }, async () => {
  let now = Date.now(); const { f } = await setup('ask-owner', true, () => now);
  for (let n = 0; n < 5; n++) {
    commitStep(f, `PR ${n}\n`);
    const started = await f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: `budget_${n}`, title: `Budget PR ${n}`, task: 'Small tested fix.', isolation: 'worktree', modelId: author.id, deviceId: f.app.device.deviceId });
    await f.waitFor(() => f.thread(started.threadId), thread => thread.state === 'in-review' && !!thread.pr); f.github.setChecks(f.thread(started.threadId).pr!.number, 'passing');
  }
  await settings(f); await gate(f); const before = f.github.requests.length;
  for (let minute = 0; minute < 60; minute++) {
    now += 60_000; await f.app.projectWork.tracker.poll();
    for (let sweep = 0; sweep < 6; sweep++) { f.app.projectWork.mergeGate.sweep(); await f.app.projectWork.idle(); }
  }
  expect(f.github.requests.length - before).toBe(900);
});

test('an owner merge after an unfinished automatic attempt emits no automatic-merge event, and concluded gates stop sweeping', async () => {
  const { f } = await setup(), thread = await published(f); await gate(f);
  const route = (await routes(f, thread.id))[0]!;
  await f.app.projectHub.putMergeDocument({ ...route, state: 'merging' }, route.revision);
  const events: string[] = []; f.app.projectWork.mergeGate.o.event = async (_project, event) => { if (event.kind === 'merge-gate') events.push(event.outcome); };
  await f.app.projectWork.tracker.merge(thread.id, thread.pr!.headSha); await gate(f);
  expect(events).not.toContain('automatically-merged');
  const documents = f.app.projectHub.mergeDocuments.bind(f.app.projectHub); let reads = 0;
  f.app.projectHub.mergeDocuments = async (...args) => { reads++; return documents(...args); };
  for (let n = 0; n < 3; n++) { f.app.projectWork.mergeGate.sweep(); await f.app.projectWork.idle(); }
  expect(reads).toBe(0);
  const correction = await f.app.projectWork.mergeCorrection('project', thread.id, { schema: 'merge-correction-input-v1', clientRequestId: 'merged_correction', commit: thread.pr!.headSha, correction: 'should-have-asked' });
  expect(correction.records.some(row => row.schema === 'merge-correction-v1')).toBe(true);
});

test('a low token budget slows PR polling to five minutes and shows a project notice', async () => {
  let now = Date.now(); const { f } = await setup('ask-owner', true, () => now), thread = await published(f); await gate(f);
  const token = await f.app.projectWork.mergeGate.o.github.token('project');
  const probe = new GitHubClient({ token: async () => token, baseUrl: f.github.url, fetch: async url => Response.json(String(url).includes('check-runs') ? { total_count: 0, check_runs: [] } : { total_count: 0, statuses: [] }, { headers: { 'x-ratelimit-remaining': '900', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String((now + 3600_000) / 1000) } }) });
  await probe.checks({ owner: 'fixture', repo: 'repo' }, thread.pr!.headSha);
  const before = f.github.requests.length; now += 60_000; await f.app.projectWork.tracker.poll();
  expect(f.github.requests.length).toBe(before); expect((await f.app.projectWork.views.project('project')).githubNotice).toContain('less than 20%');
  now += 240_000; await f.app.projectWork.tracker.poll(); expect(f.github.requests.length - before).toBe(3);
});

test('verification retries one moved head and asks the owner after a second head move', async () => {
  const { f, second } = await setup('test-then-merge'), thread = await published(f);
  for (let n = 0; n < 2; n++) second.enqueueTurn(async turn => {
    writeFileSync(join(thread.cwd, 'greeting.txt'), `Head moved ${n}\n`); git(thread.cwd, 'add', '-A'); git(thread.cwd, 'commit', '-m', `Head moved ${n}`); git(thread.cwd, 'push', 'origin', thread.branch!);
    await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['test -f greeting.txt'], failures: [] }); return { status: 'completed' };
  }, input => input.owner.kind === 'verification');
  second.enqueueTurn(async turn => { await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['test -f greeting.txt'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  await settings(f); await gate(f); await gate(f); await gate(f);
  expect(second.turnStarts.filter(input => input.owner.kind === 'verification')).toHaveLength(2);
  expect((await routes(f, thread.id)).some(row => row.state === 'asked' && row.failures === 0)).toBe(true); expect(f.thread(thread.id).pr?.state).toBe('open');
});

test('verification setup and the alternate provider receive the explicit check environment', async () => {
  const { f, second } = await setup('test-then-merge');
  await settings(f, { autoLand: false, setupCommand: 'test "$TZ" = UTC && test -n "$PRIVATE_VALUE"', environment: { variables: [{ name: 'TZ', value: 'UTC' }], secrets: ['PRIVATE_VALUE'], copyFiles: [] } });
  await f.app.state.environment.put(f.project.id, 'PRIVATE_VALUE', 'work environment fixture');
  const base = (await f.app.projectWork.settingsView(f.project.id)).settings;
  await f.app.projectHub.putSettings({ ...base, checkEnvironment: { schema: 'project-check-environment-v1', variables: [{ name: 'TZ', value: 'UTC' }], secrets: ['PRIVATE_VALUE'], copyFiles: [] } }, base.revision);
  await f.app.state.environment.put(f.project.id, 'PRIVATE_VALUE', 'verification environment fixture', 'check');
  const thread = await published(f);
  second.enqueueTurn(async turn => { expect(turn.input.launch.projectEnv).toEqual({ TZ: 'UTC', PRIVATE_VALUE: 'verification environment fixture' }); await turn.bridge('jevellan_verification_report', { result: 'passed', commands: ['test "$TZ" = UTC'], failures: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'verification');
  await settings(f); await gate(f);
  const view = await f.app.projectWork.mergeRoute(f.project.id, thread.id);
  expect(view.records.find(row => row.schema === 'verification-run-v1')).toMatchObject({ state: 'passed', providerChoice: 'other-provider' });
});


test('active m-v1 text reaches actual shadow routing with its version and raw choice',async()=>{
 const {f,jev}=await setup(),before=f.app.ownerJev.active('m-v1'),original='Small or low-risk change outside the project\'s risky areas, covered by the checks that passed.',changed='Owned merge criterion from the active version.';expect(before.text).toContain(original);const proposed=await f.app.ownerJev.propose('project','m-v1',{edits:[{find:original,replace:changed}],summary:'Owned merge prompt.'});f.app.ownerJev.apply(proposed.match(/^P[1-9][0-9]*/u)![0]);const thread=await published(f);await settings(f,{autoLand:false});await gate(f);expect(jev.state.calls[0]!.questions.merge_route).toMatchObject({type:'choice',criteria:{merge:changed}});const recorded=(await routes(f,thread.id))[0]!;expect(recorded).toMatchObject({promptVersion:2,rawChoice:'merge',inputsRef:recorded.id});expect(f.thread(thread.id).pr?.state).toBe('open');expect(f.github.requests.some(row=>row.method==='PUT'&&row.path.endsWith('/merge'))).toBe(false);
},90_000);

test('ROUTECTL merge records preserve the exact immutable packet asked of Jev',async()=>{
 const {f,jev}=await setup('ask-owner'),thread=await published(f);await settings(f,{autoLand:false});await gate(f);const row=(await routes(f,thread.id))[0]!;expect(row).toMatchObject({inputPacket:JSON.parse(jev.state.calls[0]!.state)});await expect(f.app.projectHub.putMergeDocument({...row,inputPacket:{...row.packet,title:'Replacement packet'}},row.revision)).rejects.toThrow(/immutable/u);
},90_000);
test('ROUTECTL actual merge routing applies owner route clamps before its existing guards',async()=>{
 const {f}=await setup('merge'),rule=await f.app.ownerJev.saveRule('project',{set:{landingRoute:'ask-owner'}}),thread=await published(f);await settings(f,{autoLand:false});await gate(f);expect((await routes(f,thread.id))[0]).toMatchObject({rawChoice:'merge',route:'ask-owner',rulesApplied:[rule.id]});expect(f.thread(thread.id).pr?.state).toBe('open');expect(f.github.requests.some(row=>row.method==='PUT'&&row.path.endsWith('/merge'))).toBe(false);
},90_000);
test('ROUTECTL m-v1 replays its stored packet and saves a report without merging the pull request',async()=>{
 const {f,jev}=await setup('ask-owner'),thread=await published(f);await settings(f,{autoLand:false});await gate(f);const before=structuredClone(f.thread(thread.id)),calls=jev.state.calls.length,head=git(f.origin,'rev-parse','main');jev.state.route='merge';const proposed=await f.app.ownerJev.propose('project','m-v1',{edits:[{find:'Small or low-risk change',replace:'Small and covered change'}],summary:'Owned route replay.'});expect(jev.state.calls.length-calls).toBe(1);expect(proposed).toContain('Replay on the last 1 decisions that used m-v1: 1 would change.');const proposal=f.app.ownerJev.proposals().find(row=>row.id===proposed.match(/^P[1-9][0-9]*/u)![0])!;expect(proposal.replayReportId).toBeDefined();expect(f.app.ownerJev.replayReport('project',proposal.replayReportId!)).toMatchObject({questionSet:'m-v1',selected:1,compared:1,changed:1,evidence:'simulated'});expect(f.app.ownerJev.active('m-v1').version).toBe(1);expect(f.thread(thread.id)).toEqual(before);expect(git(f.origin,'rev-parse','main')).toBe(head);expect(f.github.requests.some(row=>row.method==='PUT'&&row.path.endsWith('/merge'))).toBe(false);
},90_000);

test('LESSONPOL5 actual merge input receives scoped lessons and each decision counts once',async()=>{
 const {f,jev}=await setup('ask-owner'),lesson=f.app.ownerJev.addLesson('project',{about:'landing',source:'owner',text:'Owned merge lesson.'}),thread=await published(f);await settings(f,{autoLand:false});await gate(f);
 expect(JSON.parse(jev.state.calls[0]!.state)).toMatchObject({corrections:[lesson.text],lessons:{schema:'jev-lesson-input-v1',heading:"Lessons from the owner's overrides",items:[{id:lesson.id,key:lesson.key,text:lesson.text}]}});
 expect((await routes(f,thread.id))[0]).toMatchObject({lessons:[lesson.id]});expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);
 await gate(f);expect(jev.state.calls).toHaveLength(1);expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(1);expect(f.thread(thread.id).pr?.state).toBe('open');
},90_000);


test('LESSONUSE4 newest thirty lessons and the separate last eight landing corrections retain every input use',async()=>{
 const {f,jev}=await setup('ask-owner'),rows=Array.from({length:38},(_,n)=>JevLessonSchema.parse({schema:'jev-lesson-v1',key:'separate_lesson_'+n,id:'L'+(100+n),scope:'project',projectId:'project',about:n<8?'landing':'placement',text:'Separate input lesson '+n,source:'owner',enabled:true,timesApplied:0,createdAt:new Date(Date.UTC(2026,0,1,0,0,n)).toISOString()}));for(const row of rows)f.app.hub.put('owner-jev-lessons',row.key,JevLessonSchema,row,0);
 const thread=await published(f);await settings(f,{autoLand:false});await gate(f);const packet=JSON.parse(jev.state.calls[0]!.state) as {corrections:string[];lessons:{items:Array<{key:string}>}};expect(packet.lessons.items.map(row=>row.key)).toEqual(rows.slice(8).reverse().map(row=>row.key));expect(packet.corrections).toEqual(rows.slice(0,8).reverse().map(row=>row.text));expect((await routes(f,thread.id))[0]!.lessons).toHaveLength(38);for(const row of rows)expect(f.app.hub.get('owner-jev-lessons',row.key,JevLessonSchema)?.document.timesApplied).toBe(1);
},90_000);

test('LESSONUSE5 an unusable merge answer is not a raw Jev choice or a counted lesson use',async()=>{
 const {f}=await setup('ask-owner'),lesson=f.app.ownerJev.addLesson('project',{about:'landing',source:'owner',text:'Owned unusable-answer contract.'});let calls=0;
 f.app.projectWork.mergeGate.o.decisionClient=()=>({decide:async()=>{calls++;return{schema:'jev-response-v1',model:'fixture',usage:{input_tokens:1,output_tokens:1},answers:{}};}});
 const thread=await published(f);await settings(f,{autoLand:false});await gate(f);const row=(await routes(f,thread.id))[0]!;
 expect(row.source).toBe('unavailable');expect(row.calls.length).toBeGreaterThan(0);expect(row.rawChoice).toBeUndefined();expect(f.app.ownerJev.lessons('project').find(row=>row.key===lesson.key)?.timesApplied).toBe(0);
 await expect(f.app.projectHub.putMergeDocument({...row,rawChoice:'merge'},row.revision)).rejects.toThrow(/immutable/u);
 const before=calls,proposed=await f.app.ownerJev.propose('project','m-v1',{edits:[{find:'Small or low-risk change',replace:'Small owned usable change'}],summary:'Owned unusable source control.'}),proposal=f.app.ownerJev.proposals().find(row=>row.id===proposed.match(/^P[1-9][0-9]*/u)![0])!,summary=f.app.ownerJev.replayReport('project',proposal.replayReportId!);
 expect(calls).toBe(before);expect(summary).toMatchObject({selected:0,compared:0,changed:0});expect(summary.text).toContain('Skipped source records without a usable original Jev answer: 1.');expect(f.thread(thread.id).pr?.state).toBe('open');
},90_000);
