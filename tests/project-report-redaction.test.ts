// A thread turn that ends without a report gets a synthesized one from the last 1,200 characters of its final message (brief 8.2). When
// those characters hold text redaction lengthens ("Bearer token"), the report is still stored within its maximum, the thread page still
// opens and the coordinator still receives the report (P8 review S-1). An agent's own report is redacted with its tool arguments before
// it is checked, so thread.json, the thread page, the index and the coordinator keep the whole sentence around a token-like word (a guard
// for P8 review N-1, whose index clip is fixed and tested in project-stores). Simulated: the runtime turns (FakeRuntime through the real bridge).
// Live: git on a bare origin, HTTP, the hub, the ledgers and the coordinator queue.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SecretRedactor, ThreadCreatedViewSchema, ThreadViewSchema } from '../packages/core/dist/index.js';
import { forCoordinator, forThread, type FakeRuntime, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import { expectNoLeaks, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
/** Every coordinator turn says `Noted.`: the coordinator only has to read its events here. */
function coordinatorScript(fake: FakeRuntime): void {
  const start = fake.startTurn.bind(fake);
  fake.startTurn = (input: TurnInput) => {
    if (input.owner.kind === 'coordinator') fake.enqueueTurn((turn) => { turn.say('Noted.'); return { status: 'completed' }; }, forCoordinator);
    return start(input);
  };
}
const stable = (text: string) => new SecretRedactor().text(text) === text;

test('a synthesized report whose redaction would lengthen it keeps the thread page open and reaches the coordinator', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  coordinatorScript(f.fake);
  const text = `${'The parser now keeps every header. '.repeat(40)}The middleware reads the Bearer token now.`;
  f.fake.enqueueTurn((turn) => { turn.say(text); return { status: 'completed' }; }, forThread());
  const { threadId } = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title: 'Parser', task: 'Keep the headers.', isolation: 'worktree' });
  const rested = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  // The report is the turn's, not a failure of the step that stored it.
  expect(rested.stateReason).toBeUndefined();

  const page = await f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema);
  const summary = page.reports.at(-1)!.summary;
  expect(summary.length).toBeLessThanOrEqual(1200); expect(stable(summary)).toBe(true);
  expect(summary.endsWith('The middleware reads the Bearer [redacted] now.')).toBe(true);

  await f.waitFor(async () => { await f.app.projectWork.pulse(); await f.app.projectWork.idle('project'); return f.fake.turnStarts.filter((input) => input.owner.kind === 'coordinator').map((input) => input.prompt).join('\n'); },
    (prompts) => prompts.includes('The middleware reads the Bearer [redacted] now.'));
  expect(f.coordinatorState().queue).toEqual([]);
});

test("an agent's own report that says \"Bearer token\" is stored redacted, and the index and the coordinator keep the rest of the sentence", { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  coordinatorScript(f.fake);
  const said = 'Fixed the Bearer token parsing in the auth middleware and added tests for expired tokens.';
  const kept = 'Fixed the Bearer [redacted] parsing in the auth middleware and added tests for expired tokens.';
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: said }), forThread());
  const { threadId } = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title: 'Auth', task: 'Fix the token parsing.', isolation: 'worktree' });
  const rested = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  // thread.json holds what the ledger holds: the report redacted once, not cut.
  expect(rested.lastReport).toMatchObject({ summary: kept, synthesized: false });
  expect((await f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema)).reports.at(-1)!.summary).toBe(kept);
  expect((await f.waitFor(() => f.index(threadId), (index) => index?.turns === 1))!.lastSummary).toBe(kept);
  await f.waitFor(async () => { await f.app.projectWork.pulse(); await f.app.projectWork.idle('project'); return f.fake.turnStarts.filter((input) => input.owner.kind === 'coordinator').map((input) => input.prompt).join('\n'); },
    (prompts) => prompts.includes(kept));
});
