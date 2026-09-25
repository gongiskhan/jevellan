import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountSchema, BridgeRequestSchema, Homes, RiggingItemSchema, SecretRedactor, projectMemoryHooks } from '../packages/core/dist/index.js';
import { createRuntime as claude } from '../runtimes/claude/dist/index.js';
import { createRuntime as codex } from '../runtimes/codex/dist/index.js';
import { runContractTests, contractChecks, collectEvents, checkEventsAndContinuation, checkInterruption, checkConcurrentIsolation, checkGroupTermination, SAFETY_REASON, type RuntimeAdapter, type StretchInput } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan.contracts-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function answer(adapter: RuntimeAdapter, input: StretchInput) {
  const run = adapter.startStretch(input);
  try { const events = await collectEvents(run); const done = await run.done; expect(done.status, done.error?.message).toBe('completed'); return events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join(''); }
  finally { await run.terminate(); }
}

function setup(runtime: 'claude' | 'codex') {
  const executable = join(root, 'fixture-cli');
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixtures/contract-cli.mjs', import.meta.url)))} "$@"\n`, { mode: 0o700 });
  const input: StretchInput = { schema: 'stretch-input-v1', conversationId: 'fixture', stretch: 1, action: 'reply', cwd: root, permissions: 'read-only', memoryWrite: false, systemAppend: '', brief: 'Read the fixture.', model: 'fixture-model', effort: 'low', timeoutMs: 10_000,
    account: { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_fixture', runtime, label: 'Fixture', kind: 'subscription', credential: runtime === 'codex' ? 'per-device' : 'shared', enabled: true }), home: homes.account(runtime, 'acc_fixture'), env: {} }, launch: { mcpServers: {}, env: {} } };
  return { executable, input };
}

test.each(['claude', 'codex'] as const)('%s runs all seven contract cases through the production adapter and simulated CLI', async (runtime) => {
  const { executable, input } = setup(runtime);
  const directive = (value: unknown): StretchInput => ({ ...input, brief: `CONTRACT:${JSON.stringify(value)}` });
  const scoped = (name: string) => {
    const cwd = join(root, name); mkdirSync(cwd);
    const env = { JEVELLAN_STRETCH_TOKEN: randomBytes(32).toString('hex'), JEVELLAN_DAEMON_URL: `http://127.0.0.1/${name}` };
    return { input: { ...directive({ mode: 'isolation' }), cwd, launch: { env, mcpServers: { jevellan: { command: process.execPath, args: [fileURLToPath(new URL('../scripts/spikes/bridge.mjs', import.meta.url))], env } } } }, marker: `memory-for-${name}` };
  };
  const result = await runContractTests(runtime === 'claude' ? claude : codex, { context: { homes, executable, redactor: new SecretRedactor() }, cases: {
    interrupt: { evidence: 'simulated', run: (adapter) => checkInterruption(adapter, directive({ mode: 'waiting' }), (event) => event.type === 'tool-start') },
    'events-and-usage': { evidence: 'simulated', run: async (adapter) => {
      const run = adapter.startStretch(input);
      try { const events = await collectEvents(run); expect((await run.done).status).toBe('completed'); for (const type of ['text', 'tool-start', 'tool-end', 'usage']) expect(events.some((event) => event.type === type)).toBe(true); }
      finally { await run.terminate(); }
    } },
    'continue-session': { evidence: 'simulated', run: (adapter) => checkEventsAndContinuation(adapter, input, { message: 'Remember?', expectedText: 'remembered-fixture' }) },
    'concurrent-isolation': { evidence: 'simulated', run: (adapter) => checkConcurrentIsolation(adapter, [scoped('project-a'), scoped('project-b')], runtime === 'claude' ? 'mcp__jevellan__memory_read' : 'jevellan.memory_read') },
    'read-only': { evidence: 'simulated', run: async (adapter) => {
      const response: unknown = JSON.parse(await answer(adapter, directive({ mode: 'read-only', requests: [{ tool: 'Write', input: { file_path: join(root, 'blocked'), content: 'test' } }, { tool: 'Bash', input: { command: 'printf test > blocked' } }] })));
      if (runtime === 'codex') expect(response).toMatchObject({ sandbox: 'read-only', approval: 'never', cwd: root, projectTrust: 'untrusted' });
      else expect(response).toEqual([expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) }), expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) })]);
    } },
    safety: { evidence: 'simulated', run: async (adapter) => {
      const commands = ['git -C . push', 'git rebase origin/main', 'git reset HEAD --hard', 'git clean -fd', 'git branch old -D', 'gh repo edit owner/repo --visibility public', 'gh repo delete owner/repo', 'jevellan stop', 'jevellan restart', 'jevellan update', 'jevellan uninstall', 'jevellan install', 'jevellan rollback', 'npx github:gongiskhan/jevellan install', 'node /tmp/distribution/bin/jevellan.mjs rollback', 'launchctl kickstart gui/501/dev.jevellan.daemon', 'systemctl --user restart jevellan.service', `kill -9 ${process.pid}`, 'rm -rf ../outside'];
      const result: unknown = JSON.parse(await answer(adapter, { ...directive({ mode: 'safety', requests: commands.map((command) => ({ tool: 'Bash', input: { command } })) }), action: 'implement', permissions: 'write' }));
      expect(result).toEqual(commands.map(() => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SAFETY_REASON } })));
    } },
    'terminate-group': { evidence: 'simulated', run: (adapter) => checkGroupTermination(adapter, directive({ mode: 'waiting' }), (event) => event.type === 'tool-start') },
  } });
  expect(result).toEqual(contractChecks.map((check) => ({ check, evidence: 'simulated', status: 'passed' })));
}, 45_000);

test.each(['claude', 'codex'] as const)('%s keeps the native session but removes writing permissions during handoff repair', async (runtime) => {
  const { executable, input } = setup(runtime);
  const adapter = (runtime === 'claude' ? claude : codex)({ homes, executable });
  const requests = [
    { tool: 'Write', input: { file_path: join(root, 'blocked'), content: 'repair must not write' } },
    { tool: 'Bash', input: { command: 'printf repair > blocked' } },
    { tool: 'mcp__jevellan__memory_write', input: { title: 'Repair', content: 'must not write memory' } },
    { tool: 'mcp__jevellan__jevellan_handoff', input: {} },
  ];
  const prompt = `CONTRACT:${JSON.stringify({ mode: 'permissions', requests })}`;
  const run = adapter.startStretch({ ...input, action: 'implement', permissions: 'write', memoryWrite: true, brief: prompt });
  const response = async () => {
    const events = await collectEvents(run); expect((await run.done).status).toBe('completed');
    return JSON.parse(events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join('')) as unknown;
  };
  try {
    const original = await response(); const sessionId = run.native.sessionId;
    expect(sessionId).toBeTruthy();
    if (runtime === 'codex') expect(original).toMatchObject({ sandbox: 'workspace-write', network: true });
    else expect(original).toMatchObject({ permissionMode: 'bypassPermissions', bypassAllowed: true, replies: [{}, {}, {}, {}] });
    const continuing = run.continue(prompt, 5000);
    const repaired = await response(); await continuing;
    expect(run.native.sessionId).toBe(sessionId);
    if (runtime === 'codex') expect(repaired).toMatchObject({ sandbox: 'read-only', network: false, approval: 'never' });
    else expect(repaired).toMatchObject({ permissionMode: 'dontAsk', bypassAllowed: false, replies: [
      { hookSpecificOutput: { permissionDecision: 'deny' } },
      { hookSpecificOutput: { permissionDecision: 'deny' } },
      { hookSpecificOutput: { permissionDecision: 'deny' } },
      {},
    ] });
  } finally { await run.terminate(); }
}, 15_000);

test.each(['claude', 'codex'] as const)('%s keeps APM account capture and per-launch Safety together with isolated concurrent hook scopes', async (runtime) => {
  const { executable, input } = setup(runtime); const adapter = (runtime === 'claude' ? claude : codex)({ homes, executable });
  const deliveries = await adapter.materialiseRigging(input.account.home, [RiggingItemSchema.parse({ schema: 'rigging-item-v1', id: 'builtin_project_memory', name: 'Project memory', kind: 'hook', runtime, state: 'owned', enabled: true, builtIn: true, content: JSON.stringify(projectMemoryHooks()), updatedAt: new Date().toISOString() })]);
  expect(deliveries).toMatchObject([{ itemId: 'builtin_project_memory', applied: true }]);
  const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]; const calls: Array<{ scope: number; event: string }> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const scope = tokens.findIndex((token) => request.headers.authorization === `Bearer ${token}`); const parsed = BridgeRequestSchema.parse(JSON.parse(body));
    if (scope < 0 || request.url !== '/api/bridge' || parsed.operation !== 'memory-capture') { response.writeHead(403).end(); return; }
    calls.push({ scope, event: parsed.event }); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ schema: 'bridge-result-v1', result: { queued: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = await Promise.all(tokens.map((token, n) => {
      const cwd = join(root, `project-${n}`); mkdirSync(cwd);
      return answer(adapter, { ...input, action: 'implement', permissions: 'write', memoryWrite: true, cwd, brief: 'CONTRACT:{"mode":"memory-hooks"}', timeoutMs: 20_000, launch: { mcpServers: {}, env: { JEVELLAN_STRETCH_TOKEN: token, JEVELLAN_DAEMON_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } } });
    }));
    for (const result of results) expect(JSON.parse(result)).toEqual({ captures: [[{}], [{}], [{}]], safety: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SAFETY_REASON } } });
    for (const scope of [0, 1]) expect(calls.filter((call) => call.scope === scope).map((call) => call.event)).toEqual(['PreCompact', 'Stop', 'SessionEnd']);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
}, 60_000);
