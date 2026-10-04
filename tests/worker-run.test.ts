import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AccountSchema, Homes } from '../packages/core/dist/index.js';
import { WorkerRun, groupAlive, type StretchInput, type RuntimeEvent, type TurnInput } from '../packages/runtime-contract/dist/index.js';

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

const identity = { GIT_AUTHOR_NAME: 'Fixture Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Fixture Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' };
function turn(prompt = 'Report the environment.'): TurnInput {
  const base = input();
  return { schema: 'turn-input-v1', owner: { kind: 'thread', projectId: 'proj_fixture', id: 'thread_fixture' }, turn: 2, cwd: root, permissions: 'write', model: 'fixture', effort: 'low', account: base.account,
    systemAppend: 'FIXTURE_APPEND', prompt, resume: { sessionId: 'stored-session' }, launch: { env: { ...base.launch.env, ...identity }, mcpServers: base.launch.mcpServers }, safetyProfile: 'thread', timeoutMs: 10_000 };
}
function launchTurn(value = turn(), worker = fileURLToPath(new URL('./fixtures/runtime-worker.mjs', import.meta.url))) { const run = WorkerRun.turn('codex', worker, value, { homes }); runs.push(run); return run; }

test('a turn worker receives its prompt verbatim and the owner identity, never secrets, and refuses continuation', async () => {
  const run = launchTurn(); const events = await collect(run);
  expect(await run.done).toEqual({ status: 'completed' });
  const text = events.find((event) => event.type === 'text');
  if (text?.type !== 'text') throw new Error('Missing fixture event.');
  const output = JSON.parse(text.delta) as { keys: string[]; inputEnv: object; launchEnv: object; mcp: Record<string, { env: object }>; argv: string[]; token: string; gitAuthor: string; gitCommitter: string; owner: object; resume: object; prompt: string };
  expect(output.keys.some((key) => key.startsWith('JEVELLAN_TEST_'))).toBe(false);
  expect(output.inputEnv).toEqual({}); expect(output.launchEnv).toEqual({}); expect(output.mcp.jevellan?.env).toEqual({}); expect(output.argv).toEqual([]);
  expect(output.token).toBe('[redacted]');
  expect(output).toMatchObject({ gitAuthor: 'Fixture Owner', gitCommitter: 'owner@example.invalid', owner: { kind: 'thread', projectId: 'proj_fixture', id: 'thread_fixture' }, resume: { sessionId: 'stored-session' }, prompt: 'Report the environment.' });
  expect(run.native.sessionId).toBe('stored-session');
  await expect(run.continue('More.', 5000)).rejects.toThrow('Turns do not continue; start a new turn.');
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});

test('a turn launch rejects a relative path, a foreign home and an owner that does not match its permissions', () => {
  expect(() => launchTurn({ ...turn(), cwd: 'relative/project' })).toThrow('A turn needs an absolute working directory.');
  const foreign = join(root, 'foreign-home'); mkdirSync(foreign);
  expect(() => launchTurn({ ...turn(), account: { ...turn().account, home: foreign } })).toThrow('not owned by Jevellan');
  expect(() => launchTurn({ ...turn(), safetyProfile: 'coordinator' })).toThrow('The safety profile must match the turn owner.');
  expect(() => launchTurn({ ...turn(), owner: { kind: 'coordinator', projectId: 'proj_fixture', id: 'proj_fixture' }, safetyProfile: 'coordinator' })).toThrow('Coordinator turns are read-only and thread turns write.');
  expect(() => launchTurn({ ...turn(), permissions: 'read-only' })).toThrow('Coordinator turns are read-only and thread turns write.');
  const wrong = turn(); wrong.launch.mcpServers.jevellan!.env.JEVELLAN_STRETCH_TOKEN = 'different';
  expect(() => launchTurn(wrong)).toThrow('scoped inherited');
});

test('a worker without a turn factory fails the turn cleanly', async () => {
  const worker = join(root, 'stretch-only-worker.mjs');
  writeFileSync(worker, `import { serveWorker } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../packages/runtime-contract/dist/index.js', import.meta.url))).href)};\nserveWorker(() => ({ async interrupt() {}, async run() { return { status: 'completed' }; } }));\n`);
  const run = launchTurn(turn(), worker);
  expect(await run.done).toEqual({ status: 'failed', error: { kind: 'other', message: 'This runtime does not run turns.' } });
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});
