import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountSchema, Homes, ImproverRunSchema, ImproverStateSchema, MemoryCareReportRowSchema, ProjectSchema } from '../packages/core/dist/index.js';
import type { JevQuestions } from '../packages/decisions/dist/index.js';
import { FakeRuntime, type StretchInput } from '../packages/runtime-contract/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

// The normal application wiring: HTTP, the hub's device protocol, the private draft runner and its bridge.
// Jev answers and the provider's patch are simulated; Git, ownership and publication to a bare origin are real.
let root: string; let app: Application; let runtime: FakeRuntime; let server: Server; let base: string; let cookie: string; let checkout: string; let origin: string;
const memory = '.jevellan/memory';
function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } }).trim();
}
function write(path: string, content: string) { mkdirSync(join(checkout, path, '..'), { recursive: true }); writeFileSync(join(checkout, path), content); }
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-care-app-'))); mkdirSync(join(root, 'user')); runtime = new FakeRuntime(); runtime.capabilities.readOnlyEnforced = true;
  origin = join(root, 'origin.git'); git(root, ['init', '--bare', '-b', 'main', origin]); checkout = join(root, 'sandbox'); git(root, ['clone', origin, checkout]);
  git(checkout, ['config', 'user.name', 'Fixture']); git(checkout, ['config', 'user.email', 'fixture@example.invalid']);
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();
  write(`${memory}/old.md`, '---\ntitle: Old caching idea\n---\nCache builds in S3.\n'); git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Seed'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
  write(`${memory}/vitest.md`, '---\ntitle: Vitest setup\n---\nGlobals are enabled.\n'); write(`${memory}/vitest-2.md`, '---\ntitle: Vitest Setup\n---\nVitest runs with globals.\n');
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Notes']); git(checkout, ['push', '-u', 'origin', 'main']);
  app = new Application({ homes: new Homes(join(root, 'home'), join(root, 'user')), timers: false, runtimes: () => new Map([['fake', runtime]]), projectMemory: () => ({ sync: async () => undefined, search: async () => [] }),
    decisionFetch: async (_url, init) => {
      const input = JSON.parse(String(init!.body)) as { questions: JevQuestions };
      return Response.json({ model: 'simulated-jev', usage: { input_tokens: 10, output_tokens: 2 }, answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: 'noul', noul: id.startsWith('pair_') ? 0.95 : 0.05 }])) });
    } });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const configuration = app.hub.configuration.current()!; const settings = configuration.configuration['x-jevellan'];
  settings.runtimes.fake = { enabled: true }; settings.menu.push({ id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated provider.', efforts: ['high'], enabled: true });
  settings.improver.schedule.enabled = false; settings.improver.routing.enabled = false; settings.improver.context.enabled = false;
  app.hub.configuration.put(configuration.configuration, configuration.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.vault.put('jev', `fixture-${randomUUID()}`);
  app.hub.put('accounts', 'fixture_account', AccountSchema, AccountSchema.parse({ schema: 'account-v1', id: 'fixture_account', runtime: 'fake', label: 'Fixture', kind: 'subscription', credential: 'per-device', enabled: true }), 0);
  await app.accounts.check('fixture_account');
  app.hub.put('projects', 'sandbox', ProjectSchema, { schema: 'project-v1', id: 'sandbox', name: 'Sandbox', paths: { [app.device.deviceId]: checkout }, branchPolicy: 'main', testCommand: 'false', memory: { mode: 'repo', dir: memory }, context: { state: 'none' } }, 0);
});
afterEach(async () => { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); rmSync(root, { recursive: true, force: true }); });
async function request(input?: unknown) {
  const response = await fetch(`${base}/api/improver`, { method: input ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: base, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value;
}
async function handoff(input: StretchInput) {
  expect(input.permissions).toBe('read-only'); expect(input.inputCopy).toBe(true); expect(input.cwd.startsWith(join(root, 'home', 'tmp'))).toBe(true);
  const tasks = JSON.parse(readFileSync(join(input.cwd, 'tasks.json'), 'utf8')) as { merge: string[][] };
  const [keep, remove] = tasks.merge[0]!;
  const content = { schema: 'memory-patch-draft-v1', summary: 'Merged the Vitest notes.', files: [{ path: keep, content: '---\ntitle: Vitest setup\n---\nVitest runs with globals enabled.\n' }, { path: remove, content: null }] };
  const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` },
    body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: { schema: 'handoff-v2', stretch: 1, action: 'reply', status: 'done', summary: 'A simulated memory patch.',
      evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [], result: { type: 'memory-patch', content } } }) });
  expect(response.status).toBe(200); return { status: 'completed' as const };
}

test('Run now over HTTP runs memory care through the private draft runner, publishes one commit and Undo reverts it', async () => {
  runtime.enqueue(({ input }) => handoff(input));
  const upstream = git(origin, ['rev-parse', 'main']);
  const run = ImproverRunSchema.parse(await request({ schema: 'improver-request-v1', operation: 'run-now', clientRequestId: 'care' }));
  expect(run).toMatchObject({ routing: null, projects: [{ kind: 'memory', projectId: 'sandbox' }] });
  await app.projectImprover.idle();
  expect(runtime.starts).toHaveLength(1);
  expect(git(origin, ['log', '--format=%s', `${upstream}..main`])).toBe('memory: nightly care (1 merged, 1 archived, 0 links)');
  expect(existsSync(join(checkout, memory, 'archive', 'old.md'))).toBe(true); expect(git(checkout, ['status', '--porcelain'])).toBe('');
  const state = ImproverStateSchema.parse(await request());
  expect(state.reports[0]!.report).toMatchObject({ projectName: 'Sandbox', counts: { merged: 1, archived: 1, fixedLinks: 0, reconciled: 0 }, published: true, status: 'applied' });
  expect(state.notice?.lines).toEqual(['Memory care for Sandbox: merged 1 note, archived 1, fixed 0 links.']);
  expect(state.lastRuns).toEqual([expect.objectContaining({ kind: 'memory', status: 'complete', result: 'Merged 1 note, archived 1, fixed 0 links', commit: git(origin, ['rev-parse', 'main']) })]);
  const log = await request({ schema: 'improver-request-v1', operation: 'log', jobId: state.lastRuns[0]!.jobId });
  expect(log).toMatchObject({ schema: 'project-improver-log-v1', entries: expect.arrayContaining([expect.objectContaining({ stage: 'published' })]) });
  const undo = MemoryCareReportRowSchema.parse(await request({ schema: 'improver-request-v1', operation: 'report', reportId: state.reports[0]!.report.id,
    input: { schema: 'memory-care-report-action-v1', kind: 'undo', clientRequestId: 'undo', revision: state.reports[0]!.revision } }));
  expect(undo.report.status).toBe('undoing'); await app.projectImprover.idle();
  expect(ImproverStateSchema.parse(await request()).reports[0]!.report.status).toBe('undone');
  expect(git(origin, ['log', '-1', '--format=%s', 'main'])).toBe('Revert "memory: nightly care (1 merged, 1 archived, 0 links)"');
  expect(existsSync(join(checkout, memory, 'old.md'))).toBe(true);
  const maintenance = app.lifecycle.tryMaintenance(); expect(maintenance).not.toBeNull(); maintenance!();
}, 60_000);
