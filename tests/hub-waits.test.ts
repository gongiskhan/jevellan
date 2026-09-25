import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, HubWaitSchema } from '../packages/core/dist/index.js';
import { HubUnavailable } from '../packages/mesh/dist/index.js';
import { ConversationLedger, ConversationWork } from '../packages/conversations/dist/index.js';
import { HubWaits, recoverHubWaits } from '../packages/conversations/dist/hub-waits.js';

let root: string; let work: ConversationWork;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-hub-wait-')); mkdirSync(join(root, 'user'));
  work = new ConversationWork(new ConversationLedger(new Homes(join(root, 'data'), join(root, 'user')), 'conversation'));
  work.create({ title: 'Fixture', projectId: 'project', ownerDeviceId: 'device' }); work.message('Keep this request.', 'first');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const records = () => work.ledger.events().flatMap(event => {
  const parsed = HubWaitSchema.safeParse(work.ledger.data(event)); return parsed.success ? [parsed.data] : [];
});

test('a heartbeat during a failed request is not lost, and repeated pulses do not duplicate a completed boundary', async () => {
  const waits = new HubWaits(); const abort = new AbortController(); const counters = work.load().conversation.work!.counters;
  let attempts = 0;
  const result = await waits.retry(work, abort.signal, 'settings', async () => {
    if (++attempts === 1) { waits.reachable(); throw new HubUnavailable('Fixture hub'); }
    return 'fresh settings';
  });
  expect(result).toBe('fresh settings'); expect(attempts).toBe(2); waits.reachable(); waits.reachable();
  expect(attempts).toBe(2); expect(records().map(record => record.status)).toEqual(['waiting', 'completed']);
  expect(work.load().conversation.work!.counters).toEqual(counters);
});

test('cancelling an offline boundary releases its continuation and a later heartbeat cannot run it', async () => {
  const waits = new HubWaits(); const abort = new AbortController(); let attempts = 0;
  const result = waits.retry(work, abort.signal, 'launch', async () => { attempts++; throw new HubUnavailable('Fixture hub'); });
  const stopped = expect(result).rejects.toThrow('Stopped');
  await vi.waitFor(() => expect(records()).toHaveLength(1)); abort.abort(new Error('Stopped')); await stopped;
  waits.reachable(); expect(attempts).toBe(1); expect(records().at(-1)?.status).toBe('interrupted');
});

test('an ordinary error carrying status 503 remains an error and is never treated as an offline hub', async () => {
  const waits = new HubWaits(); const error = Object.assign(new Error('Provider unavailable'), { status: 503 });
  await expect(waits.retry(work, new AbortController().signal, 'launch', async () => { throw error; })).rejects.toBe(error);
  expect(records()).toEqual([]);
});

test('restart preserves the pending boundary as interrupted evidence and does not create a continuation', () => {
  const current = work.load().conversation;
  work.ledger.append({ type: 'notice', data: HubWaitSchema.parse({ schema: 'hub-wait-v1', id: 'pending', workId: current.work!.id,
    generation: current.generation, boundary: 'decision', status: 'waiting', message: "Can't reach the hub (Fixture hub). This will continue when it's back.", at: new Date().toISOString() }) });
  recoverHubWaits(work); new HubWaits().reachable();
  expect(work.load().conversation.state).toBe('waiting-for-you'); expect(work.load().pause?.reason).toContain('no step was relaunched');
  expect(work.load().stretches).toEqual([]); expect(records().at(-1)?.status).toBe('interrupted');
  const count = work.ledger.events().length; recoverHubWaits(work); expect(work.ledger.events()).toHaveLength(count);
});

test('closing cleanup can wait for the hub without reopening its completed work', async () => {
  const current = work.load().conversation; const owner = { workId: current.work!.id, generation: current.generation }; work.close('done');
  const waits = new HubWaits(); let reachable = false;
  const cleanup = waits.retry(work, new AbortController().signal, 'checkout-release', async () => { if (!reachable) throw new HubUnavailable('Fixture hub'); }, { owner });
  await vi.waitFor(() => expect(records()).toHaveLength(1)); expect(work.load().conversation.state).toBe('done'); expect(work.load().conversation.work).toBeNull();
  reachable = true; waits.reachable(); await cleanup;
  expect(work.load().closedWorks).toHaveLength(1); expect(work.load().conversation.state).toBe('done'); expect(records().at(-1)).toMatchObject({ ...owner, status: 'completed' });
});
