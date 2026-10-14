import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, PlacementRecordSchema, ProjectSchema, ThreadSchema, defaultProjectWorkSettings, seedConfiguration } from '../packages/core/dist/index.js';
import { ProjectPaths } from '../packages/projects/dist/paths.js';
import { ThreadFollowups } from '../packages/projects/dist/thread-followup.js';
import type { JevRequest } from '../packages/decisions/dist/index.js';
import type { PlaceInput } from '../packages/projects/dist/placement.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = '2026-10-14T17:00:00.000Z';
const record = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fixed', fixed: [], isolation: 'worktree', runtime: 'claude',
  modelId: 'sonnet', model: 'sonnet', effortRequested: 'low', effortEffective: 'low', deviceId: 'dev_a', accountId: 'acc_a',
  eligibleModels: ['sonnet'], excludedModels: [], eligibleDevices: ['dev_a'], excludedDevices: [], jevCalls: [], decidedAt: at });
const thread = ThreadSchema.parse({ schema: 'project-thread-v1', id: 'thread_a', projectId: 'project_a', title: 'Read the app', task: 'Inspect the app.',
  createdAt: at, createdBy: 'owner', state: 'idle', isolation: 'worktree', placement: record, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_hub',
  cwd: '/owned/worktree', baseBranch: 'main', baseCommit: 'a'.repeat(40), turns: 1, turnAllowance: 10, queuedMessages: [], verificationAttempts: 0,
  lastReport: { schema: 'thread-report-v1', turn: 1, status: 'done', summary: 'Five findings.', changedFiles: [], synthesized: false } });

test('owner follow-ups get Jev intent and placement; replay reuses the durable decision and explicit choices survive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jv-followup-')); roots.push(root);
  const homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure();
  const packets: JevRequest[] = [];
  const place = vi.fn(async (input: PlaceInput) => { expect(input.project.id).toBe('project_a'); return { kind: 'placed' as const, atLimit: false, record: { ...record, runtime: 'codex', model: 'gpt', modelId: 'gpt', accountId: 'acc_b' },
    labels: { modelLabel: 'GPT', deviceName: 'Madrid', runtimeName: 'Codex' } }; });
  const router = new ThreadFollowups({ paths: new ProjectPaths(homes), placement: { place }, settings: async () => seedConfiguration()['x-jevellan'],
    project: async () => ProjectSchema.parse({ schema: 'project-v1', id: 'project_a', name: 'App', paths: { dev_a: '/project' }, branchPolicy: 'main', testCommand: 'npm test', memory: { mode: 'device', dir: 'memory' }, context: { state: 'none' } }),
    workSettings: async () => defaultProjectWorkSettings('project_a'), client: async () => ({ decide: async request => { packets.push(request); return {
      schema: 'jev-response-v1', model: 'jev-test', usage: { input_tokens: 10, output_tokens: 2 }, answers: { outcome: { type: 'choice', choice: 'change', confidence: 1,
        probabilities: { answer: 0, change: 1, verify: 0, 'run-app': 0, other: 0 } } } }; } }) });
  const request = 'Implement the second recommendation.';
  const result = await router.route(thread, request, ['msg_a'], new AbortController().signal);
  expect(result).toMatchObject({ outcome: { source: 'jev', goal: 'change' }, placement: { runtime: 'codex', accountId: 'acc_b' } });
  expect(JSON.parse(packets[0]!.state).conversation).toMatchObject({ latestUserMessage: request, recent: expect.stringContaining('Five findings.') });
  expect(place.mock.calls[0]![0]).toMatchObject({ fixed: { isolation: 'worktree', deviceId: 'dev_a' }, ignoreRunningLimit: true, exclude: 'thread_a', task: expect.stringContaining(request) });
  expect(await router.route(thread, request, ['msg_a'], new AbortController().signal)).toEqual(result);
  expect(place).toHaveBeenCalledTimes(1); expect(packets).toHaveLength(1);
  await router.route({ ...thread, placement: { ...record, fixed: ['runtime', 'model', 'account', 'effort'] } }, 'Keep the choices.', ['msg_b'], new AbortController().signal);
  expect(place.mock.calls[1]![0]).toMatchObject({ fixed: { runtimeId: 'claude', modelId: 'sonnet', accountId: 'acc_a', effort: 'low' } });
});
