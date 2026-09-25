import { expect, test, vi } from 'vitest';
import { queuedRefresh } from '../apps/web/src/refresh.js';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('a slow initial page renders despite stream replay, then catches up without overlapping reads', async () => {
  const first = deferred<string>(); const latest = deferred<string>(); const receive = vi.fn(); const failed = vi.fn();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  const refresh = queuedRefresh(read, receive, failed); const pending = refresh.request();
  await refresh.request(); await refresh.request(); expect(read).toHaveBeenCalledOnce();
  first.resolve('initial snapshot'); await Promise.resolve();
  expect(receive).toHaveBeenCalledWith('initial snapshot'); expect(read).toHaveBeenCalledTimes(2);
  latest.resolve('current snapshot'); await pending;
  expect(receive.mock.calls).toEqual([['initial snapshot'], ['current snapshot']]); expect(failed).not.toHaveBeenCalled();
});

test('notifications during catch-up still request the final state', async () => {
  const first = deferred<number>(); const second = deferred<number>(); const receive = vi.fn();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(3);
  const refresh = queuedRefresh(read, receive, vi.fn()); const pending = refresh.request();
  await refresh.request(); first.resolve(1); await Promise.resolve();
  await refresh.request(); await refresh.request(); second.resolve(2); await pending;
  expect(receive.mock.calls).toEqual([[1], [2], [3]]);
});

test('navigation aborts a pending read and suppresses its late result and queued refresh', async () => {
  const first = deferred<string>(); const receive = vi.fn(); const failed = vi.fn();
  const read = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(false); return first.promise; }); const refresh = queuedRefresh(read, receive, failed);
  const pending = refresh.request(); await refresh.request(); refresh.stop();
  expect(read.mock.calls[0]![0].aborted).toBe(true);
  first.resolve('old conversation'); await pending; await refresh.request();
  expect(read).toHaveBeenCalledOnce(); expect(receive).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
});

test('a failed snapshot reports its error and permits the queued recovery', async () => {
  const first = deferred<string>(); const receive = vi.fn(); const failed = vi.fn(); const error = new Error('Temporary failure');
  const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('recovered');
  const refresh = queuedRefresh(read, receive, failed); const pending = refresh.request(); await refresh.request();
  first.reject(error); await pending;
  expect(failed).toHaveBeenCalledWith(error); expect(receive).toHaveBeenCalledWith('recovered');
});
