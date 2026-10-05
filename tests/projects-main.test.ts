// Phase 6 acceptance (brief 13 PJ6; design 5.2.16, 3.6; D29, D65, D71, D285-D292): two threads work directly on main on two devices of one
// project, reserve overlapping paths, exchange mail with each other and the coordinator, and publish to one bare origin; the second
// publication hits a rebase conflict, gets the exact main-conflict prompt and publishes the agent's resolution. Checkout ownership keeps a
// conversation and other main threads off a busy checkout, and placement never puts a second main thread there. Simulated: the member
// device (local HTTP), the Jev answers, runtime turns and GitHub. Live: git, HTTP, the hub, the relay, mail and reservations, checkout
// ownership, publication leases and the ledgers.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ThreadCreatedViewSchema, ThreadViewSchema, type CoordinatorEvent, type ProjectLedgerData, type ProjectLedgerEvent, type ProjectLedgerEventType, type Thread,
} from '../packages/core/dist/index.js';
import { PlacementStateSchema, type JevQuestions } from '../packages/decisions/dist/index.js';
import { forCoordinator, forThread, type FakeRuntime, type FakeTurn, type FakeTurnStep, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import { STOPPED_BY_YOU, mainConflictPrompt, type ProjectWork } from '../packages/projects/dist/index.js';
import { FIXTURE_MENU, expectNoLeaks, git, projectFixture, projectMember, type ProjectFixture, type ProjectMember } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});

const pid = 'project';
const MAIN_TOOLS = ['jevellan_mail_send', 'jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_release'];
const route = (threadId: string, suffix = '') => `/api/projects/${pid}/threads/${threadId}${suffix}`;
const createBody = (title: string, task: string, extra: object) => ({ schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task, ...extra });
const start = (f: ProjectFixture, title: string, task: string, extra: object) => f.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST', createBody(title, task, extra));
const settled = (state: Thread['state']) => (thread: Thread) => thread.state === state;
const firstTurn = (title: string) => forThread((input) => input.prompt.startsWith(`Task: ${title}\n`));
const coordinatorPrompts = (fake: FakeRuntime): string[] => fake.turnStarts.filter((input) => input.owner.kind === 'coordinator').map((input) => input.prompt);
function payloads<T extends ProjectLedgerEventType>(work: ProjectWork, threadId: string, type: T): ProjectLedgerData<T>[] {
  const ledger = work.ledgers.thread(pid, threadId);
  return ledger.events().filter((event) => event.type === type).map((event) => ledger.payload(event as ProjectLedgerEvent & { type: T }));
}
/** The coordinator events a device's ledger recorded, in order. */
function ledgerEvents(work: ProjectWork): CoordinatorEvent[] {
  const ledger = work.coordinatorLedger(pid);
  return ledger.events().filter((event) => event.type === 'coordinator-event').map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' }));
}

/**
 * The scripted Jev transport: placement packets only (a conversation's decision packet fails as a network error, so conversations wait for
 * the owner). Effort `high`, the first model, and the device by its explicit key; the chosen option gets 0.6 and the rest share the remainder.
 */
function jev(device: () => string) {
  const calls: JevQuestions[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ models: [{ name: 'jev-latest', description: 'Fixture.', release_date: '2026-01-01' }] });
    const body = JSON.parse(String(init!.body)) as { state: string; questions: JevQuestions };
    PlacementStateSchema.parse(JSON.parse(body.state)); calls.push(body.questions);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const keys = question.type === 'choice' ? Object.keys(question.criteria) : [];
      const choice = id === 'device' ? device() : id === 'effort' ? 'high' : keys[0]!;
      if (!keys.includes(choice)) throw new Error(`The fixture cannot answer ${id}.`);
      const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 0.6 : Math.round((0.4 / (keys.length - 1)) * 1000) / 1000]));
      return [id, { type: 'choice', choice, probabilities, confidence: 0.6 }];
    }));
    return Response.json({ model: 'jev-fixture', usage: { input_tokens: 40, output_tokens: 4 }, answers });
  };
  return { calls, fetch: fetcher };
}
/** Every coordinator turn of `fake` says `Noted.`: the coordinator only has to read its events here. */
function coordinatorScript(fake: FakeRuntime): void {
  const start = fake.startTurn.bind(fake);
  fake.startTurn = (input: TurnInput) => {
    if (input.owner.kind === 'coordinator') fake.enqueueTurn((turn) => { turn.say('Noted.'); return { status: 'completed' }; }, forCoordinator);
    return start(input);
  };
}

/**
 * A thread turn the test drives: each `act` runs inside the running turn (bridge calls with its token, git in its cwd) and hands its result or
 * error back to the test; the turn stays open until `end()` or until it is stopped.
 */
class Puppet {
  turn: FakeTurn | undefined;
  readonly #actions: Array<(turn: FakeTurn) => Promise<void>> = [];
  #wake = (): void => undefined; #ended = false;
  readonly step: FakeTurnStep = async (turn) => {
    this.turn = turn; turn.signal.addEventListener('abort', () => this.#wake(), { once: true });
    for (;;) {
      for (let next = this.#actions.shift(); next; next = this.#actions.shift()) await next(turn);
      if (this.#ended || turn.signal.aborted) return { status: 'completed' };
      await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
  };
  act<T>(action: (turn: FakeTurn) => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#actions.push(async (turn) => { try { resolve(await action(turn)); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); } });
      this.#wake();
    });
  }
  end(): void { this.#ended = true; this.#wake(); }
}

/** One round of both devices' periodic work (relayed starts and events, index publishing) without waiting for turns: puppet turns stay open. */
async function pulse(f: ProjectFixture, m: ProjectMember): Promise<void> { await m.app.projectWork.pulse(); await f.app.projectWork.pulse(); }
const until = <T>(f: ProjectFixture, m: ProjectMember, read: () => T | Promise<T>, accept: (value: T) => boolean = Boolean) =>
  f.waitFor(async () => { await pulse(f, m); return read(); }, accept);

test('PJ6 two main threads on two devices reserve, mail, publish and resolve a conflict', { timeout: 300_000 }, async () => {
  let memberId = '';
  const transport = jev(() => memberId);
  // Two efforts, so Jev is asked something for every placement that does not fix everything.
  const f = fixture = await projectFixture({ coordinator: true, jevKey: true, decisionFetch: transport.fetch, testCommand: 'test -f src/app.txt',
    menu: [{ ...FIXTURE_MENU[0]!, efforts: ['medium', 'high'] }] });
  coordinatorScript(f.fake);
  // The app both threads change, on origin before the member clones it.
  mkdirSync(join(f.checkout, 'src')); writeFileSync(join(f.checkout, 'src', 'app.txt'), 'zero\n');
  git(f.checkout, 'add', '-A'); git(f.checkout, 'commit', '-m', 'Add the app'); git(f.checkout, 'push', 'origin', 'main');
  const seed = git(f.origin, 'rev-parse', 'refs/heads/main');
  const m = await projectMember(f); memberId = m.deviceId;
  const hubId = f.app.device.deviceId;
  const project = (await f.app.state.projects.get(pid))!.project;
  const claimA = () => f.app.conversations.ownership.current(project);
  const claimB = () => m.app.conversations.ownership.current(project);
  const origin = () => git(f.origin, 'rev-parse', 'refs/heads/main');

  // 1. T1 works on main on A: it holds A's checkout, has the mail and reservation tools, and reserves src/.
  const t1 = new Puppet(); f.fake.enqueueTurn(t1.step, firstTurn('T1 title'));
  const one = await start(f, 'T1 title', 'Change the first line of src/app.txt to one.', { isolation: 'main', deviceId: hubId });
  await f.waitFor(claimA, (claim) => claim?.held === true && claim.conversationId === one.threadId);
  await f.waitFor(() => t1.turn);
  expect(t1.turn!.input.cwd).toBe(f.checkout);
  expect(f.thread(one.threadId)).toMatchObject({ state: 'running', isolation: 'main', ownerDeviceId: hubId, baseCommit: seed });
  expect(await t1.act((turn) => turn.tools())).toEqual(expect.arrayContaining(MAIN_TOOLS));
  expect(await t1.act((turn) => turn.bridge('jevellan_reserve', { paths: ['src/'], reason: 'Edit the app' })))
    .toEqual({ schema: 'reserve-result-v1', granted: true, id: expect.stringMatching(/^resv_/) });

  // 2. While T1 holds A's checkout, a conversation on A is refused with T1's title, and a main thread fixed to A is refused.
  const refusal = `${project.name} on ${f.deviceName} is in use by "T1 title".`;
  const conversation = await f.request('/api/conversations', 'POST', { schema: 'start-conversation-v1', id: 'conv_on_a', projectId: pid, title: 'Chat on A',
    message: 'Change value.txt.', clientMessageId: 'first_conv_on_a' });
  expect(conversation.status).toBe(201);
  await f.app.conversations.wait('conv_on_a');
  const implement = async () => {
    const chosen = await f.request('/api/conversations/conv_on_a/manual', 'POST', { schema: 'manual-step-v1', generation: (await f.app.conversations.view('conv_on_a')).conversation.generation,
      action: 'implement', modelId: 'fixture', effort: 'high' });
    expect(chosen.status).toBe(202); await f.app.conversations.wait('conv_on_a');
  };
  await implement();
  expect((await f.app.conversations.view('conv_on_a')).pause?.reason).toContain(refusal);
  expect(f.fake.starts).toEqual([]);
  expect(await claimA()).toMatchObject({ held: true, conversationId: one.threadId });
  const fixedOnA = await f.request(`/api/projects/${pid}/threads`, 'POST', createBody('Also on A', 'Work on main here too.', { isolation: 'main', deviceId: hubId }));
  expect(fixedOnA.status).toBe(409);
  expect(await fixedOnA.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: `No device can run any enabled model: ${f.deviceName}: main checkout busy: T1 title.` });

  // 3. Automatic placement of another main thread: A is never offered (Jev is asked the effort, and no device question remains with B the only
  // candidate); the record names why A was left out.
  const t3 = new Puppet(); m.fake.enqueueTurn(t3.step, firstTurn('T3 title'));
  const asked = transport.calls.length;
  const three = await start(f, 'T3 title', 'Tidy src/ on main.', { isolation: 'main' });
  await until(f, m, () => t3.turn);
  await until(f, m, claimB, (claim) => claim?.held === true && claim.conversationId === three.threadId);
  const placed = m.thread(three.threadId).placement;
  expect(placed).toMatchObject({ source: 'jev', isolation: 'main', deviceId: m.deviceId, accountId: m.accountId, eligibleDevices: [m.deviceId] });
  expect(placed.excludedDevices).toContainEqual({ deviceId: hubId, reason: 'main checkout busy: T1 title' });
  expect(transport.calls.slice(asked).map((questions) => Object.keys(questions))).toEqual([['effort']]);
  expect(t3.turn!.input.cwd).toBe(m.checkout);
  // With both checkouts busy a fourth main thread is refused with both titles, never queued (D65, D71).
  const fourth = await f.request(`/api/projects/${pid}/threads`, 'POST', createBody('T4 title', 'Work on main somewhere.', { isolation: 'main' }));
  expect(fourth.status).toBe(409);
  const busy = [`${f.deviceName}: main checkout busy: T1 title`, `${m.name}: main checkout busy: T3 title`];
  expect([busy, [...busy].reverse()].map((reasons) => `No device can run any enabled model: ${reasons.join('; ')}.`)).toContain((await fourth.json() as { message: string }).message);
  expect((await f.app.projectHub.threads(pid)).records.map((index) => index.title).sort()).toEqual(['T1 title', 'T3 title']);
  // A busy checkout does not keep a worktree thread off the device, and a worktree thread has no mail or reservation tools.
  const reader = new Puppet(); f.fake.enqueueTurn(reader.step, firstTurn('Read the docs'));
  const docs = await start(f, 'Read the docs', 'Summarize the docs.', { isolation: 'worktree', deviceId: hubId });
  await f.waitFor(() => reader.turn);
  const worktreeTools = await reader.act((turn) => turn.tools());
  expect(worktreeTools).toContain('jevellan_thread_report'); expect(worktreeTools.filter((tool) => MAIN_TOOLS.includes(tool))).toEqual([]);
  await reader.act((turn) => turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Read them.' })); reader.end();
  expect(await f.waitFor(() => f.thread(docs.threadId), settled('idle'))).toMatchObject({ isolation: 'worktree', ownerDeviceId: hubId });
  // Stopping T3 gives B's checkout back (nothing to save), and the hub no longer reports it held.
  const stopped = ThreadViewSchema.parse(await (await f.request(route(three.threadId, '/stop'), 'POST', { schema: 'thread-stop-request-v1' })).json());
  expect(stopped.thread).toMatchObject({ state: 'stopped', stateReason: STOPPED_BY_YOU });
  await until(f, m, claimB, (claim) => claim?.held === false);
  await until(f, m, () => f.app.projectHub.heldCheckouts(pid), (held) => held.length === 1 && held[0]!.deviceId === hubId);
  expect(await f.app.projectHub.heldCheckouts(pid)).toEqual([{ deviceId: hubId, ownerId: one.threadId, title: 'T1 title' }]);

  // 4. T2 works on main on B. Its reservation overlaps T1's: refused with T1's title and only T1's overlapping paths.
  const t2 = new Puppet(); m.fake.enqueueTurn(t2.step, firstTurn('T2 title'));
  const two = await start(f, 'T2 title', 'Change the first line of src/app.txt to two.', { isolation: 'main', deviceId: m.deviceId });
  await until(f, m, () => t2.turn);
  expect(t2.turn!.input.cwd).toBe(m.checkout);
  expect(m.thread(two.threadId)).toMatchObject({ state: 'running', isolation: 'main', ownerDeviceId: m.deviceId, coordinatorDeviceId: hubId, baseCommit: seed });
  expect(await t2.act((turn) => turn.tools())).toEqual(expect.arrayContaining(MAIN_TOOLS));
  expect(await t2.act((turn) => turn.bridge('jevellan_reserve', { paths: ['src/app.txt'] })))
    .toEqual({ schema: 'reserve-result-v1', granted: false, conflicts: [{ threadTitle: 'T1 title', paths: ['src/'], expiresAt: expect.any(String) }] });

  // 5. Mail in both directions, each read once, and from T2 to the coordinator, whose next turn reads the brief's mail line.
  await until(f, m, () => f.index(two.threadId));
  expect(await t1.act((turn) => turn.bridge('jevellan_mail_send', { to: two.threadId, subject: 'Heads up', body: 'I am changing src/app.txt.' })))
    .toEqual({ schema: 'mail-send-result-v1', mailId: expect.stringMatching(/^mail_/) });
  expect(await t2.act((turn) => turn.bridge('jevellan_mail_inbox', {}))).toEqual({ schema: 'mail-inbox-result-v1', mail: [
    { id: expect.any(String), from: one.threadId, fromTitle: 'T1 title', subject: 'Heads up', body: 'I am changing src/app.txt.', at: expect.any(String) }] });
  expect(await t2.act((turn) => turn.bridge('jevellan_mail_inbox', {}))).toEqual({ schema: 'mail-inbox-result-v1', mail: [] });
  await t2.act((turn) => turn.bridge('jevellan_mail_send', { to: one.threadId, subject: 'Ack', body: 'I will wait.' }));
  expect(await t1.act((turn) => turn.bridge('jevellan_mail_inbox', {}))).toEqual({ schema: 'mail-inbox-result-v1', mail: [
    { id: expect.any(String), from: two.threadId, fromTitle: 'T2 title', subject: 'Ack', body: 'I will wait.', at: expect.any(String) }] });
  await t2.act((turn) => turn.bridge('jevellan_mail_send', { to: 'coordinator', subject: 'Waiting on T1', body: 'Holding src/app.txt until T1 publishes.' }));
  const line = `[mail from "T2 title" (${two.threadId})] Waiting on T1\nHolding src/app.txt until T1 publishes.`;
  await until(f, m, () => coordinatorPrompts(f.fake).join('\n'), (prompts) => prompts.includes(line));

  // 6. T1 changes the line, commits and reports done: its head is verified and pushed to main, and its checkout and reservations are free.
  await t1.act(async (turn) => {
    writeFileSync(join(turn.input.cwd, 'src', 'app.txt'), 'one\n'); git(turn.input.cwd, 'commit', '-am', 'Set one');
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'The first line is one.' });
  });
  t1.end();
  const done1 = await f.waitFor(() => f.thread(one.threadId), settled('done'));
  expect(origin()).toBe(done1.publishedCommit); expect(git(f.origin, 'rev-parse', `${done1.publishedCommit}^`)).toBe(seed);
  expect(payloads(f.app.projectWork, one.threadId, 'thread-publication')).toEqual([{ schema: 'thread-publication-v1', result: 'main-published', commit: done1.publishedCommit }]);
  // The thread is done first; the checkout and the reservations are given back right after.
  expect(await f.waitFor(claimA, (claim) => claim?.held === false)).toMatchObject({ conversationId: one.threadId });
  expect(await f.waitFor(() => f.app.projectHub.reservations(pid), (reservations) => reservations.length === 0)).toEqual([]);
  // The conversation on A now gets the checkout normally: its implement step claims it and runs there.
  let stretchCwd: string | undefined;
  f.fake.enqueue(({ input, emit }) => { stretchCwd = input.cwd; emit({ type: 'text', delta: 'Read the checkout.' }); return { status: 'completed' }; });
  await implement();
  expect(stretchCwd).toBe(f.checkout); expect(f.fake.starts).toHaveLength(1);
  expect(await claimA()).toMatchObject({ held: true, conversationId: 'conv_on_a' });

  // 7. T2 changes the same line from the old main: the rebase conflicts, is aborted, and the agent gets the exact prompt. Jevellan fetched main
  // first, so the agent rebases without fetching, keeps both intents and reports done again; the resolution is verified again and pushed.
  let resolution: { upstream: string; rebase: 'clean' | 'conflict'; rebasing: boolean } | undefined;
  m.fake.enqueueTurn(async (turn) => {
    const cwd = turn.input.cwd;
    const upstream = git(cwd, 'rev-parse', 'origin/main'); const rebasing = existsSync(join(cwd, '.git', 'rebase-merge'));
    let rebase: 'clean' | 'conflict' = 'clean';
    try { git(cwd, 'rebase', 'origin/main'); } catch { rebase = 'conflict'; }
    resolution = { upstream, rebase, rebasing };
    writeFileSync(join(cwd, 'src', 'app.txt'), 'one\ntwo\n'); git(cwd, 'add', 'src/app.txt'); git(cwd, '-c', 'core.editor=true', 'rebase', '--continue');
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Kept both lines.' });
    return { status: 'completed' };
  }, forThread((input) => input.owner.id === two.threadId && input.turn === 2));
  const committed2 = await t2.act(async (turn) => {
    writeFileSync(join(turn.input.cwd, 'src', 'app.txt'), 'two\n'); git(turn.input.cwd, 'commit', '-am', 'Set two');
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'The first line is two.' });
    return git(turn.input.cwd, 'rev-parse', 'HEAD');
  });
  t2.end();
  const done2 = await until(f, m, () => m.thread(two.threadId), settled('done'));
  const prompt = m.fake.turnStarts.find((input) => input.owner.id === two.threadId && input.turn === 2)!.prompt;
  expect(prompt).toBe('Main moved while you worked and your commits conflict with it in: src/app.txt. Run git fetch origin main and git rebase origin/main, resolve the conflicts keeping both intents, run the tests, and report done again.');
  expect(prompt).toBe(mainConflictPrompt(['src/app.txt']));
  expect(resolution).toEqual({ upstream: done1.publishedCommit, rebase: 'conflict', rebasing: false });
  expect(payloads(m.app.projectWork, two.threadId, 'thread-publication')).toEqual([{ schema: 'thread-publication-v1', result: 'conflict', files: ['src/app.txt'] },
    { schema: 'thread-publication-v1', result: 'main-published', commit: done2.publishedCommit }]);
  expect(payloads(m.app.projectWork, two.threadId, 'thread-verification').map((receipt) => [receipt.status, receipt.commit]))
    .toEqual([['passed', committed2], ['passed', done2.publishedCommit]]);
  // Both commits are on main, the resolution on top of T1's, with both lines.
  expect(origin()).toBe(done2.publishedCommit);
  expect(git(f.origin, 'rev-parse', `${done2.publishedCommit}^`)).toBe(done1.publishedCommit);
  expect(git(f.origin, 'log', '--format=%s', `${seed}..main`).split('\n')).toEqual(['Set two', 'Set one']);
  expect(git(f.origin, 'show', 'main:src/app.txt')).toBe('one\ntwo');
  expect(await until(f, m, claimB, (claim) => claim?.held === false)).toMatchObject({ conversationId: two.threadId });
  expect(git(m.checkout, 'status', '--porcelain=v1')).toBe(''); expect(git(m.checkout, 'rev-parse', 'HEAD')).toBe(done2.publishedCommit);
  // The coordinator on A hears both publications, T2's through the relay; only the conversation still holds a checkout.
  const published = await until(f, m, () => ledgerEvents(f.app.projectWork).flatMap((event) => event.kind === 'thread-published' ? [[event.threadId, event.result, event.commit]] : []),
    (events) => events.length === 2);
  expect(published).toEqual([[one.threadId, 'main-published', done1.publishedCommit], [two.threadId, 'main-published', done2.publishedCommit]]);
  expect(await until(f, m, () => f.app.projectHub.heldCheckouts(pid), (held) => held.length === 1)).toEqual([{ deviceId: hubId, ownerId: 'conv_on_a', title: 'Chat on A' }]);
});
