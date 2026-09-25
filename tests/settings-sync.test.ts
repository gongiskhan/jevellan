import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Homes, HubUnavailable, SecretRedactor, readDocument } from '../packages/core/dist/index.js';
import { SettingsSync, SettingsSyncSchema, SETTINGS_SYNC_INTERVAL_MS } from '../apps/daemon/dist/settings-sync.js';

let root: string; let homes: Homes; const workers: SettingsSync[] = [];
const result = { schema: 'rigging-application-v1' as const, at: '2026-09-25T00:00:00Z', accounts: [] };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-settings-sync-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'home'), join(root, 'user')); homes.ensure(); });
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.close())); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

test('startup waits for readiness, recurring checks coalesce, and close drains without another timer', async () => {
  vi.useFakeTimers(); const ready = deferred(); const applying = deferred(); let slow = true;
  const apply = vi.fn(async () => { if (slow) await applying.promise; return result; });
  const worker = new SettingsSync({ homes, redactor: new SecretRedactor(), ready: ready.promise, apply }); workers.push(worker);
  await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_INTERVAL_MS * 2); expect(apply).not.toHaveBeenCalled(); ready.resolve(); await vi.advanceTimersByTimeAsync(0); expect(apply).toHaveBeenCalledTimes(1);
  const one = worker.pulse(); expect(worker.pulse()).toBe(one); await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_INTERVAL_MS * 2); expect(apply).toHaveBeenCalledTimes(1);
  applying.resolve(); expect((await one)?.status).toBe('applied'); slow = false;
  await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_INTERVAL_MS); expect(apply).toHaveBeenCalledTimes(2);
  await worker.close(); await vi.advanceTimersByTimeAsync(SETTINGS_SYNC_INTERVAL_MS * 2); expect(apply).toHaveBeenCalledTimes(2); expect(await worker.pulse()).toBeNull();
});

test('hub waiting and delivery failures are recorded with redaction and retried after recovery', async () => {
  const redactor = new SecretRedactor(); redactor.add('fixture-private-value'); let mode = 0;
  const worker = new SettingsSync({ homes, redactor, ready: Promise.resolve(), timers: false, apply: async () => {
    if (mode === 0) throw new HubUnavailable('Fixture hub');
    if (mode === 1) return { ...result, accounts: [{ accountId: 'account', runtime: 'claude', results: [], error: 'Could not apply fixture-private-value' }] };
    return result;
  } }); workers.push(worker);
  expect((await worker.pulse())?.status).toBe('waiting'); mode = 1;
  expect((await worker.pulse())?.status).toBe('failed'); expect(readDocument(homes.at('settings-sync.json'), SettingsSyncSchema).message).not.toContain('fixture-private-value');
  mode = 2; expect((await worker.pulse())?.status).toBe('applied'); expect(readDocument(homes.at('settings-sync.json'), SettingsSyncSchema).message).toBeUndefined();
});

test('shutdown waits for an admitted delivery but does not report it after closing', async () => {
  const barrier = deferred(); const started = deferred(); const worker = new SettingsSync({ homes, redactor: new SecretRedactor(), ready: Promise.resolve(), timers: false, apply: async () => { started.resolve(); await barrier.promise; return result; } }); workers.push(worker);
  const running = worker.pulse(); await started.promise; let closed = false; const closing = worker.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  barrier.resolve(); await closing; expect(await running).toBeNull(); expect(existsSync(homes.at('settings-sync.json'))).toBe(false);
});
