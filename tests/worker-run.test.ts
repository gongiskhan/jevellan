import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountSchema, Homes } from '../packages/core/dist/index.js';
import { WorkerRun, groupAlive, type StretchInput, type RuntimeEvent } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes; const runs: WorkerRun[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-worker-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await Promise.all(runs.splice(0).map((run) => run.terminate())); await rm(root, { recursive: true, force: true }); });
function input(brief = 'read environment'): StretchInput {
  const home = homes.account('codex', 'acc_test');
  return { schema: 'stretch-input-v1', conversationId: 'conversation', stretch: 1, action: 'reply', cwd: root, permissions: 'read-only', memoryWrite: false, systemAppend: '', brief, model: 'fixture', effort: 'low', timeoutMs: 10_000,
    account: { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_test', runtime: 'codex', kind: 'subscription', label: 'Fixture', credential: 'per-device', enabled: true }), home, env: { JEVELLAN_TEST_OPENAI_KEY: 'must-not-arrive' } },
    launch: { env: { JEVELLAN_TEST_JEV_KEY: 'must-not-arrive', JEVELLAN_STRETCH_TOKEN: 'fixture-private-scope', JEVELLAN_DAEMON_URL: 'http://127.0.0.1' }, mcpServers: { jevellan: { command: 'fixture-bridge', args: [], env: { JEVELLAN_STRETCH_TOKEN: 'fixture-private-scope' } } } },
  };
}
function launch(value = input()) { const run = new WorkerRun('codex', fileURLToPath(new URL('./fixtures/runtime-worker.mjs', import.meta.url)), value, { homes }); runs.push(run); return run; }
async function collect(run: WorkerRun): Promise<RuntimeEvent[]> { const events: RuntimeEvent[] = []; for await (const event of run.events) events.push(event); return events; }

test('owned worker validates/redacts events and strips secrets from stdin and arguments', async () => {
  const run = launch(); const events = await collect(run);
  expect(await run.done).toEqual({ status: 'completed' });
  const text = events.find((event) => event.type === 'text');
  if (text?.type !== 'text') throw new Error('Missing fixture event.');
  const output = JSON.parse(text.delta) as { keys: string[]; inputEnv: object; launchEnv: object; mcp: Record<string, { env: object }>; argv: string[]; token: string };
  expect(output.keys.some((key) => key.startsWith('JEVELLAN_TEST_'))).toBe(false);
  expect(output.inputEnv).toEqual({}); expect(output.launchEnv).toEqual({}); expect(output.mcp.jevellan?.env).toEqual({}); expect(output.argv).toEqual([]);
  expect(output.token).toBe('[redacted]'); expect(run.native.sessionId).toBe('fixture-session');
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});

test('interrupt settles a turn, continuation uses the same worker, and termination removes descendants', async () => {
  const run = launch(input('wait-for-interrupt'));
  const iterator = run.events[Symbol.asyncIterator]();
  const first = await iterator.next(); expect(first.value?.type).toBe('tool-start');
  const pid = run.native.pid;
  await run.interrupt('steer'); expect((await run.done).status).toBe('interrupted');
  const continued = run.continue('repair', 5000); const events = await collect(run); await continued;
  expect(events.some((event) => event.type === 'text')).toBe(true); expect(run.native.pid).toBe(pid);
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});

test('launch rejects an action with incorrect permissions and an unscoped bridge environment', () => {
  expect(() => launch({ ...input(), permissions: 'write' })).toThrow('read-only');
  const wrong = input(); wrong.launch.mcpServers.jevellan!.env.JEVELLAN_STRETCH_TOKEN = 'different';
  expect(() => launch(wrong)).toThrow('scoped inherited');
});
