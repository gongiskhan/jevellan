import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveStateSchema, ScenarioReceiptSchema, ScenarioRecorder, canStart, evidenceRedactor, gatingPlan, loadState, saveState, titleSimilarity } from '../scripts/live/contracts.mjs';
import { planFor, runLive } from '../scripts/live/scenarios.mjs';
import { OwnerClient, until } from '../scripts/live/client.mjs';
import { preflight } from '../scripts/live/setup.mjs';
import { SANDBOX_FILES, assertSandbox, writeSandbox } from '../scripts/live/sandbox.mjs';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-live-harness-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const state = () => LiveStateSchema.parse({ schema: 'live-scenarios-state-v1' });

test('owner ledger cleanup cancels the body and closes the browser even when fetch ignores abort', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn(), close = vi.fn(async () => undefined);
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'x-jevellan-ledger-head': '0' } })));
  const client = new OwnerClient({ hub: 'http://fixture' }, { close }, { cookies: async () => [] }, null, []);
  let shutting: Promise<void> | undefined;
  try {
    await client.watch('project_a'); shutting = client.close();
    const result = await Promise.race([shutting.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250))]);
    expect(result).toBe(true); expect(cancel).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  } finally { if (!cancel.mock.calls.length) controller?.close(); await shutting; vi.unstubAllGlobals(); }
});

test('the gated pairs are consecutive and B never gets silently reset between them; extra failing B has a fresh preceding A', () => {
  const plan = gatingPlan(); expect(plan.slice(0, 6).map(row => row.scenario)).toEqual(['A', 'B', 'A', 'B', 'C', 'C']);
  const failing = plan.findIndex(row => row.failingSuite); expect(plan[failing - 1]).toMatchObject({ scenario: 'A', gating: false });
  expect(planFor('D', 'claude')).toHaveLength(4); expect(planFor('all', 'codex')).toEqual([{ scenario: 'A', coordinator: 'codex', gating: false }]);
  expect(() => planFor('X', 'claude')).toThrow('Use --scenario');
});
test('missing owner configuration produces blocked receipts without connecting, mutating projects or starting the ten-hour clock', async () => {
  const connect = vi.fn(), setup = vi.fn(), current = state();
  const results = await runLive({ plan: [{ scenario: 'A', coordinator: 'claude' }, { scenario: 'B', coordinator: 'claude' }], config: undefined, state: current, secrets: {}, output: root, connect, setup });
  expect(connect).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled(); expect(current.firstScenarioAt).toBeNull();
  for (const { receipt } of results) expect(receipt).toMatchObject({ label: 'blocked', passed: false, minutes: 0, startedAt: null, clockStartedAt: null });
});
test('B refuses a successful A invalidated by another scenario reset, before touching either project', async () => {
  const current = { ...state(), projectId: 'reset_project', lastA: { projectId: 'previous_day', passed: true, coordinator: 'claude' as const, receipt: 'day.json' } };
  const setup = vi.fn(), close = vi.fn(), client = new OwnerClient({}, { close }, null, null, []), connect = vi.fn(async () => client);
  const results = await runLive({ plan: [{ scenario: 'B', coordinator: 'claude' }], config: { stateFile: join(root, 'state.json'), output: root }, state: current, secrets: {},
    connect, setup, check: async () => ({ gaps: [], models: {}, jevModel: 'jev' }) });
  expect(results[0]?.receipt).toMatchObject({ label: 'blocked', passed: false, startedAt: null });
  expect(results[0]?.receipt.blockedBy[0]).toContain('intervening reset'); expect(setup).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); expect(current.firstScenarioAt).toBeNull();
});
test('the owner ledger client waits for delayed real HTTP replay and reports native fetch refusals', async () => {
  const server = createServer((request, response) => {
    if (request.url?.includes('/refused/')) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Jevellan-Ledger-Head': '2' }); response.flushHeaders();
    const frame = (id: number) => `data: ${JSON.stringify({ schema: 'project-event-v1', event: { schema: 'project-ledger-event-v1', id, t: new Date().toISOString(), type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: `Turn ${id}` } } })}\n\n`;
    response.write(frame(1)); setTimeout(() => response.write(frame(2)), 150);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new OwnerClient({ hub: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, { close: async () => {} }, { cookies: async () => [] }, null, []);
  try {
    const rows = await client.watch('project'); expect(rows.map((row: { id: number }) => row.id)).toEqual([1, 2]);
    await expect(client.watch('refused')).rejects.toThrow('401');
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('the real API preflight understands saved tokens, roster entries and both device sign-ins without extracting credentials', async () => {
  const client = { config: { proDeviceId: 'pro', madridDeviceId: 'madrid' }, call: vi.fn(async (_method: string, path: string) => {
    if (path === '/hub/config') return { configuration: { 'x-jevellan': { menu: [{ runtime: 'claude', model: 'claude-opus-5-5', enabled: true, efforts: ['high'] }, { runtime: 'codex', model: 'gpt-6.1-sol', enabled: true, efforts: ['high'] }], decisions: { model: 'jev' } } } };
    if (path === '/hub/accounts') return { accounts: [{ account: { runtime: 'codex' }, statuses: ['pro', 'madrid'].map(deviceId => ({ deviceId, auth: 'ready' })) }, { account: { runtime: 'claude' }, statuses: [{ deviceId: 'pro', auth: 'ready' }] }] };
    if (path === '/hub/devices/roster') return { devices: ['pro', 'madrid'].map(id => ({ device: { id }, status: 'online', revoked: false })) };
    if (path === '/hub/secrets/github') return { saved: true }; throw new Error(`Unexpected ${path}`);
  }) };
  // Leave dedicated credentials absent: the check must report these, while sign-ins and the saved token count as ready.
  const result = await preflight(client, 'claude', {}, () => ({ full_name: 'gongiskhan/jevellan-live-sandbox' })); expect(result.gaps).toContain('The dedicated Jev test credential is unavailable for the real A11 assertion.'); expect(result.gaps.some(text => /sign-in|sandbox-only token|joined/u.test(text))).toBe(false);
  expect(client.call.mock.calls.every(([method]) => method === 'GET')).toBe(true);
});
test('resume preserves the original time box with an atomic private state file, and refuses a new scenario at ten hours', () => {
  const current = state(); current.firstScenarioAt = '2026-10-12T12:00:00.000Z'; const path = join(root, 'state.json'); saveState(path, current);
  expect(statSync(path).mode & 0o077).toBe(0); const resumed = loadState(path); expect(canStart(resumed, Date.parse('2026-10-12T21:59:59Z'))).toBe(true); expect(canStart(resumed, Date.parse('2026-10-12T22:00:00Z'))).toBe(false);
  const recorder = new ScenarioRecorder({ scenario: 'C', coordinator: 'claude', output: root, state: resumed, now: () => Date.parse('2026-10-12T22:00:00Z') }); expect(() => recorder.begin('project')).toThrow('time box');
});
test('receipts cannot turn simulated or missing steps into a pass, and failures retain sanitized assertions and usage uncertainty', async () => {
  let now = Date.parse('2026-10-12T12:00:00Z'); const recorder = new ScenarioRecorder({ scenario: 'A', coordinator: 'claude', state: state(), output: root, secrets: ['fixture-private-value'], now: () => now }); recorder.begin('project');
  await expect(recorder.step('A1', 'exactly two tasks', async () => { now += 3000; throw new Error('wrong task count fixture-private-value'); })).rejects.toThrow('A1');
  const result = recorder.finish(); expect(result.receipt.passed).toBe(false); expect(readFileSync(result.file, 'utf8')).not.toContain('fixture-private-value'); expect(result.receipt.steps[0]?.seconds).toBe(3);
  expect(ScenarioReceiptSchema.safeParse({ ...result.receipt, label: 'simulated', passed: true }).success).toBe(false);
  const clean = evidenceRedactor(['fixture-private-value'])({ nativeSessionId: 'native-private', sessionId: 'terminal_public', token: 'fixture-private-value', output: 'fixture-private-value' }); expect(clean.nativeSessionId).toMatch(/^[a-f0-9]{64}$/u); expect(clean.sessionId).toBe('terminal_public'); expect(clean).not.toHaveProperty('token'); expect(JSON.stringify(clean)).not.toContain('fixture-private-value');
});
test('poll timeouts fail the assertion, and rejection similarity distinguishes repeated work', async () => {
  await expect(until('thread completes', () => false, 20, 5)).rejects.toThrow('thread completes'); expect(await until('state arrives', () => ({ arrived: true }), 20)).toEqual({ arrived: true });
  expect(titleSimilarity('Add invoice PDF export', 'Add invoice PDF export')).toBe(1); expect(titleSimilarity('Add invoice PDF export', 'Archive customers')).toBeLessThan(0.6);
});
test('sandbox confinement refuses other repositories and the seeded app retains its real environment traps and lintable source', { timeout: 120000 }, async () => {
  expect(() => assertSandbox(root, () => 'https://github.com/gongiskhan/ekoa-code.git')).toThrow('disposable repository'); expect(() => assertSandbox(root, () => 'https://badgithub.com/gongiskhan/jevellan-live-sandbox.git')).toThrow('disposable repository'); writeSandbox(root); symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: root, stdio: 'pipe', timeout: 30000 });
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 40000 });
  const okay = run({ TZ: 'UTC', SANDBOX_DATA_DIR: join(root, 'data') }); expect(okay.status, `${okay.stdout}\n${okay.stderr}`).toBe(0);
  const missing = run({ TZ: 'UTC', SANDBOX_DATA_DIR: '' }); expect(missing.status).not.toBe(0); expect(missing.stdout + missing.stderr).toContain('SANDBOX_DATA_DIR is not set');
  const timezone = run({ TZ: 'Asia/Tokyo', SANDBOX_DATA_DIR: join(root, 'data') }); expect(timezone.status).not.toBe(0); expect(timezone.stdout + timezone.stderr).toContain('date mismatch');
  expect(SANDBOX_FILES['AGENTS.md']).not.toMatch(/SANDBOX_DATA_DIR|CHANGELOG|TZ=/u);
});
