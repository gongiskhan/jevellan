import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountSchema, ComposerInitialSchema, ComposerOverrideRecordSchema, ConversationPublicSchema, CorrectionRecordSchema, Homes, JevConnectionSchema, ProjectSchema, type Action } from '../packages/core/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { FakeRuntime, type StretchInput } from '../packages/runtime-contract/dist/index.js';
import { ConversationWork, RESTART_NOTICE } from '../packages/conversations/dist/index.js';
import { HubUnavailable } from '../packages/mesh/dist/index.js';
import type { JevQuestions } from '../packages/decisions/dist/index.js';

let root: string; let path: string; let origin: string; let initial: string; let app: Application; let fake: FakeRuntime; let server: Server; let base: string; let cookie: string;
let actions: Action[]; let calls: { state: Record<string, unknown>; questions: JevQuestions }[];
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Wire = { model: string; state: string; questions: JevQuestions };
function answer(body: Wire, action?: Action) {
  return Response.json({ model: 'jev-fixture-returned', usage: { input_tokens: 20, output_tokens: 10 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'keep_current' ? 0.9 : 0 }];
    if (question.type === 'score') return [id, { type: 'score', score: 3, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 }, legend: { '0': 'not useful', '1': 'marginally useful', '2': 'useful', '3': 'essential' }, confidence: 1 }];
    const choice = id === 'next_action' ? action : id === 'effort' ? 'high' : Object.keys(question.criteria)[0];
    if (!choice || !Object.hasOwn(question.criteria, choice)) throw new Error(`Invalid simulated choice for ${id}: ${choice}`);
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])), confidence: 1 }];
  })) });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-auto-')); mkdirSync(join(root, 'user'));
  origin = join(root, 'origin.git'); path = join(root, 'project'); git(root, 'init', '--bare', '-b', 'main', origin); git(root, 'clone', origin, path);
  git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid'); writeFileSync(join(path, 'value.txt'), '1\n');
  git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed'); git(path, 'push', '-u', 'origin', 'main'); initial = git(path, 'rev-parse', 'HEAD');
  calls = []; actions = ['implement', 'done'];
  transport = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init!.body)) as Wire; calls.push({ state: JSON.parse(body.state), questions: body.questions }); return answer(body, body.questions.next_action ? actions.shift() : undefined); });
  fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true;
  app = new Application({ homes: new Homes(join(root, 'data'), join(root, 'user')), timers: false, runtimes: () => new Map([['fake', fake]]), decisionFetch: transport }); await app.conversations.ready;
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].runtimes.fake = { enabled: true };
  config.configuration['x-jevellan'].menu = [{ id: 'fixture', runtime: 'fake', model: 'scripted', label: 'Fixture', description: 'Simulated model.', efforts: ['high'], enabled: true }];
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.vault.put('jev', `fixture-${randomUUID()}`);
  app.hub.put('accounts', 'test_account', AccountSchema, AccountSchema.parse({ schema: 'account-v1', id: 'test_account', runtime: 'fake', label: 'Test account', kind: 'subscription', enabled: true, credential: 'per-device' }), 0); await app.accounts.check('test_account');
  await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Automatic fixture', paths: { [app.device.deviceId]: path }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
  server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'disposable automatic fixture' }) });
  expect(auth.status).toBe(200); cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => { await app.close(); await fake.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
async function request(route: string, body: unknown) { return fetch(`${base}${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
async function create(message = 'Change value to two.', choices?: ReturnType<typeof ComposerInitialSchema.parse>) {
  const result = await request('/api/conversations', { schema: 'start-conversation-v1', id: 'automatic', projectId: 'project', title: 'Automatic', message, clientMessageId: 'first', ...(choices ? { choices } : {}) });
  expect(result.status).toBe(201); return ConversationPublicSchema.parse(await result.json());
}
async function handoff(input: StretchInput, extra: Record<string, unknown> = {}) {
  const result = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
    schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'Finished the simulated step.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [], ...extra,
  } }) }); expect(result.status, await result.text()).toBe(200);
}
function enqueue(value?: string, extra: Record<string, unknown> = {}) {
  fake.enqueue(async ({ input, emit }) => { if (value !== undefined) writeFileSync(join(input.cwd, 'value.txt'), `${value}\n`); emit({ type: 'text', delta: 'Simulated response.' }); await handoff(input, extra); return { status: 'completed' }; });
}
const view = async () => (await app.conversations.view('automatic'));
async function finished() { await app.conversations.wait('automatic'); return (await view()); }

test('automatic implementation decides, runs, independently verifies and publishes without a manual choice', async () => {
  enqueue('2', { testsRun: { command: 'agent claim', passed: true, summary: 'Not the daemon receipt.' } });
  expect((await create()).busy).toBe(true); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts).toHaveLength(1);
  expect(result.decisions.map((decision) => decision.action.chosen)).toEqual(['implement', 'done']);
  expect(result.decisions[0]).toMatchObject({ action: { source: 'jev' }, model: { source: 'only-option' }, effort: { source: 'jev' }, questionSet: 'q-v2', jev: { returnedModel: 'jev-fixture-returned', calls: 2 } });
  expect(result.decisions[0]!.latestMessageEventId).toBe(result.messages[0]!.id);
  expect(result.decisions[0]!.jev!.records!.map((call) => call.kind)).toEqual(['action', 'model']);
  expect(calls).toHaveLength(3); expect(calls[0]!.questions.remember_request).toBeDefined(); expect(calls[2]!.questions.remember_request).toBeUndefined();
  expect((await app.conversations.changes('automatic', 1)).verifications).toEqual(expect.arrayContaining([expect.objectContaining({ passed: true, treeClean: true })]));
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
}, 60_000);

test('read-only Reply closes through Jev Done without changing Git or adding another closing summary', async () => {
  actions = ['reply', 'done']; enqueue(); await create('What does value.txt contain?'); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts[0]!.permissions).toBe('read-only');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  expect(app.conversations.ledger('automatic').events().filter((event) => event.type === 'notice' && (event.data as { kind?: string }).kind === 'closing')).toEqual([]);
});

test('a repository update gets shell access after the owned fast-forward without creating a checkpoint', async () => {
  const upstreamPath = join(root, 'upstream'); git(root, 'clone', origin, upstreamPath);
  writeFileSync(join(upstreamPath, 'upstream.txt'), 'Updated upstream\n'); git(upstreamPath, 'add', '-A'); git(upstreamPath, 'commit', '-m', 'Upstream'); git(upstreamPath, 'push');
  const upstream = git(upstreamPath, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => {
    expect(input.action).toBe('implement'); expect(input.permissions).toBe('write');
    expect(git(input.cwd, 'rev-parse', 'HEAD')).toBe(upstream);
    expect(readFileSync(join(input.cwd, 'upstream.txt'), 'utf8')).toBe('Updated upstream\n');
    await handoff(input, { summary: 'Confirmed the upstream update.' }); return { status: 'completed' };
  });
  await create('git pull'); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(fake.starts).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(upstream);
  expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(git(path, 'status', '--porcelain')).toBe('');
});

test('an unfinished reply can hand execution to implement without asking the user again', async () => {
  actions = ['reply', 'implement', 'done'];
  enqueue(undefined, { status: 'partial', summary: 'The requested command needs execution tools.', proposedNext: 'implement' });
  enqueue(); await create('Run the requested project command.'); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(fake.starts.map(input => input.permissions)).toEqual(['read-only', 'write']);
  expect(result.decisions.map(decision => decision.action.chosen)).toEqual(['reply', 'implement', 'done']);
});

test('failed independent verification reaches the next Jev state and is repaired before publication', async () => {
  actions = ['implement', 'done', 'implement', 'done'];
  enqueue('0', { testsRun: { command: 'agent claim', passed: true, summary: 'Claims a pass.' } }); enqueue('2');
  await create(); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts).toHaveLength(2);
  const actionStates = calls.filter((call) => call.questions.next_action).map((call) => call.state);
  expect(actionStates[2]).toMatchObject({ facts: { lastVerification: 'failed' }, conversation: { recentHandoffs: [expect.objectContaining({ testsRun: { passed: true } })] } });
  expect((await app.conversations.changes('automatic', 2)).verifications.map((receipt) => receipt.passed)).toEqual([false, true]);
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
}, 60_000);

test('a freeform follow-up reaches Jev with its question and preserves blocker evidence', async () => {
  actions = ['ask-you']; enqueue(undefined, { question: 'What would you like changed?', blockers: ['The requested change is unspecified.'] }); await create('Change something.');
  expect((await finished()).conversation.state).toBe('waiting-for-you');
  actions = ['implement', 'done']; enqueue('2');
  const sent = await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'answer', text: 'You choose.', kind: 'message' }); expect(sent.status).toBe(200);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  const [asking, answered] = calls.filter((call) => call.questions.next_action).map((call) => call.state as { conversation: { questionBeforeLatestMessage?: string; latestUserMessage: string; summary: { nextWork: string }; recentHandoffs: { blockers: string[] }[] } });
  expect(asking!.conversation.questionBeforeLatestMessage).toBeUndefined();
  expect(answered!.conversation).toMatchObject({ questionBeforeLatestMessage: 'What would you like changed?', latestUserMessage: 'You choose.' });
  expect(answered!.conversation.recentHandoffs.at(-1)!.blockers).toEqual(['The requested change is unspecified.']);
}, 60_000);

test('Ask you after an answer writes a new question instead of re-posting the answered one', async () => {
  actions = ['ask-you']; enqueue(undefined, { question: 'Which README should change?' }); await create('Change the README.');
  expect((await finished()).pause?.reason).toBe('Which README should change?'); expect(fake.starts).toHaveLength(1);
  actions = ['ask-you']; enqueue(undefined, { question: 'Shall I add a short project summary to packaging/README.md?' });
  expect((await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'answer', text: 'anything', kind: 'message' })).status).toBe(200);
  const result = await finished();
  expect(fake.starts).toHaveLength(2); expect(fake.starts[1]).toMatchObject({ action: 'reply', permissions: 'read-only' });
  expect(result.pause?.reason).toBe('Shall I add a short project summary to packaging/README.md?');
});

test('offered answers show as options, a picked one reaches Jev as the chosen answer, and stale picks are refused', async () => {
  const options = [{ label: 'Yes, add an Overview section to README.md' }, { label: 'No, edit the install notes instead', detail: 'Only the Install heading changes.' }];
  actions = ['ask-you']; enqueue(undefined, { question: 'Shall I add an Overview section to README.md?', options }); await create('Change the README.');
  const asked = await finished(); expect(asked.openQuestion).toEqual({ stretch: 1, text: 'Shall I add an Overview section to README.md?', options });
  const pick = (option: number, text: string, clientMessageId = `pick_${option}`) => request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId, text, kind: 'message', answer: { stretch: 1, option } });
  expect((await pick(0, 'Something else')).status).toBe(400);
  actions = ['implement', 'done']; enqueue('2');
  expect((await pick(0, options[0]!.label)).status).toBe(200);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(result.openQuestion).toBeUndefined();
  expect(result.messages.at(-1)!.answer).toEqual({ stretch: 1, option: 0, label: options[0]!.label });
  const answered = calls.filter((call) => call.questions.next_action).at(1)!.state as { conversation: Record<string, unknown> };
  expect(answered.conversation).toMatchObject({ questionBeforeLatestMessage: 'Shall I add an Overview section to README.md?', offeredAnswers: options.map((option) => option.label), chosenAnswer: options[0]!.label });
  expect((await pick(1, options[1]!.label, 'late')).status).toBe(409);
}, 60_000);

test('options without a question are refused at handoff', async () => {
  actions = ['reply']; fake.enqueue(async ({ input }) => {
    const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
      schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'Options only.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [], options: [{ label: 'A' }, { label: 'B' }] } }) });
    expect(await response.text()).toContain('Answer options need a question'); await handoff(input); return { status: 'completed' };
  });
  await create('Explain it.'); await finished();
});

test('Ask you uses a read-only question stretch, then waits without scheduling another action', async () => {
  actions = ['ask-you']; enqueue(undefined, { question: 'Which behavior should change?' }); await create('Change something.'); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('waiting-for-you'); expect(result.pause?.reason).toBe('Which behavior should change?');
  expect(fake.starts[0]).toMatchObject({ action: 'reply', permissions: 'read-only' }); expect(result.decisions[0]!.action.chosen).toBe('ask-you'); expect(calls).toHaveLength(2);
});

test('a guard stops at the stretch boundary before another Jev call', async () => {
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].guards.maxStretchesPerWork = 2;
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  actions = ['reply', 'reply', 'done']; enqueue(); enqueue(); await create('Explain two things.'); const result = await finished();
  expect(result.pause).toMatchObject({ guard: 'steps' }); expect(fake.starts).toHaveLength(2);
  expect(calls.filter((call) => call.questions.next_action)).toHaveLength(2); expect(actions).toEqual(['done']);
});

test('after a reply to a no-progress stop, Jev answers it with a reply step and finishes with Done', async () => {
  actions = ['implement', 'implement', 'implement', 'reply', 'done']; enqueue('2'); enqueue(); enqueue(); await create();
  const stopped = await finished(); expect(stopped.pause).toMatchObject({ guard: 'no-progress' }); expect(fake.starts).toHaveLength(3); expect(actions).toEqual(['reply', 'done']);
  enqueue(); const sent = await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'finish', text: 'Nothing else needs to change. Finish.', kind: 'message' }); expect(sent.status).toBe(200);
  const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts.map((step) => step.action)).toEqual(['implement', 'implement', 'implement', 'reply']);
  expect(result.decisions.map((decision) => decision.action.chosen)).toEqual(['implement', 'implement', 'implement', 'reply', 'done']); expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD'));
}, 60_000);

test('a stale in-flight classification is discarded after a new user message', async () => {
  let release!: () => void;
  transport.mockImplementationOnce(async (_url, init) => { const body = JSON.parse(String(init!.body)) as Wire; calls.push({ state: JSON.parse(body.state), questions: body.questions }); return new Promise<Response>((resolve) => { release = () => resolve(answer(body, 'implement')); }); });
  actions = ['reply', 'done']; enqueue(); await create(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const response = await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'changed', text: 'Only explain it. Do not edit.', kind: 'message' }); expect(response.status).toBe(200);
  release(); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts.map((step) => step.action)).toEqual(['reply']); expect(result.decisions.map((decision) => decision.action.chosen)).toEqual(['reply', 'done']);
  expect(calls[1]!.state).toMatchObject({ conversation: { latestUserMessage: 'Only explain it. Do not edit.' } }); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
});

test('no eligible account waits with account-specific reasons and no runtime launch', async () => {
  const account = await app.accounts.get('test_account'); await app.accounts.update('test_account', { schema: 'update-account-v1', revision: account.revision, label: account.account.label, ceilingPct: account.account.ceilingPct, enabled: false });
  await create(); const result = await finished();
  expect(result.decisionWait).toMatchObject({ kind: 'no-eligible-model', reasons: [{ modelId: 'fixture', reason: 'disabled', accountIds: ['test_account'] }] });
  expect(result.conversation.state).toBe('waiting-for-you'); expect(fake.starts).toHaveLength(0); expect(calls).toHaveLength(1);
});

test('authentication failure exposes the manual picker and manual records keep the failure notice', async () => {
  transport.mockImplementation(async () => new Response('Private provider body is not evidence.', { status: 401 }));
  await create(); let result = await finished(); expect(result.pause?.reason).toBe('Jev is unavailable (authentication failed). Pick the next step:'); expect(fake.starts).toHaveLength(0);
  enqueue('2'); const chosen = await request('/api/conversations/automatic/manual', { schema: 'manual-step-v1', generation: result.conversation.generation, action: 'implement', modelId: 'fixture', effort: 'high' }); expect(chosen.status).toBe(202);
  result = await finished(); expect(result.decisions[0]).toMatchObject({ action: { source: 'manual' }, model: { source: 'manual' }, effort: { source: 'manual' }, notices: [{ kind: 'jev-unavailable', text: 'Jev is unavailable (authentication failed). Pick the next step:' }] });
  expect(JSON.stringify(app.conversations.ledger('automatic').events())).not.toContain('Private provider body');
});

test('missing Jev key waits immediately without any HTTP call or heuristic action', async () => {
  app.hub.db.prepare('DELETE FROM secrets WHERE id=?').run('jev');
  const result = await create(); expect(result.busy).toBe(false); expect(result.pause?.reason).toBe('Jev is unavailable (no key configured). Pick the next step:');
  expect(transport).not.toHaveBeenCalled(); expect(fake.starts).toHaveLength(0); expect(result.decisions).toEqual([]);
});

test('a paused decision resumes after saving a key without creating another user message', async () => {
  app.hub.db.prepare('DELETE FROM secrets WHERE id=?').run('jev');
  const waiting = await create(); app.hub.vault.put('jev', `fixture-${randomUUID()}`); enqueue('2');
  const stale = await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: waiting.conversation.generation + 1 }); expect(stale.status).toBe(409);
  expect(fake.starts).toHaveLength(0);
  const resumed = await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: waiting.conversation.generation }); expect(resumed.status).toBe(202);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(result.messages).toHaveLength(1); expect(result.decisions[0]!.trigger).toBe('resume');
  expect((await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: result.conversation.generation })).status).toBe(409);
}, 60_000);

test('decision retry cannot bypass a guard that stopped the work', async () => {
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].guards.maxStretchesPerWork = 1;
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.db.prepare('DELETE FROM secrets WHERE id=?').run('jev'); const waiting = await create();
  app.hub.vault.put('jev', `fixture-${randomUUID()}`); actions = ['reply', 'done']; enqueue();
  expect((await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: waiting.conversation.generation })).status).toBe(202);
  const stopped = await finished(); expect(stopped.pause?.guard).toBe('steps'); const called = transport.mock.calls.length;
  expect((await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: stopped.conversation.generation })).status).toBe(409);
  expect(transport).toHaveBeenCalledTimes(called); expect(fake.starts).toHaveLength(1);
});

test('cancelling an in-flight Jev request never launches or records its late classification', async () => {
  let release!: () => void; let signal: AbortSignal | undefined;
  transport.mockImplementationOnce(async (_url, init) => { signal = init!.signal ?? undefined; const body = JSON.parse(String(init!.body)) as Wire; return new Promise<Response>((resolve) => { release = () => resolve(answer(body, 'implement')); }); });
  await create(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const cancelled = app.conversations.cancel('automatic'); await vi.waitFor(() => expect(signal?.aborted).toBe(true)); release(); await cancelled;
  expect((await view()).conversation.state).toBe('cancelled'); expect((await view()).decisions).toEqual([]); expect(fake.starts).toEqual([]); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
});

test('plan approval resumes automatic execution with the full plan in the next brief', async () => {
  expect(app.hub.configuration.current()!.configuration['x-jevellan'].guards.pauseAfterPlan).toBe(true);
  actions = ['plan', 'implement', 'done'];
  fake.enqueue(async ({ input }) => { await handoff(input, { result: { type: 'plan', content: 'First preserve the default. Then change the value to two. Finally verify the exact commit.' }, proposedNext: 'implement' }); return { status: 'completed' }; });
  enqueue('2'); await create(); const waiting = await finished(); expect(waiting.pause?.reason).toContain('Read the full plan'); expect(fake.starts).toHaveLength(1);
  const approved = await request('/api/conversations/automatic/approve-plan', { schema: 'plan-approval-v1', generation: waiting.conversation.generation, ref: waiting.conversation.work!.latestPlanRef }); expect(approved.status).toBe(200);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts).toHaveLength(2);
  expect(fake.starts[1]!.brief).toContain('Finally verify the exact commit.');
}, 60_000);

test('pending plans allow discussion and explicit revisions but never implementation or completion before approval', async () => {
  actions = ['plan'];
  enqueue(undefined, { result: { type: 'plan', content: { goal: 'Change the value', steps: ['Preserve the default', 'Set value to two'] } }, proposedNext: 'implement' });
  await create(); let waiting = await finished();
  const originalPlan = waiting.conversation.work!.latestPlanRef!;
  const originalGeneration = waiting.conversation.generation;
  expect(waiting.allowed).toEqual(['reply', 'plan', 'ask-you']);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  await expect(app.conversations.manual('automatic', { schema: 'manual-step-v1', generation: originalGeneration, action: 'implement', modelId: 'fixture' })).rejects.toThrow('not allowed');
  await expect(app.conversations.resumeDecision('automatic', { schema: 'resume-decision-v1', generation: originalGeneration })).rejects.toThrow();
  actions = ['reply']; enqueue();
  await app.conversations.message('automatic', { schema: 'conversation-message-v1', clientMessageId: 'discuss', text: 'Explain why this approach works.' });
  waiting = await finished();
  expect(fake.starts.map(start => start.action)).toEqual(['plan', 'reply']);
  expect(waiting.conversation.state).toBe('waiting-for-you');
  expect(waiting.conversation.work!.approvedPlanRef).toBeUndefined();
  enqueue(undefined, { result: { type: 'plan', content: '## Goal\nChange the value.\n\n## Steps\n1. Preserve the default.\n2. Update the value.\n3. Add regression coverage.' } });
  const revision = { schema: 'conversation-message-v1', clientMessageId: 'revision', text: 'Add regression coverage.', planChange: { ref: originalPlan, generation: waiting.conversation.generation } };
  await app.conversations.message('automatic', revision); waiting = await finished();
  expect(fake.starts.map(start => start.action)).toEqual(['plan', 'reply', 'plan']);
  expect(fake.starts[2]!.brief).toContain('Add regression coverage.');
  expect(waiting.conversation.work!.latestPlanRef).not.toBe(originalPlan);
  expect(waiting.conversation.work!.approvedPlanRef).toBeUndefined();
  await app.conversations.message('automatic', revision); await finished();
  expect(fake.starts).toHaveLength(3); expect((await view()).messages).toHaveLength(3);
  await expect(app.conversations.approvePlan('automatic', { schema: 'plan-approval-v1', generation: originalGeneration, ref: originalPlan })).rejects.toThrow('stale');
  actions = ['implement', 'done']; enqueue('2');
  await app.conversations.approvePlan('automatic', { schema: 'plan-approval-v1', generation: waiting.conversation.generation, ref: waiting.conversation.work!.latestPlanRef });
  const done = await finished(); expect(done.conversation.state, done.pause?.reason).toBe('done');
  expect(fake.starts[3]!.brief).toContain('(approved)');
}, 60_000);

test('actual project memory is scored once and the chosen unresolved note reaches the runtime brief', async () => {
  mkdirSync(join(path, '.jevellan/memory'), { recursive: true });
  writeFileSync(join(path, '.jevellan/memory/Vitest.md'), '---\ntitle: Vitest conventions\ntype: note\npermalink: conventions/vitest\nstatus: unresolved\n---\n\nUse Vitest globals for project tests.\n');
  git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed project memory'); git(path, 'push');
  actions = ['reply', 'done']; enqueue(); await create('Explain the Vitest conventions for tests.'); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(result.decisions[0]!.memory).toMatchObject({ source: 'jev', chosen: ['conventions/vitest'], scores: { 'conventions/vitest': 3 } });
  expect(fake.starts[0]!.brief).toContain('Vitest conventions (conflicting versions, unresolved)');
  expect(calls.filter((call) => Object.keys(call.questions).some((key) => key.startsWith('memory_')))).toHaveLength(1);
  expect(result.decisions[0]!.jev!.records!.map((call) => call.kind)).toEqual(['action', 'model', 'memory']);
}, 60_000);

test('a classified remember Reply writes only project memory and publishes without claiming code verification', async () => {
  actions = ['reply', 'done'];
  transport.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as Wire; calls.push({ state: JSON.parse(body.state), questions: body.questions });
    const value = await answer(body, body.questions.next_action ? actions.shift() : undefined).json() as { answers: Record<string, unknown> };
    if (body.questions.remember_request) value.answers.remember_request = { type: 'noul', noul: 0.95 };
    return Response.json(value);
  });
  fake.enqueue(async ({ input }) => {
    expect(input).toMatchObject({ action: 'reply', permissions: 'read-only', memoryWrite: true });
    const saved = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'memory_write', arguments: { title: 'Testing convention', content: 'Use Vitest globals for project tests.' } }) });
    expect(saved.status, await saved.text()).toBe(200); await handoff(input); return { status: 'completed' };
  });
  await create('Remember that we use Vitest globals for tests.'); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(result.decisions[0]!.remember).toBe(true);
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
  expect((await app.conversations.changes('automatic', 1)).verifications).toEqual([]);
}, 60_000);

test('Settings connection check uses the saved vault key and accepts an alias-only model listing', async () => {
  transport.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return Response.json({ models: [{ name: 'jev-latest', description: 'Current alias.', release_date: '2026-09-22' }] }); });
  const response = await request('/api/decisions/check', { schema: 'empty-request-v1' }); expect(response.status).toBe(200);
  const result = JevConnectionSchema.parse(await response.json()); expect(result).toMatchObject({ status: 'connected', availableModels: ['jev-latest'] });
  expect(result.latencyMs).toBeGreaterThanOrEqual(20);
  const [url, init] = transport.mock.calls[0]!; expect(url).toBe('https://api.typesafe.ai/v1/models'); expect(init!.method).toBe('GET'); expect(init!.body).toBeUndefined();
  expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer ${app.hub.vault.forLaunch('jev')}`);
  expect(JSON.stringify(result)).not.toContain(app.hub.vault.forLaunch('jev'));
  transport.mockResolvedValueOnce(new Response('Private failed connection body.', { status: 401 }));
  const failed = await request('/api/decisions/check', { schema: 'empty-request-v1' }); expect(JevConnectionSchema.parse(await failed.json())).toMatchObject({ status: 'unavailable', reason: 'authentication failed' });
});

test('undo and redo returns to automatic decisions with the correction and without the undone handoff', async () => {
  actions = ['implement', 'ask-you', 'done']; enqueue('2', { question: 'Should this be a read-only answer instead?' });
  await create(); const waiting = await finished(); expect(waiting.conversation.state).toBe('waiting-for-you');
  enqueue(undefined, { summary: 'The requested read-only answer.' });
  const corrected = await request('/api/conversations/automatic/correct', { schema: 'correct-step-v1', clientRequestId: 'redo_reply', generation: waiting.conversation.generation, stretch: 1, mode: 'redo', choices: { action: 'reply' } }); expect(corrected.status).toBe(202);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(result.stretches.map((step) => [step.action, step.status])).toEqual([['implement', 'undone'], ['reply', 'completed']]);
  expect(result.redos.at(-1)?.status).toBe('completed'); expect(fake.starts).toHaveLength(2); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  expect(result.decisions.at(-1)!.correctionsShown).toEqual([result.overrides[0]!.id]);
  expect(calls.at(-1)!.state).toMatchObject({ rules: { recentCorrections: [expect.stringContaining('reply')] }, conversation: { recentHandoffs: [expect.objectContaining({ summary: 'The requested read-only answer.' })] }, facts: { stretchesThisWork: 1, codeChangedThisWork: false } });
  expect(JSON.stringify(calls.at(-1)!.state)).not.toContain('Should this be a read-only answer instead?');
}, 60_000);

test('publication conflict forces Integrate and asks Jev only for its model and effort', async () => {
  const project = (await app.conversations.projects()).projects[0]!;
  await app.conversations.saveProject({ schema: 'project-write-v1', revision: project.revision, project: { ...project.project, testCommand: 'test "$(cat value.txt)" -ge 2' } });
  const decide = transport.getMockImplementation()!; let upstreamAdvanced = false;
  transport.mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init!.body)) as Wire; const state = JSON.parse(body.state) as { facts: { stretchesThisWork: number } };
    // Advance another checkout after implementation has settled, before the Done gate.
    if (body.questions.next_action && state.facts.stretchesThisWork === 1 && !upstreamAdvanced) {
      upstreamAdvanced = true; const other = join(root, 'upstream'); git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Other fixture'); git(other, 'config', 'user.email', 'other@example.invalid');
      writeFileSync(join(other, 'value.txt'), '3\n'); writeFileSync(join(other, 'upstream.txt'), 'Keep upstream work.\n');
      git(other, 'add', '-A'); git(other, 'commit', '-m', 'Upstream contribution'); git(other, 'push');
    }
    return decide(url, init);
  });
  enqueue('2');
  fake.enqueue(async ({ input }) => {
    expect(input).toMatchObject({ action: 'integrate', permissions: 'write' });
    const integration = async (command: 'start' | 'continue') => {
      const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_integrate', arguments: { schema: 'integration-command-v1', command } }) });
      expect(response.status).toBe(200); return response.json();
    };
    expect(await integration('start')).toMatchObject({ result: { status: 'conflict', conflicts: ['value.txt'] } });
    writeFileSync(join(path, 'value.txt'), '5\n'); expect(await integration('continue')).toMatchObject({ result: { status: 'clean', conflicts: [] } });
    await handoff(input); return { status: 'completed' };
  });
  await create(); const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(fake.starts.map((step) => step.action)).toEqual(['implement', 'integrate']);
  expect(result.decisions.at(-1)).toMatchObject({ action: { chosen: 'integrate', source: 'guard' }, effort: { source: 'jev' }, jev: { calls: 1, records: [{ kind: 'model' }] } });
  const conflictCalls = calls.filter((call) => (call.state.facts as { publicationConflict: boolean }).publicationConflict); expect(conflictCalls).toHaveLength(1); expect(conflictCalls[0]!.questions.next_action).toBeUndefined();
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main')); expect(git(origin, 'show', 'main:value.txt')).toBe('5'); expect(git(origin, 'show', 'main:upstream.txt')).toBe('Keep upstream work.');
  expect((await app.conversations.changes('automatic', 2)).verifications).toContainEqual(expect.objectContaining({ trigger: 'publication', passed: true, treeClean: true }));
}, 60_000);

async function composer(field: 'action' | 'model' | 'effort', value: string | null, mode: 'once' | 'pin' = 'once') {
  const input = { schema: 'composer-choice-v1', clientRequestId: randomUUID(), generation: (await view()).conversation.generation, field, value, mode };
  const response = await request('/api/conversations/automatic/choices', input); expect(response.status, await response.text()).toBe(200); return input;
}

test('initial composer choices run once and bind their actual decision without fabricated Jev answers', async () => {
  actions = ['done']; enqueue();
  const choices = ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: { action: 'reply', modelId: 'fixture', effort: 'low' }, pins: {} });
  await create('Explain the value.', choices); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(result.conversation.once).toEqual({}); expect(result.conversation.pins).toEqual({});
  expect(result.decisions[0]).toMatchObject({ action: { chosen: 'reply', source: 'override' }, model: { source: 'override' }, effort: { requested: 'low', effective: 'high', source: 'override' } });
  expect(calls[0]!.questions.next_action).toBeUndefined(); expect(calls[0]!.questions.remember_request).toBeDefined(); expect(calls.some((call) => call.questions.effort)).toBe(false);
  expect(result.composerOverrides).toHaveLength(3); expect(result.composerOverrides.every((record) => record.status === 'applied' && record.stretch === 1 && record.decisionId === result.decisions[0]!.id)).toBe(true);
  expect(result.decisions.at(-1)!.correctionsShown).toHaveLength(3);
  expect(app.hub.list('overrides', CorrectionRecordSchema)).toHaveLength(3);
  const ids = result.composerOverrides.map((record) => record.id).join(',');
  expect((await fetch(`${base}/hub/overrides?ids=${ids}`)).status).toBe(401);
  const indexed = await fetch(`${base}/hub/overrides?ids=${ids}`, { headers: { Cookie: cookie } }); expect(indexed.status).toBe(200);
  const metadata = await indexed.json() as { records: unknown[] }; expect(metadata.records).toHaveLength(3); expect(JSON.stringify(metadata)).not.toContain('Explain the value.');
  await create('Explain the value.', choices); expect(fake.starts).toHaveLength(1);
  expect((await request('/api/conversations', { schema: 'start-conversation-v1', id: 'automatic', projectId: 'project', title: 'Automatic', message: 'Explain the value.', clientMessageId: 'first' })).status).toBe(409);
}, 60_000);

test('initial composer admission survives hub loss after its first saved choice without losing or repeating the first step', async () => {
  actions = ['done']; enqueue(); let offline = false; let interrupted = false;
  const save = ConversationWork.prototype.composer;
  vi.spyOn(ConversationWork.prototype, 'composer').mockImplementation(function (this: ConversationWork, record) {
    const result = save.call(this, record);
    if (!interrupted && ComposerOverrideRecordSchema.parse(record).status === 'pending') { interrupted = true; offline = true; }
    return result;
  });
  const settings = app.conversations.options.settings;
  vi.spyOn(app.conversations.options, 'settings').mockImplementation(async () => { if (offline) throw new HubUnavailable('Fixture hub'); return settings(); });
  const input = { schema: 'start-conversation-v1', id: 'automatic', projectId: 'project', title: 'Automatic', message: 'Explain once.', clientMessageId: 'first',
    choices: { schema: 'composer-initial-v1', once: { action: 'reply', modelId: 'fixture', effort: 'low' }, pins: { modelId: 'fixture', effort: 'high' } } };
  try {
    const response = await request('/api/conversations', input); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
    expect(interrupted).toBe(true); expect(fake.starts).toHaveLength(0);
  } finally { offline = false; app.conversations.hubWaits.reachable(); }
  const replies = await Promise.all([request('/api/conversations', input), request('/api/conversations', input)]);
  for (const reply of replies) { expect(reply.status).toBe(201); expect(ConversationPublicSchema.parse(await reply.json()).composerOverrides).toHaveLength(5); }
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts).toHaveLength(1);
  expect(result.decisions[0]).toMatchObject({ action: { chosen: 'reply', source: 'override' }, model: { chosen: 'fixture', source: 'override' }, effort: { requested: 'low', source: 'override' } });
  expect(result.composerOverrides.filter(record => record.request.mode === 'once').every(record => record.status === 'applied')).toBe(true);
  expect((await request('/api/conversations', input)).status).toBe(201); expect(fake.starts).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
}, 60_000);

test.each(['cancel', 'restart'])('initial composer admission does not relaunch after %s interrupts its hub wait', async change => {
  actions = ['done']; enqueue(); let offline = false; let interrupted = false;
  const save = ConversationWork.prototype.composer;
  vi.spyOn(ConversationWork.prototype, 'composer').mockImplementation(function (this: ConversationWork, record) {
    const result = save.call(this, record); if (!interrupted && ComposerOverrideRecordSchema.parse(record).status === 'pending') { interrupted = true; offline = true; } return result;
  });
  const settings = app.conversations.options.settings;
  vi.spyOn(app.conversations.options, 'settings').mockImplementation(async () => { if (offline) throw new HubUnavailable('Fixture hub'); return settings(); });
  const input = { schema: 'start-conversation-v1', id: 'automatic', projectId: 'project', title: 'Automatic', message: 'Explain once.', clientMessageId: 'first', choices: { schema: 'composer-initial-v1', once: { action: 'reply' }, pins: {} } };
  expect((await request('/api/conversations', input)).status).toBe(503); expect(fake.starts).toHaveLength(0);
  if (change === 'cancel') { offline = false; await app.conversations.cancel('automatic'); }
  else {
    const homes = app.homes; await app.close(); offline = false;
    app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]), decisionFetch: transport }); await app.conversations.ready;
  }
  app.conversations.hubWaits.reachable(); const recovered = await app.conversations.create(input); await app.conversations.wait('automatic');
  // Cancel is the user's decision and closes the work; a daemon restart only interrupts it (7.5), keeping the pending choice unconsumed.
  if (change === 'cancel') expect(recovered.conversation.state).toBe('cancelled');
  else { expect(recovered.conversation.state).toBe('waiting-for-you'); expect(recovered.pause?.reason).toBe(RESTART_NOTICE); expect(recovered.conversation.work).not.toBeNull(); }
  expect(recovered.composerOverrides).toHaveLength(1); expect(fake.starts).toHaveLength(0);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
});

test.each(['done', 'review', 'adversarial-review'] as const)('initial composer admission rejects disallowed %s before saving the conversation', async action => {
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].guards.reviewCap = 0;
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  const response = await request('/api/conversations', { schema: 'start-conversation-v1', id: 'automatic', projectId: 'project', title: 'Automatic', message: 'Do not create invalid work.', clientMessageId: 'first', choices: { schema: 'composer-initial-v1', once: { action }, pins: {} } });
  expect(response.status).toBe(409); expect(app.conversations.hasLocalConversation('automatic')).toBe(false); expect(fake.starts).toHaveLength(0);
});

test('once beats a pin for one stretch and the pin applies to subsequent stretches and works', async () => {
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].menu.push({ ...config.configuration['x-jevellan'].menu[0]!, id: 'other', label: 'Other model', efforts: ['low', 'high'] });
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  actions = ['reply', 'done']; enqueue(); enqueue();
  await create('Explain twice.', { schema: 'composer-initial-v1', once: { action: 'reply', modelId: 'other', effort: 'low' }, pins: { modelId: 'fixture', effort: 'high' } });
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(result.decisions.slice(0, 2).map((decision) => [decision.model!.chosen, decision.model!.source, decision.effort!.requested, decision.effort!.source])).toEqual([['other', 'override', 'low', 'override'], ['fixture', 'pin', 'high', 'pin']]);
  expect(result.composerOverrides.filter((record) => record.request.mode === 'pin').every((record) => record.status === 'applied' && record.stretch === 2)).toBe(true);
  expect(result.conversation).toMatchObject({ once: {}, pins: { modelId: 'fixture', effort: 'high' } });
  actions = ['reply', 'done']; enqueue(); expect((await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'another_work', text: 'Explain it again.' })).status).toBe(200);
  const next = await finished(); expect(next.conversation.state, next.pause?.reason).toBe('done'); expect(next.decisions.at(-2)).toMatchObject({ model: { chosen: 'fixture', source: 'pin' }, effort: { requested: 'high', source: 'pin' } });
}, 60_000);

test('pending composer changes preserve manual recovery, reject stale writes and clear back to Auto', async () => {
  app.hub.db.prepare('DELETE FROM secrets WHERE id=?').run('jev'); await create();
  await composer('action', 'plan'); const input = await composer('action', 'reply');
  const generation = (await view()).conversation.generation; expect((await view()).decisionWait?.generation).toBe(generation); expect((await view()).conversation.once.action).toBe('reply');
  expect((await request('/api/conversations/automatic/choices', input)).status).toBe(200); expect((await view()).conversation.generation).toBe(generation);
  expect((await request('/api/conversations/automatic/choices', { ...input, value: 'plan' })).status).toBe(409);
  expect((await request('/api/conversations/automatic/choices', { ...input, clientRequestId: 'stale' })).status).toBe(409);
  expect((await view()).composerOverrides.map((record) => record.status)).toEqual(['superseded', 'pending']);
  await composer('model', 'fixture', 'pin'); await composer('effort', 'low', 'pin'); await composer('model', null, 'pin'); await composer('effort', null, 'pin'); await composer('action', null);
  expect((await view()).conversation).toMatchObject({ once: {}, pins: {} }); expect(fake.starts).toHaveLength(0);
  app.hub.vault.put('jev', `fixture-${randomUUID()}`); enqueue('2');
  expect((await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: (await view()).conversation.generation })).status).toBe(202);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(result.decisions[0]).toMatchObject({ action: { source: 'jev' }, model: { source: 'only-option' }, effort: { source: 'jev' } });
  expect(result.composerOverrides.filter((record) => record.status === 'applied').every((record) => record.request.value === null)).toBe(true);
}, 60_000);

test('a composer choice supersedes an in-flight classification without consuming it early', async () => {
  let release!: () => void; let signal: AbortSignal | undefined;
  transport.mockImplementationOnce(async (_url, init) => { signal = init!.signal ?? undefined; const body = JSON.parse(String(init!.body)) as Wire; return new Promise<Response>((resolve) => { release = () => resolve(answer(body, 'implement')); }); });
  actions = ['done']; enqueue(); await create(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await composer('action', 'reply'); expect(signal?.aborted).toBe(true); expect((await view()).composerOverrides[0]!.status).toBe('pending'); expect((await view()).conversation.once.action).toBe('reply');
  release(); const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts.map((step) => step.action)).toEqual(['reply']); expect(result.decisions.map((decision) => decision.action.chosen)).toEqual(['reply', 'done']);
  expect(result.composerOverrides[0]).toMatchObject({ status: 'applied', decisionId: result.decisions[0]!.id, stretch: 1 }); expect(result.conversation.once).toEqual({});
}, 60_000);

test('changing composer choices during a running stretch does not interrupt it or bind to its outcome update', async () => {
  let release!: () => void; let entered!: () => void; let runningSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const completion = new Promise<void>(resolve => { release = resolve; });
  actions = ['reply', 'done']; fake.enqueue(async ({ input, signal }) => { runningSignal = signal; entered(); await completion; await handoff(input); return { status: 'completed' }; }); enqueue();
  await create('Explain two things.');
  try {
    await started;
    await composer('action', 'reply'); await composer('effort', 'low'); expect(runningSignal?.aborted).toBe(false); expect((await view()).composerOverrides.every((record) => record.status === 'pending')).toBe(true);
  } finally { release(); }
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(result.stretches.map((step) => step.effortRequested)).toEqual(['high', 'low']); expect(result.composerOverrides.every((record) => record.stretch === 2 && record.decisionId === result.decisions[1]!.id)).toBe(true);
}, 60_000);

test('pending choices survive restart and unavailable accounts without being consumed or launched', async () => {
  const account = await app.accounts.get('test_account'); await app.accounts.update(account.account.id, { schema: 'update-account-v1', revision: account.revision, label: account.account.label, ceilingPct: account.account.ceilingPct, enabled: false });
  actions = ['done']; await create('Explain after account recovery.', { schema: 'composer-initial-v1', once: { action: 'reply', modelId: 'fixture' }, pins: { effort: 'low' } });
  const paused = await finished(); expect(paused.decisionWait?.kind).toBe('no-eligible-model'); expect(paused.composerOverrides.every((record) => record.status === 'pending')).toBe(true); expect(fake.starts).toHaveLength(0);
  const homes = app.homes; await app.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true;
  app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]), decisionFetch: transport }); await app.conversations.ready;
  server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await view()).conversation).toMatchObject({ once: { action: 'reply', modelId: 'fixture' }, pins: { effort: 'low' } }); expect((await view()).composerOverrides).toEqual(paused.composerOverrides); expect(fake.starts).toHaveLength(0);
  const disabled = await app.accounts.get('test_account'); await app.accounts.update(disabled.account.id, { schema: 'update-account-v1', revision: disabled.revision, label: disabled.account.label, ceilingPct: disabled.account.ceilingPct, enabled: true }); enqueue();
  expect((await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: (await view()).conversation.generation })).status).toBe(202);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(result.conversation).toMatchObject({ once: {}, pins: { effort: 'low' } });
  expect(result.composerOverrides.every((record) => record.status === 'applied' && record.stretch === 1)).toBe(true); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('a queued composer action that becomes unavailable waits without consuming the choice or calling Jev', async () => {
  let release!: () => void; let markStarted!: () => void; const started = new Promise<void>((resolve) => { markStarted = resolve; });
  actions = ['review', 'done']; fake.enqueue(async ({ input }) => { await new Promise<void>((resolve) => { release = resolve; markStarted(); }); await handoff(input); return { status: 'completed' }; });
  await create('Review the value.'); await started; await composer('action', 'review');
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].guards.reviewCap = 1;
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  const before = calls.length; release(); const paused = await finished();
  expect(paused.decisionWait?.kind).toBe('choice-unavailable'); expect(paused.allowed).not.toContain('review'); expect(paused.conversation.once.action).toBe('review');
  expect(paused.composerOverrides[0]!.status).toBe('pending'); expect(fake.starts).toHaveLength(1); expect(calls).toHaveLength(before);
  await composer('action', null); expect((await request('/api/conversations/automatic/resume', { schema: 'resume-decision-v1', generation: (await view()).conversation.generation })).status).toBe(202);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts).toHaveLength(1);
  expect(result.composerOverrides.map((record) => record.status)).toEqual(['superseded', 'applied']); expect(result.composerOverrides[1]).toMatchObject({ action: 'done', stretch: null, decisionId: result.decisions.at(-1)!.id });
}, 60_000);

test('progress is available while Jev is pending, streams through execution, and clears when idle', async () => {
  let release!: () => void;
  transport.mockImplementationOnce(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as Wire;
    return new Promise<Response>(resolve => { release = () => resolve(answer(body, 'reply')); });
  });
  actions = ['done']; enqueue();
  await create('Explain the current value.');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect((await view()).progress).toMatchObject({ schema: 'conversation-progress-v1', phase: 'deciding' });
  release(); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(result.progress).toBeUndefined(); expect(result.busy).toBe(false);
  const phases = app.conversations.ledger('automatic').events().flatMap(event => {
    const data = event.data as { schema?: string; phase?: string }; return data.schema === 'conversation-progress-v1' ? [data.phase] : [];
  });
  expect(phases).toEqual(expect.arrayContaining(['preparing', 'deciding', 'memory', 'starting', 'running', 'saving', 'verifying']));
});

test('a limit on one model cools only that model: the next step runs on another model and review briefs carry the change', async () => {
  const config = app.hub.configuration.current()!;
  config.configuration['x-jevellan'].menu = [
    { id: 'fable', runtime: 'fake', model: 'scripted-fable', label: 'Fable', description: 'Strongest simulated model.', efforts: ['high'], enabled: true },
    { id: 'opus', runtime: 'fake', model: 'scripted-opus', label: 'Opus', description: 'Default simulated model.', efforts: ['high'], enabled: true },
  ];
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  actions = ['implement', 'implement', 'review', 'done'];
  const limit = { kind: 'rate-limit' as const, scope: 'model' as const, message: "You've reached your Fable limit. Switch to another model to continue." };
  fake.enqueue(async () => ({ status: 'failed', error: limit })); fake.enqueue(async () => ({ status: 'failed', error: limit }));
  enqueue('2'); enqueue();
  await create(); const result = await finished();
  expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(fake.starts.map((input) => [input.action, input.model])).toEqual([['implement', 'scripted-fable'], ['implement', 'scripted-opus'], ['review', 'scripted-opus']]);
  expect(result.handoffs[0]!.summary).toContain("Runtime error: You've reached your Fable limit.");
  const second = result.decisions[1]!;
  expect(second.model).toMatchObject({ chosen: 'opus', excluded: [{ modelId: 'fable', reason: 'cooling' }] });
  expect(second.account!.ranking).toEqual([expect.objectContaining({ accountId: 'test_account', eligible: true })]);
  const status = (await app.accounts.status('test_account'));
  expect(status.coolingUntil).toBeUndefined(); expect(Date.parse(status.modelCooling!['scripted-fable']!)).toBeGreaterThan(Date.now() + 25 * 60_000);
  const review = fake.starts[2]!.brief.split('# Change under review\n\n')[1]!.split('\n\n# Memory')[0]!;
  expect(review).toContain(`base commit ${initial.slice(0, 12)}`); expect(review).toContain('- value.txt'); expect(review).toContain('+2');
  expect(fake.starts[2]!.permissions).toBe('read-only'); expect(fake.starts[1]!.brief).not.toContain('# Change under review');
}, 60_000);


test('a summary request after several settled stretches must receive a reply before work can finish', async () => {
  actions = [...Array<Action>(7).fill('reply'), 'ask-you'];
  for (let n = 1; n <= 7; n++) fake.enqueue(async ({ input, emit }) => {
    emit({ type: 'text', delta: `Recorded result ${n}: removed the retired hooks; no process remains.` });
    await handoff(input, n === 7 ? { status: 'partial', summary: 'The retired hooks are removed; a manual permission check remains.', question: 'Can you check the system permission?', blockers: ['The system permission needs a manual check.'] } : {});
    return { status: 'completed' };
  });
  await create('Check the retired project.'); expect((await finished()).conversation.state).toBe('waiting-for-you');
  actions = ['reply', 'done'];
  fake.enqueue(async ({ input, emit }) => {
    expect(input.action).toBe('reply'); expect(input.permissions).toBe('read-only');
    expect(input.brief).toContain('# Latest user message — respond to this now\n\ntldr');
    expect(input.brief).toContain('Recorded result 7: removed the retired hooks; no process remains.');
    emit({ type: 'text', delta: 'The hooks are removed and nothing is running. One system permission still needs your manual check.' });
    await handoff(input, { summary: 'Short summary delivered.' }); return { status: 'completed' };
  });
  expect((await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'summary', text: 'tldr', kind: 'message' })).status).toBe(200);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  const summaryDecision = result.decisions.find(entry => entry.latestMessageEventId === result.messages.at(-1)!.id)!;
  expect(summaryDecision.action.allowed).not.toContain('done'); expect(summaryDecision.action.chosen).toBe('reply');
  const state = calls.filter(call => call.questions.next_action).at(-2)!.state as { conversation: { questionBeforeLatestMessage: string; recentConversation: string; recentHandoffs: { blockers: string[] }[] }; facts: { latestMessageNeedsResponse: boolean } };
  expect(state.facts.latestMessageNeedsResponse).toBe(true);
  expect(state.conversation.questionBeforeLatestMessage).toBe('Can you check the system permission?');
  expect(state.conversation.recentHandoffs.at(-1)!.blockers).toEqual(['The system permission needs a manual check.']);
  expect(fake.starts).toHaveLength(8); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
}, 60_000);

test('a follow-up after completed work receives previous answers without inheriting old constraints', async () => {
  actions = ['reply', 'done']; fake.enqueue(async ({ input, emit }) => {
    emit({ type: 'text', delta: 'The audit found no remaining background process. The retired hook was already removed.' });
    await handoff(input, { findings: [{ claim: 'constraint: audit only, no changes', pointer: 'value.txt:1' }] }); return { status: 'completed' };
  });
  await create('Audit the retired project.'); const first = await finished(); expect(first.conversation.state).toBe('done');
  actions = ['reply', 'done']; fake.enqueue(async ({ input, emit }) => {
    expect(input.brief).toContain('Audit the retired project.');
    expect(input.brief).toContain('The audit found no remaining background process.');
    expect(input.brief).toContain('# Latest user message — respond to this now\n\nWhat does that mean?');
    emit({ type: 'text', delta: 'It means the retired project has no running background process.' });
    await handoff(input); return { status: 'completed' };
  });
  expect((await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'followup', text: 'What does that mean?', kind: 'message' })).status).toBe(200);
  const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(result.closedWorks).toHaveLength(2); expect(result.closedWorks[1]!.constraints).toEqual([]);
  const state = calls.filter(call => call.questions.next_action).at(-2)!.state as { conversation: { request: string; recentConversation: string; recentHandoffs: unknown[] } };
  expect(state.conversation.request).toBe('What does that mean?'); expect(state.conversation.recentHandoffs).toEqual([]);
  expect(state.conversation.recentConversation).toContain('The audit found no remaining background process.');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
});

test('a queued message arriving after launch cannot be consumed by the running stretch', async () => {
  actions = ['reply', 'reply', 'done']; let release!: () => void; let launched!: () => void;
  const running = new Promise<void>(resolve => { launched = resolve; });
  fake.enqueue(async ({ input, emit }) => {
    await new Promise<void>(resolve => { release = resolve; launched(); });
    emit({ type: 'text', delta: 'The earlier answer.' }); await handoff(input); return { status: 'completed' };
  });
  fake.enqueue(async ({ input, emit }) => {
    expect(input.brief).toContain('# Latest user message — respond to this now\n\nSummarize the earlier answer.');
    emit({ type: 'text', delta: 'The concise summary.' }); await handoff(input); return { status: 'completed' };
  });
  await create('Explain the project.'); await running;
  expect((await request('/api/conversations/automatic/messages', { schema: 'conversation-message-v1', clientMessageId: 'queue', text: 'Summarize the earlier answer.', kind: 'note' })).status).toBe(200);
  release(); const result = await finished(); expect(result.conversation.state, result.pause?.reason).toBe('done');
  expect(fake.starts).toHaveLength(2); expect(result.decisions[1]!.action.allowed).not.toContain('done');
  expect(result.decisions.at(-1)!.action.allowed).toContain('done');
});
