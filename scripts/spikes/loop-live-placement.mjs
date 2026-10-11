import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { AccountSchema, AccountStatusSchema, ProjectSchema, SecretRedactor, seedConfiguration } from '../../packages/core/dist/index.js';
import { decidePlacement, JevClient } from '../../packages/decisions/dist/index.js';
const Receipt = z.strictObject({ schema: z.literal('loop-placement-live-v1'), evidence: z.literal('live'), resources: z.literal('simulated'), at: z.string().datetime(),
  status: z.enum(['passed', 'blocked', 'failed']), reason: z.string().optional(), source: z.enum(['jev', 'fixed', 'fallback']).optional(), effort: z.string().optional(), calls: z.number().int().nonnegative() });
const at = new Date().toISOString(); const key = process.env.JEVELLAN_TEST_JEV_KEY?.trim();
let receipt;
if (!key) receipt = Receipt.parse({ schema: 'loop-placement-live-v1', evidence: 'live', resources: 'simulated', at, status: 'blocked', reason: 'JEVELLAN_TEST_JEV_KEY is missing.', calls: 0 });
else {
  const settings = seedConfiguration()['x-jevellan']; const redactor = new SecretRedactor(); redactor.add(key);
  const model = { id: 'fixture_model', runtime: 'codex', model: 'fixture-native-model', label: 'Fixture model', description: 'A capable coding model offered by a simulated account.', efforts: ['medium', 'high', 'xhigh'], enabled: true };
  const account = AccountSchema.parse({ schema: 'account-v1', id: 'fixture_account', runtime: 'codex', label: 'Fixture account', kind: 'subscription', credential: 'per-device', enabled: true });
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'fixture_project', name: 'Live placement verification', paths: { fixture_device: '/fixture/project' }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  try {
    const result = await decidePlacement(new JevClient({ key: () => key, timeoutMs: 30_000 }), { settings: { ...settings, menu: [model] }, project, defaultIsolation: 'worktree',
      runtimes: new Map([['codex', { mcp: true, readOnlyEnforced: true, edit: true, shell: true, turns: true, displayName: 'Codex' }]]), accounts: [account],
      statuses: [AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: account.id, deviceId: 'fixture_device', auth: 'ready', observedAt: at })],
      devices: [{ id: 'fixture_device', name: 'Fixture Pro', status: 'online', revoked: false, hasPath: true, allowed: true, running: 0, isCoordinator: true }],
      maxRunningPerDevice: 6, ignoreRunningLimit: false, deviceId: 'fixture_device', coordinatorDeviceId: 'fixture_device', gates: { mainIsolation: false, remoteDevices: false }, fixed: {}, now: Date.now(),
      packet: { title: 'Repair a small edge case', task: 'Fix a missing empty-input check and add its focused regression test.', taskContext: { type: 'fix', needs: [], goal: null }, activeThreads: [],
        overrides: [1, 2].map(i => ({ title: `Earlier small fix ${i}`, mode: 'next-turn', taskType: 'fix', at, changes: [{ field: 'effort', from: 'high', to: 'medium' }] })) }, redactor, jevModel: settings.decisions.model }, new AbortController().signal);
    receipt = Receipt.parse({ schema: 'loop-placement-live-v1', evidence: 'live', resources: 'simulated', at, status: result.kind === 'placed' && result.record.source === 'jev' ? 'passed' : 'failed',
      ...(result.kind === 'placed' ? { source: result.record.source, effort: result.record.effortEffective, calls: result.record.jevCalls.length, ...(result.record.error ? { reason: result.record.error.message } : {}) } : { calls: 0, reason: result.message }) });
  } catch { receipt = Receipt.parse({ schema: 'loop-placement-live-v1', evidence: 'live', resources: 'simulated', at, status: 'failed', reason: 'The live placement did not complete.', calls: 0 }); }
}
writeFileSync('docs/acceptance/loop-placement-live.json', JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt));
if (receipt.status !== 'passed') process.exitCode = 2;
