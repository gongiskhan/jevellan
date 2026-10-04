import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, PlacementRecordSchema, ThreadSchema, type Thread } from '../packages/core/dist/index.js';
import { writeFakeNativeSession } from '../packages/runtime-contract/dist/index.js';
import { NATIVE_SESSION_UNAVAILABLE } from '../packages/mesh/dist/index.js';
import { ThreadTranscripts, assistantText } from '../packages/projects/dist/index.js';

let root: string; let homes: Homes;
const at = '2026-10-03T10:00:00.000Z';
const thread = (runtime: string, over: Partial<Thread> = {}): Thread => ThreadSchema.parse({ schema: 'project-thread-v1', id: 'thread_1', projectId: 'proj_a', title: 'Fix login',
  task: 'The redirect loops.', createdAt: at, createdBy: 'owner', state: 'running', isolation: 'worktree', ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_a',
  placement: PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fixed', fixed: [], isolation: 'worktree', runtime, modelId: 'swift', model: 'swift-version',
    effortRequested: 'medium', effortEffective: 'medium', deviceId: 'dev_a', accountId: 'acc_a', eligibleModels: [], excludedModels: [], eligibleDevices: [], excludedDevices: [], jevCalls: [], decidedAt: at }),
  cwd: '/w/t', baseBranch: 'main', baseCommit: 'a'.repeat(40), turns: 1, turnAllowance: 30, queuedMessages: [], verificationAttempts: 0, ...over });
const sessionId = '0f6a1c2e-5b7d-4e8f-9a1b-2c3d4e5f6a7b';

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-transcripts-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('thread transcripts come from the account home through the worker, cached by file state with one read in flight', async () => {
  const transcripts = new ThreadTranscripts({ homes, deviceId: 'dev_a', deviceName: 'Mac mini' });
  expect(await transcripts.read(thread('claude'), 'Shop')).toBeNull();
  const home = join(homes.root, 'homes', 'claude', 'acc_a'); const live = thread('claude', { nativeSessionId: sessionId });
  writeFakeNativeSession({ format: 'claude', home, sessionId, cwd: '/w/t', append: false, rows: [{ role: 'user', text: 'Task: Fix login' }, { role: 'assistant', text: 'Looking.' },
    { role: 'assistant', text: 'Fixed it.', tools: [{ id: 'tool_1', name: 'Bash', input: { command: 'npm test' }, output: 'ok' }] }] });
  const [first, second] = await Promise.all([transcripts.read(live, 'Shop'), transcripts.read(live, 'Shop')]);
  expect(second).toBe(first); expect(first!.session).toMatchObject({ title: 'Fix login', project: 'Shop', deviceName: 'Mac mini' });
  expect(assistantText(first!)).toBe('Looking.\n\nFixed it.'); expect(assistantText(first!, 5)).toBe('d it.');
  expect(await transcripts.read(live, 'Shop')).toBe(first);
  writeFakeNativeSession({ format: 'claude', home, sessionId, cwd: '/w/t', append: true, rows: [{ role: 'user', text: 'Also log it.' }, { role: 'assistant', text: 'Logged.' }] });
  const updated = await transcripts.read(live, 'Shop'); expect(updated).not.toBe(first); expect(assistantText(updated!)).toBe('Looking.\n\nFixed it.\n\nLogged.');
  // A missing session is a 404, and a missing account home is read, never created.
  await expect(transcripts.read(thread('claude', { nativeSessionId: 'missing-session' }), 'Shop')).rejects.toMatchObject({ message: NATIVE_SESSION_UNAVAILABLE, status: 404 });
  await expect(transcripts.read(thread('codex', { nativeSessionId: sessionId }), 'Shop')).rejects.toMatchObject({ status: 404 });
  expect(existsSync(join(homes.root, 'homes', 'codex'))).toBe(false);
});

test('the transcript format resolver is injectable for runtimes that write Codex sessions', async () => {
  writeFakeNativeSession({ format: 'codex', home: join(homes.root, 'homes', 'fake', 'acc_a'), sessionId, cwd: '/w/t', append: false, rows: [{ role: 'user', text: 'Task: Fix login' }, { role: 'assistant', text: 'Done.' }] });
  const live = thread('fake', { nativeSessionId: sessionId });
  await expect(new ThreadTranscripts({ homes, deviceId: 'dev_a', deviceName: 'Mac mini' }).read(live, 'Shop')).rejects.toMatchObject({ status: 404 });
  const transcript = await new ThreadTranscripts({ homes, deviceId: 'dev_a', deviceName: 'Mac mini', format: () => 'codex' }).read(live, 'Shop');
  expect(assistantText(transcript!)).toBe('Done.');
});
