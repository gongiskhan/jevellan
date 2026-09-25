import { afterEach, expect, test, vi } from 'vitest';
import { ExternalSessionsSchema, ProjectSchema, type ExternalSession } from '../packages/core/dist/index.js';
import { ExternalActivityGuard } from '../packages/conversations/dist/index.js';

const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Project', paths: { here: '/checkout' }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
const watches: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(watches.splice(0).map(watch => watch.close())); vi.useRealTimers(); });
function setup() {
  let rows: ExternalSession[] = []; let unavailable: string[] = [];
  const read = vi.fn(async () => ExternalSessionsSchema.parse({ schema: 'external-sessions-v1', at: new Date().toISOString(), sessions: rows, unavailable }));
  const guard = new ExternalActivityGuard({ deviceId: 'here', deviceName: 'This machine', read });
  return { guard, read, sessions: (value: ExternalSession[]) => { rows = value; }, unavailable: () => { unavailable = ['claude']; } };
}
function session(age = 0, cwd = '/checkout'): ExternalSession { return { runtime: 'claude', cwd, lastActivityAt: new Date(Date.now() - age).toISOString(), source: 'claude-journal' }; }
test('recent activity blocks writing in the checkout and its subdirectories, without matching a sibling or future time', async () => {
  const state = setup(); state.sessions([session(1000, '/checkout/src')]);
  await expect(state.guard.assertIdle(project, '/checkout', 5)).rejects.toThrow('Another agent (Claude Code) is active in Project on This machine.');
  state.sessions([session(5 * 60_000 + 10), session(1000, '/checkout-sibling'), session(-60_000)]);
  await expect(state.guard.assertIdle(project, '/checkout', 5)).resolves.toBeUndefined();
});
test('an unavailable sensor is not a claim that writing is safe', async () => {
  const state = setup(); state.unavailable();
  await expect(state.guard.assertIdle(project, '/checkout', 5)).rejects.toThrow('External agent activity could not be checked');
});
test('a read-only stretch ignores pre-existing activity but latches newly observed activity even after it goes quiet', async () => {
  vi.useFakeTimers(); const state = setup(); const observed = vi.fn(); state.sessions([session(1000)]);
  const watch = state.guard.watch(project, '/checkout', 5, observed); watches.push(watch); await watch.check(); expect(observed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); state.sessions([session()]);
  await vi.advanceTimersByTimeAsync(30_000); expect(observed).toHaveBeenCalledOnce(); expect(watch.reason()).toBe("Claude Code started working in Project while this step ran. Jevellan hasn't committed anything. Check the changes, then press Continue.");
  state.sessions([]); await vi.advanceTimersByTimeAsync(6 * 60_000); await watch.close(); expect(observed).toHaveBeenCalledOnce(); expect(watch.reason()).toContain('press Continue');
});
test('the closing boundary samples activity even when a short stretch finishes between periodic scans', async () => {
  vi.useFakeTimers(); const state = setup(); const observed = vi.fn(); const watch = state.guard.watch(project, '/checkout', 5, observed); watches.push(watch);
  await watch.check(); await vi.advanceTimersByTimeAsync(1); state.sessions([session()]); await watch.close(); expect(observed).toHaveBeenCalledOnce();
  const reads = state.read.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000); expect(state.read).toHaveBeenCalledTimes(reads);
});
test('a failed activity check during execution latches a review notice and does not throw into the running runtime', async () => {
  const state = setup(); state.unavailable(); const observed = vi.fn(); const watch = state.guard.watch(project, '/checkout', 5, observed); watches.push(watch);
  await expect(watch.check()).resolves.toBeUndefined(); await watch.close(); expect(observed).toHaveBeenCalledOnce(); expect(watch.reason()).toContain('Check the changes');
});
