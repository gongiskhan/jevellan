import { afterEach, expect, test } from 'vitest';
import { forCoordinator, forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

// Fix A (fix-051) through the daemon's own decision source: every Jev request hangs and ignores its abort signal, and each
// decision still settles with its documented fallback within the overall deadline (2 x timeoutMs + 1 s + 5 s; 4 s configured).
const DEADLINE = 2 * 4000 + 1000 + 5000;
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const hanging = () => { const calls: string[] = []; const fetch: typeof globalThis.fetch = async (url) => { calls.push(String(url)); return new Promise<Response>(() => undefined); }; return { calls, fetch }; };

test('placement falls back within the deadline when Jev never answers', { timeout: 90_000 }, async () => {
  const jev = hanging(); const f = fixture = await projectFixture({ jevKey: true, decisionFetch: jev.fetch });
  f.fake.enqueueTurn(async turn => { await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Nothing to change.' }); return { status: 'completed' }; }, forThread());
  const started = Date.now();
  const created = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'create_hang', title: 'Check the greeting', task: 'Check the greeting.' });
  const thread = await f.waitFor(() => f.thread(created.threadId), value => value.placement.source !== undefined, DEADLINE + 10_000);
  expect(Date.now() - started).toBeLessThan(DEADLINE + 6000);
  expect(thread.placement).toMatchObject({ source: 'fallback', error: { kind: 'timeout' } });
  expect(jev.calls.length).toBeGreaterThan(0);
});

test('an owner message gets its coordinator turn within the deadline with the uninterpreted-request instruction when Jev never answers', { timeout: 90_000 }, async () => {
  const jev = hanging(); const f = fixture = await projectFixture({ coordinator: true, jevKey: true, decisionFetch: jev.fetch });
  f.fake.enqueueTurn(turn => { turn.say('Looking into it.'); return { status: 'completed' }; }, forCoordinator);
  const sent = Date.now();
  await f.app.projectWork.postMessage(f.project.id, { schema: 'coordinator-message-request-v1', clientMessageId: 'msg_hang', text: 'Which command runs the tests?' });
  const turn = await f.waitFor(() => f.fake.turnStarts.find(input => input.owner.kind === 'coordinator'), Boolean, DEADLINE + 10_000);
  expect(Date.now() - sent).toBeLessThan(DEADLINE + 6000);
  expect(turn!.prompt).toContain('Jev could not interpret this request.');
});
