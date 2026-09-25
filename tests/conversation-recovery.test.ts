import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Homes, StretchSchema, groupAlive, processIdentity, terminateGroup, type NativeProcess } from '../packages/core/dist/index.js';
import { ConversationLedger, ConversationWork, RESTART_NOTICE, recoverRunningWork } from '../packages/conversations/dist/index.js';

let root: string; let homes: Homes; let work: ConversationWork;
const processes: NativeProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-restart-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  work = new ConversationWork(new ConversationLedger(homes, 'conversation')); work.create({ title: 'Restart fixture', projectId: 'project', ownerDeviceId: 'device' }); work.message('Keep this original request.', 'first');
  const view = work.load();
  work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'reply', modelId: 'model', runtime: 'fake', model: 'fixture', effortRequested: 'high', effortEffective: 'high', accountId: 'account', deviceId: 'device', decisionId: 'decision', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }), view.conversation.generation);
});
afterEach(async () => { await Promise.all(processes.splice(0).map((native) => terminateGroup(native, 100))); rmSync(root, { recursive: true, force: true }); });
async function start(program = 'setInterval(()=>{},1000)') {
  const child = spawn(process.execPath, ['-e', program], { detached: true, stdio: 'ignore', env: { MARKER: join(root, 'child.pid') } }); await once(child, 'spawn');
  const native = processIdentity(child.pid!); processes.push(native); work.native(1, native); return { child, native };
}
function handoff() { return { schema: 'handoff-v2' as const, stretch: 1, action: 'reply' as const, status: 'done' as const, summary: 'Native answer already handed off.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] }; }

test('restart kills a real worker and descendant before recording interruption, without launching a successor', async () => {
  const { native } = await start('const {spawn}=require("node:child_process"); const fs=require("node:fs"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(process.env.MARKER,String(child.pid)); setInterval(()=>{},1000);');
  let descendant = 0;
  for (let n = 0; n < 100; n++) { try { descendant = Number(readFileSync(join(root, 'child.pid'), 'utf8')); break; } catch { await delay(10); } }
  expect(descendant).toBeGreaterThan(1);
  work.runtimeEvent('text', { type: 'text', delta: 'Keep partial output.' }, 1); work.runtimeEvent('tool-start', { type: 'tool-start', id: 'tool', name: 'Read', input: { path: 'src/sum.ts' } }, 1);
  work.runtimeEvent('usage', { type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.02 }, 1);
  const recovered = new ConversationWork(new ConversationLedger(homes, work.ledger.id));
  expect(await recoverRunningWork(recovered)).toEqual({ recovered: [1], blocked: [] });
  expect(groupAlive(native.pgid)).toBe(false); expect(() => process.kill(descendant, 0)).toThrow();
  const view = recovered.load(); expect(view.conversation).toMatchObject({ state: 'waiting-for-you', stretchCount: 1, work: { request: 'Keep this original request.' } });
  expect(view.pause?.reason).toBe(RESTART_NOTICE); expect(view.stretches[0]).toMatchObject({ status: 'interrupted', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.02 } });
  expect(view.handoffs[0]).toMatchObject({ status: 'partial', evidence: [{ ref: expect.stringMatching(/^ledger\//) }] });
  expect(work.ledger.search('Keep partial output.')).not.toEqual([]);
  const count = work.ledger.events().length; expect(await recoverRunningWork(recovered)).toEqual({ recovered: [], blocked: [] }); expect(work.ledger.events()).toHaveLength(count);
});

test('restart preserves an accepted native handoff exactly, even when the process already exited', async () => {
  const { child, native } = await start(); work.ledger.acceptHandoff(handoff());
  const closed = once(child, 'close'); await terminateGroup(native, 100); await closed;
  await recoverRunningWork(work); expect(work.ledger.handoffs()).toEqual([handoff()]); expect(work.load().stretches[0]?.status).toBe('interrupted');
});

test('a reused process identity remains alive and leaves the stretch unsettled', async () => {
  const { native } = await start(); work.native(1, { ...native, startIdentity: 'different-start-identity' });
  const result = await recoverRunningWork(work); expect(result.recovered).toEqual([]); expect(result.blocked[0]?.reason).toContain('reused process identity');
  expect(groupAlive(native.pgid)).toBe(true); expect(work.load().conversation.state).toBe('running'); expect(work.ledger.handoffs()).toEqual([]);
});

test('missing process identity cannot manufacture a cleanup receipt or release running work', async () => {
  expect((await recoverRunningWork(work)).blocked[0]?.reason).toContain('no recorded process identity');
  expect(work.load().stretches[0]?.status).toBe('running'); expect(work.ledger.handoffs()).toEqual([]);
});

test('a crash after the recovery event cannot lose the waiting state or its restart notice', async () => {
  const { native } = await start(); const write = work.ledger.writeProjection.bind(work.ledger);
  vi.spyOn(work.ledger, 'writeProjection').mockImplementation((path, schema, value) => {
    if (work.ledger.events().some((event) => event.type === 'stretch-end')) throw new Error('Simulated projection interruption');
    return write(path, schema, value);
  });
  await expect(recoverRunningWork(work)).rejects.toThrow('projection interruption'); expect(groupAlive(native.pgid)).toBe(false);
  const reopened = new ConversationWork(new ConversationLedger(homes, work.ledger.id));
  expect(await recoverRunningWork(reopened)).toEqual({ recovered: [], blocked: [] });
  expect(reopened.load().conversation.state).toBe('waiting-for-you'); expect(reopened.load().pause?.reason).toBe(RESTART_NOTICE);
});
