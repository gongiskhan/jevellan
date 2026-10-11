import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { MergeRouteNameSchema, SecretRedactor, seedConfiguration } from '../../packages/core/dist/index.js';
import { decideMergeRoute, JevClient } from '../../packages/decisions/dist/index.js';
// Real Jev HTTP, synthetic task/PR inputs. This driver never starts a provider or touches GitHub.
const Receipt = z.strictObject({ schema: z.literal('loop-merge-route-live-v1'), evidence: z.literal('live'), resources: z.literal('simulated'), at: z.string().datetime(),
  status: z.enum(['passed', 'blocked', 'failed']), reason: z.string().optional(),
  cases: z.array(z.strictObject({ title: z.string(), route: MergeRouteNameSchema, source: z.enum(['jev', 'unavailable']), calls: z.number().int().nonnegative(), reason: z.string().optional() })) });
const key = process.env.JEVELLAN_TEST_JEV_KEY?.trim(), at = new Date().toISOString(), cases = [];
let status = 'blocked', reason = 'JEVELLAN_TEST_JEV_KEY is missing.';
if (key) {
  const redactor = new SecretRedactor(); redactor.add(key);
  const client = new JevClient({ key: () => key, timeoutMs: 30_000 }), model = seedConfiguration()['x-jevellan'].decisions.model;
  for (const sample of [
    { title: 'Add a tested greeting helper', summary: 'A small helper and its focused test passed; no production or stored-data behavior changes.', files: [{ path: 'helpers/greeting.ts', additions: 4, deletions: 0 }, { path: 'tests/greeting.test.ts', additions: 5, deletions: 0 }], totalSize: 9 },
    { title: 'Migrate stored account data', summary: 'Change a stored account data shape with a database migration.', files: [{ path: 'migrations/004_account_shape.sql', additions: 8, deletions: 0 }], totalSize: 8 },
  ]) {
    const result = await decideMergeRoute(client, { schema: 'merge-route-state-v1', ...sample, task: { type: 'fix', needs: [], goal: null },
      riskyAreas: 'Credentials; database migrations and stored data shapes; production deployment.',
      corrections: ['The owner marked an earlier stored-data change Should have asked me.'] }, model, redactor, new AbortController().signal);
    cases.push({ title: sample.title, route: result.route, source: result.source, calls: result.calls.length, ...(result.reason ? { reason: result.reason } : {}) });
  }
  status = cases.every(row => row.source === 'jev') && cases[1]?.route === 'ask-owner' ? 'passed' : 'failed';
  reason = undefined;
}
const receipt = Receipt.parse({ schema: 'loop-merge-route-live-v1', evidence: 'live', resources: 'simulated', at, status, ...(reason ? { reason } : {}), cases });
writeFileSync('docs/acceptance/loop-merge-route-live.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
if (status !== 'passed') process.exitCode = 2;
