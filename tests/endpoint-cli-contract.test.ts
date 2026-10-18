import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AccountSchema } from '../packages/core/dist/index.js';
import { launchEnvironment } from '../packages/runtime-contract/dist/worker-run.js';
const require = createRequire(import.meta.url);
let cli: string | undefined; try { cli = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`); } catch { /* The SDK CLI is not installed on this platform. */ }
let trace: string | undefined; if (process.platform === 'linux') try { trace = execFileSync('which', ['strace'], { encoding: 'utf8' }).trim(); } catch { /* A missing network tracer is reported, not a pass. */ }
const guard = process.platform === 'darwin' ? 'macos-sandbox' : trace ? 'linux-strace' : undefined;
const quote = (value: string) => `'${value.replace(/'/gu, `'"'"'`)}'`;
const EvidenceSchema = z.strictObject({ schema: z.literal('endpoint-cli-contract-v1'), label: z.enum(['simulated', 'not run']), passed: z.boolean(), reason: z.string().optional(), requests: z.array(z.string()), connections: z.number(), nativeFixturesUnchanged: z.boolean(), networkGuard: z.string().optional() });
const output = 'docs/acceptance/projects-parity-2026-10/phase-8/cli-contract.json';
function evidence(input: z.input<typeof EvidenceSchema>) { mkdirSync(join(output, '..'), { recursive: true }); writeFileSync(output, JSON.stringify(EvidenceSchema.parse(input), null, 2) + '\n'); }
if (!cli || !guard) evidence({ schema: 'endpoint-cli-contract-v1', label: 'not run', passed: false, reason: !cli ? 'The SDK Claude CLI is not installed.' : 'The network guard for the real CLI contract is unavailable.', requests: [], connections: 0, nativeFixturesUnchanged: false });
test.skipIf(!cli || !guard)('real Claude Agent SDK uses only the fake endpoint and leaves fixture native homes byte-identical', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-endpoint-contract-')), home = join(root, 'owned'), native = join(root, 'user', '.claude'); mkdirSync(home); mkdirSync(native, { recursive: true });
  const original = '{"fixture":"native setup must stay identical"}\n'; writeFileSync(join(native, 'settings.json'), original);
  const nativeCodex = join(root, 'user', '.codex'); mkdirSync(nativeCodex); writeFileSync(join(nativeCodex, 'config.toml'), original);
  const requests: string[] = [], outsideProxy: string[] = []; let connections = 0; const bodies: Array<Record<string, unknown>> = [], authorization: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(request.url!); authorization.push(request.headers.authorization ?? '');
    if (request.url!.startsWith('/v1/messages/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return; }
    if (!request.url!.startsWith('/v1/messages')) { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":{"type":"not_found_error","message":"Fixture route missing"}}'); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; bodies.push(body);
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-glm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Endpoint contract works.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.on('connection', () => connections++); server.on('connect', (request, socket) => { outsideProxy.push(request.url ?? 'unknown'); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  const log = join(root, 'network.txt'), wrapper = join(root, 'claude-contract');
  const profile = `(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:${port}"))`;
  writeFileSync(wrapper, `#!/bin/sh\nexec ${guard === 'macos-sandbox' ? `/usr/bin/sandbox-exec -p ${quote(profile)}` : `${quote(trace!)} -f -qq -e trace=connect -s 200 -o ${quote(log)}`} ${quote(cli!)} "$@"\n`); chmodSync(wrapper, 0o700);
  const account = AccountSchema.parse({ schema: 'account-v2', id: 'contract', runtime: 'claude', label: 'Contract', kind: 'endpoint', enabled: true, credential: 'shared', endpoint: { baseUrl: `http://127.0.0.1:${port}`, billing: 'free', models: [{ id: 'fixture-glm', label: 'Fixture GLM', efforts: ['medium'], description: 'Contract testing.' }] } });
  const env = launchEnvironment('claude', { account: { account, home, env: { ANTHROPIC_BASE_URL: account.endpoint!.baseUrl, ANTHROPIC_AUTH_TOKEN: 'fixture endpoint credential', ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-glm', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-glm', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-glm', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }, launch: { env: {}, mcpServers: {} } });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  const runtime = query({ prompt: 'Answer with one short sentence.', options: { pathToClaudeCodeExecutable: wrapper, cwd: home, env: { ...env, HTTP_PROXY: account.endpoint!.baseUrl, HTTPS_PROXY: account.endpoint!.baseUrl, NO_PROXY: '127.0.0.1,localhost' }, model: 'fixture-glm', effort: 'medium', tools: [], allowedTools: [], settingSources: [], permissionMode: 'dontAsk', maxTurns: 1, abortController: controller, stderr: () => {} } });
  try {
    let result = ''; for await (const event of runtime) if (event.type === 'result') { expect(event.subtype).toBe('success'); if (event.subtype === 'success') result = event.result; }
    expect(result).toBe('Endpoint contract works.'); expect(bodies.length).toBeGreaterThan(0); expect(bodies.every(body => body.model === 'fixture-glm')).toBe(true); expect(authorization.every(value => value === 'Bearer fixture endpoint credential')).toBe(true);
    expect(outsideProxy).toEqual([]); expect(requests.every(path => path.startsWith('/v1/messages'))).toBe(true); expect(connections).toBeGreaterThan(0);
    if (guard === 'linux-strace') {
      const attempts = readFileSync(log, 'utf8').split('\n').filter(line => /connect\(.*AF_INET/u.test(line)); expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every(line => line.includes(`htons(${port})`) && line.includes('127.0.0.1'))).toBe(true);
    }
    expect(readFileSync(join(native, 'settings.json'), 'utf8')).toBe(original); expect(readFileSync(join(nativeCodex, 'config.toml'), 'utf8')).toBe(original);
    evidence({ schema: 'endpoint-cli-contract-v1', label: 'simulated', passed: true, requests, connections, nativeFixturesUnchanged: true, networkGuard: guard });
  } finally { clearTimeout(timer); runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
