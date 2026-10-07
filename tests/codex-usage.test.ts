import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, Homes } from '../packages/core/dist/index.js';
import { probeCodex } from '../runtimes/codex/dist/control.js';

let root: string; let homes: Homes;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-codex-usage-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'jevellan'), join(root, 'user'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const window = (minutes: number | null, usedPercent: number, resetsAt: number | null = 1_810_000_000) => ({ usedPercent, windowDurationMins: minutes, resetsAt });
const snapshot = (primary: unknown, secondary: unknown = null, limitId: string | null = 'codex') => ({ limitId, primary, secondary });
async function probe(result: unknown, error = false, accountType: 'chatgpt' | 'apiKey' | null = 'chatgpt') {
  const account = AccountSchema.parse({ schema: 'account-v1', id: 'acc_usage', runtime: 'codex', label: 'Usage fixture', kind: 'subscription', credential: 'per-device', enabled: true });
  const home = homes.account('codex', account.id); const executable = join(root, 'codex-control'); const calls = join(root, 'calls.jsonl');
  const accountReply = accountType === 'chatgpt' ? { type: accountType, email: null, planType: 'fixture' } : accountType ? { type: accountType } : null;
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const request=JSON.parse(line);if(!request.id)return;fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(request)+'\\n');let response;if(request.method==='initialize')response={result:{}};else if(request.method==='account/read'&&request.params.refreshToken===true)response={result:{account:${JSON.stringify(accountReply)},requiresOpenaiAuth:true}};else if(request.method==='account/rateLimits/read')response=${JSON.stringify(error ? { error: { code: -32000, message: '401 fixture-private-provider-detail' } } : { result })};else response={error:{code:-1,message:'Unexpected request'}};console.log(JSON.stringify({id:request.id,...response}));});\n`, { mode: 0o700 });
  const value = await probeCodex({ account, home, env: {} }, executable);
  return { value, methods: readFileSync(calls, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as {method: string}).method) };
}

test('a weekly-only primary window reaches Settings without inventing five-hour usage', async () => {
  const { value, methods } = await probe({ rateLimits: snapshot(window(10080, 35)) });
  expect(value.auth).toBe('ready');
  expect(value.usage).toMatchObject({ source: 'probe', weeklyPct: 35, weeklyResetsAt: new Date(1_810_000_000_000).toISOString() });
  expect(value.usage?.fiveHourPct).toBeUndefined(); expect(value.usage?.fiveHourResetsAt).toBeUndefined();
  expect(methods).toEqual(['initialize', 'account/read', 'account/rateLimits/read']);
});

test.each([false, true])('usage windows are identified by duration, with swapped positions %s', async (swapped) => {
  const five = window(300, 0); const week = window(10080, 82, 1_810_100_000);
  const { value } = await probe({ rateLimits: snapshot(swapped ? week : five, swapped ? five : week) });
  expect(value.usage).toMatchObject({ fiveHourPct: 0, weeklyPct: 82, fiveHourResetsAt: new Date(1_810_000_000_000).toISOString(), weeklyResetsAt: new Date(1_810_100_000_000).toISOString() });
});

test('the explicit Codex bucket is used instead of another metered model bucket', async () => {
  const { value } = await probe({ rateLimits: snapshot(window(300, 99), null, 'base_model_inference'),
    rateLimitsByLimitId: { codex: snapshot(window(10080, 29)), base_model_inference: snapshot(window(300, 99), null, 'base_model_inference') } });
  expect(value.usage?.weeklyPct).toBe(29); expect(value.usage?.fiveHourPct).toBeUndefined();
});

test.each([snapshot(window(15, 30)), snapshot(window(null, 30)), snapshot(null), snapshot(window(300, 30), null, 'other')])('unreported or unrelated windows remain unknown: %j', async (rateLimits) => {
  const { value } = await probe({ rateLimits }); expect(value.auth).toBe('ready'); expect(value.usage).toBeUndefined();
});

test('valid utilization is retained when the provider omits a reset', async () => {
  const { value } = await probe({ rateLimits: snapshot(window(300, 45.5, null)), rateLimitsByLimitId: null });
  expect(value.usage).toMatchObject({ fiveHourPct: 45.5, source: 'probe' }); expect(value.usage?.fiveHourResetsAt).toBeUndefined();
});

test('utilization above the ceiling is capped at 100 rather than making the account look unused', async () => {
  const { value } = await probe({ rateLimits: snapshot(window(300, 101.5)) }); expect(value.usage?.fiveHourPct).toBe(100);
});

test.each([null, { rateLimits: snapshot(window(300, -1)) }, { rateLimits: snapshot(window(300, 10, 9e15)) }])('invalid quota data preserves readiness and exposes no provider details: %j', async (result) => {
  const { value } = await probe(result); expect(value.auth).toBe('ready'); expect(value.usage).toBeUndefined(); expect(value.error).toContain('usage'); expect(JSON.stringify(value)).not.toContain('fixture-private-provider-detail');
});

test('a quota request failure does not erase a successful authentication check or expose its raw error', async () => {
  const { value } = await probe(null, true); expect(value.auth).toBe('ready'); expect(value.usage).toBeUndefined(); expect(value.error).toContain('usage'); expect(JSON.stringify(value)).not.toContain('401');
});

test.each(['apiKey', null] as const)('quota is not requested for an account/read result of %s', async (type) => {
  const { value, methods } = await probe(null, false, type); expect(value.auth).toBe(type ? 'ready' : 'needs-login'); expect(methods).toEqual(['initialize', 'account/read']);
});
