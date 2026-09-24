import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountSchema, Homes } from '../packages/core/dist/index.js';
import { LoginOutput, beginTerminalLogin, loginCallback, type LoginSession } from '../packages/runtime-contract/dist/index.js';
import { claudeUsage, probeClaude } from '../runtimes/claude/dist/control.js';

const token = ['sk', 'ant', 'oat01', 'abC9_'.repeat(19) + 'Z'].join('-');
const intro = 'Token created.\r\nYour OAuth token:\r\n';
const footer = '\x1b[2EStore\x1b[1Cthis\x1b[1Ctoken\x1b[1Csecurely.\r\n';
const outputs: LoginOutput[] = []; const sessions: LoginSession[] = [];
let root: string; let homes: Homes;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-login-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.cancel())); outputs.splice(0).forEach((output) => output.dispose()); await rm(root, { recursive: true, force: true }); });
function output(cols = 200) { const result = new LoginOutput(cols); outputs.push(result); return result; }
function account(runtime: 'codex' | 'claude' = 'claude') { return AccountSchema.parse({ schema: 'account-v1', id: 'acc_login', runtime, label: 'Fixture', kind: 'subscription', credential: runtime === 'codex' ? 'per-device' : 'shared', enabled: true }); }
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 5000; while (!await check()) { if (Date.now() > deadline) throw new Error('Login fixture timed out.'); await delay(20); } }

test.each([12, 33, token.length - 1])('terminal capture waits for the full credential after a chunk split at %i', async (split) => {
  const screen = output(); await screen.write(intro + token.slice(0, split)); expect(screen.token()).toBeUndefined();
  await screen.write(token.slice(split)); expect(screen.token()).toBeUndefined(); await screen.write(footer); expect(screen.token()).toBe(token);
});
test('terminal capture joins soft wraps and interprets cursor separators split across chunks', async () => {
  const screen = output(40); await screen.write(intro + token + '\x1b['); expect(screen.token()).toBeUndefined();
  await screen.write('2EStore\x1b['); await screen.write('1Cthis token securely.'); expect(screen.token()).toBe(token);
});
test('a credential without its completion footer requires successful CLI exit', async () => {
  const screen = output(); await screen.write(intro + token); expect(screen.token()).toBeUndefined(); expect(screen.token(true)).toBe(token);
});
test('callback replay accepts only the active login loopback callback and state', () => {
  const authorization = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fixture';
  expect(loginCallback(authorization, 'http://localhost:1455/auth/callback?code=test&state=fixture').hostname).toBe('127.0.0.1');
  for (const value of ['https://example.com/?code=test&state=fixture', 'http://localhost:1455/private?code=test&state=fixture', 'http://localhost:1455/auth/callback?code=test&state=wrong', 'http://localhost:1456/auth/callback?code=test&state=fixture']) expect(() => loginCallback(authorization, value)).toThrow();
});
test('PTY login stores the complete token directly in the vault callback and exposes only the login link', async () => {
  const executable = join(root, 'login-cli');
  writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write('https://claude.ai/oauth/authorize?state=fixture\\r\\n');\nprocess.stdin.on('data',()=>{process.stdout.write(${JSON.stringify(intro + token.slice(0, 45))});setTimeout(()=>process.stdout.write(${JSON.stringify(token.slice(45) + footer)}),30);});\n`, { mode: 0o700 });
  let captured = ''; const value = account();
  const session = await beginTerminalLogin('claude', value, homes.account('claude', value.id), { homes, executable, saveSecret: async (_id, secret) => { captured = secret; } }); sessions.push(session);
  await until(async () => { await session.poll(); return Boolean(session.url); });
  expect(session.url).toBe('https://claude.ai/oauth/authorize?state=fixture');
  await session.submitCode!('approved'); await until(async () => await session.poll() === 'done');
  expect(captured).toBe(token); expect(JSON.stringify(session)).not.toContain(token);
});
test('Codex falls back only when the installed CLI rejects device-code support', async () => {
  const executable = join(root, 'codex-login-cli');
  writeFileSync(executable, "#!/usr/bin/env node\nif(process.argv.includes('--device-auth')){console.log('unexpected argument --device-auth');process.exit(2);}process.stdout.write('https://auth.openai.com/oauth/authorize?state=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback\\r\\n');setInterval(()=>{},1000);\n", { mode: 0o700 });
  const value = account('codex'); const session = await beginTerminalLogin('codex', value, homes.account('codex', value.id), { homes, executable }); sessions.push(session);
  await until(async () => { await session.poll(); return Boolean(session.url); });
  expect(session.instructions).toContain('Paste its full address'); expect(await session.poll()).toBe('pending'); await session.cancel(); expect(await session.poll()).toBe('failed');
});

const headers = () => new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.46', 'anthropic-ratelimit-unified-7d-utilization': '0.17', 'anthropic-ratelimit-unified-5h-reset': '1784659200', 'anthropic-ratelimit-unified-7d-reset': '1785232800' });
test('usage header windows convert fractions and reset seconds while preserving unknown values', () => {
  const value = claudeUsage(headers())!; expect(value.fiveHourPct).toBe(46); expect(value.weeklyPct).toBe(17); expect(value.fiveHourResetsAt).toBe(new Date(1784659200 * 1000).toISOString());
  expect(claudeUsage(new Headers())).toBeUndefined(); const partial = headers(); partial.delete('anthropic-ratelimit-unified-7d-utilization'); expect(claudeUsage(partial)?.weeklyPct).toBeUndefined();
});
test.each([200, 429, 401, 403, 500])('Claude probe separates authentication from unavailable billing data (HTTP %i)', async (status) => {
  const value = account(); const resolved = { account: value, home: homes.account('claude', value.id), env: { CLAUDE_CODE_OAUTH_TOKEN: token } };
  const fetcher = (async (url, options) => { expect(url).toBe('https://api.anthropic.com/v1/messages'); expect(options?.redirect).toBe('error'); return new Response(null, { status, headers: headers() }); }) as typeof fetch;
  const result = await probeClaude(resolved, fetcher); expect(result.auth).toBe(status === 200 || status === 429 ? 'ready' : status === 401 || status === 403 ? 'needs-login' : 'unknown'); expect(JSON.stringify(result)).not.toContain(token);
});
