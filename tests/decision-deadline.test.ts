import { expect, test } from 'vitest';
import { JevClient, JevError, deadlineClient, decisionDeadlineMs, runDecision, withDecisionDeadline, type JevRequest } from '../packages/decisions/dist/index.js';

// Fix A (fix-051): the shared overall deadline of one Jev decision.
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const request: JevRequest = { schema: 'jev-request-v1', model: 'jev-test', state: '{}', questions: { outcome: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'A.', b: 'B.' } } } };

test('the deadline is the client retry budget plus five seconds', () => {
  expect(decisionDeadlineMs(4000)).toBe(14_000);
  expect(decisionDeadlineMs(100)).toBe(6200);
});

test('work that never settles and ignores its signal ends with a timeout at the deadline, and its signal aborts', async () => {
  let inner: AbortSignal | undefined; const started = Date.now();
  const error = await withDecisionDeadline(300, undefined, signal => { inner = signal; return never(); }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(JevError); expect((error as JevError).kind).toBe('timeout');
  expect(Date.now() - started).toBeGreaterThanOrEqual(290); expect(Date.now() - started).toBeLessThan(2000);
  expect(inner?.aborted).toBe(true);
});

test('cancellation settles at once even when the work ignores it, and an aborted signal never starts the work', async () => {
  const controller = new AbortController(); let ran = 0;
  const pending = withDecisionDeadline(60_000, controller.signal, () => { ran += 1; return never(); });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  await expect(withDecisionDeadline(60_000, controller.signal, () => { ran += 1; return never(); })).rejects.toMatchObject({ kind: 'cancelled' });
  expect(ran).toBe(1);
});

test('results and errors of work that settles pass through unchanged', async () => {
  await expect(withDecisionDeadline(1000, undefined, async () => 'answer')).resolves.toBe('answer');
  await expect(withDecisionDeadline(1000, undefined, async () => { throw new JevError('auth'); })).rejects.toMatchObject({ kind: 'auth' });
});

test('a client whose fetch never settles and ignores its abort is bounded by the source deadline, which needs no read', async () => {
  let reads = 0;
  const source = Object.assign(async () => { reads += 1; return new JevClient({ key: () => 'jev-test-key', timeoutMs: 100, fetch: () => never() }); }, { deadlineMs: () => 400 });
  const started = Date.now();
  await expect(deadlineClient(source).decide(request, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' });
  expect(Date.now() - started).toBeLessThan(2000); expect(reads).toBe(1);
});

test('obtaining the client is inside the deadline, and a missing source decides without a key', async () => {
  await expect(runDecision(Object.assign(() => never<never>(), { deadlineMs: () => 300 }), undefined, async () => 'unreached')).rejects.toMatchObject({ kind: 'timeout' });
  await expect(deadlineClient(undefined).decide(request)).rejects.toMatchObject({ kind: 'no-key' });
});
