import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';
const script = readFileSync(new URL('../apps/web/public/offline.js', import.meta.url), 'utf8');
function fixture(ok: boolean | 'error' = true, visibilityState = 'visible') {
  const listeners = new Map<string, () => void>(), timers: Array<{ callback: () => void; delay: number }> = [];
  const reload = vi.fn(), fetch = vi.fn(async () => { if (ok === 'error') throw new Error('Hub unavailable.'); return { ok }; }), document = { visibilityState, querySelector: () => ({ addEventListener: (name: string, fn: () => void) => listeners.set(`button:${name}`, fn) }), addEventListener: (name: string, fn: () => void) => listeners.set(`document:${name}`, fn) };
  runInNewContext(script, { document, navigator: { onLine: true }, window: { location: { reload }, addEventListener: (name: string, fn: () => void) => listeners.set(name, fn) }, fetch, AbortSignal,
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout: () => {} });
  return { listeners, timers, reload, fetch, document };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
test('the reconnect screen retries a reachable hub without an online event or owner click', async () => {
  const f = fixture(); await settled();
  expect(f.fetch).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  expect(f.reload).toHaveBeenCalledTimes(1);
});
test('an unreachable hub uses bounded retries and keeps manual retry available', async () => {
  const f = fixture(false); await settled();
  f.listeners.get('online')?.(); await settled();
  expect(f.reload).not.toHaveBeenCalled(); expect(f.timers.at(-1)?.delay).toBeLessThanOrEqual(30_000);
  f.listeners.get('button:click')!(); expect(f.reload).toHaveBeenCalledTimes(1);
});

test('a hidden reconnect page waits until it is visible and reloads at most once', async () => {
  const f = fixture(true, 'hidden'); await settled(); expect(f.fetch).not.toHaveBeenCalled();
  f.document.visibilityState = 'visible'; f.listeners.get('document:visibilitychange')?.(); await settled();
  expect(f.reload).toHaveBeenCalledTimes(1);
  f.listeners.get('online')?.(); await settled(); expect(f.reload).toHaveBeenCalledTimes(1);
});

test('a failed health request retries and recovers when the hub returns', async () => {
  const f = fixture('error'); await settled(); expect(f.reload).not.toHaveBeenCalled();
  expect(f.timers).toHaveLength(1);
  f.fetch.mockResolvedValue({ ok: true }); f.timers.at(-1)!.callback(); await settled();
  expect(f.reload).toHaveBeenCalledTimes(1);
});
