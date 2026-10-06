// A native session the runtime can no longer find (the Claude CLI deletes journals older than its retention period) never strands a
// thread (P8 review R-T1): the turn that tried to resume it runs again at once in a new session, which starts with the task block, and
// the thread says so. Simulated: the runtime turns (FakeRuntime through the real bridge), including the not-found failure the Claude
// worker reports. Live: git, HTTP, the hub and the ledgers.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { expectNoLeaks, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
const threadTurns = (f: ProjectFixture) => f.fake.turnStarts.filter((input) => input.owner.kind === 'thread');
function notices(f: ProjectFixture, threadId: string): Array<{ text: string; kind: string }> {
  return f.ledgerText(threadId).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: { text: string; kind: string } })
    .filter((event) => event.type === 'notice').map((event) => ({ text: event.data.text, kind: event.data.kind }));
}

test('a thread turn whose stored session no longer exists runs again at once in a new session that starts with the task block', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'First step.' }), forThread());
  const { threadId } = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title: 'Headers', task: 'Keep every header.', isolation: 'worktree' });
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  const first = f.thread(threadId).nativeSessionId!;

  f.fake.enqueueTurn(() => ({ status: 'failed', error: { kind: 'other', message: 'The session to resume no longer exists.' } }), forThread());
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Second step.' }), forThread());
  expect((await f.request(`/api/projects/project/threads/${threadId}/messages`, 'POST',
    { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'Go on with the footer.', interrupt: false })).status).toBe(202);
  const rested = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.lastReport?.summary === 'Second step.');
  expect(threadTurns(f)).toHaveLength(3);
  const [, missing, fresh] = threadTurns(f);
  expect(missing!.resume?.sessionId).toBe(first); expect(missing!.prompt).toBe('Go on with the footer.');
  expect(fresh!.resume).toBeUndefined();
  expect(fresh!.prompt.startsWith('Task: Headers\n\nKeep every header.')).toBe(true); expect(fresh!.prompt.endsWith('Go on with the footer.')).toBe(true);
  expect(rested.nativeSessionId).toBeDefined(); expect(rested.nativeSessionId).not.toBe(first);
  expect(rested.stateReason).toBeUndefined(); expect(rested.queuedMessages).toEqual([]);
  expect(notices(f, threadId)).toContainEqual({ text: "The thread's earlier session no longer exists, so it continues in a new session.", kind: 'info' });
});
