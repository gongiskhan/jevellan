// Restart removes the worktree and local branch of the thread it replaces (D252), also when that thread was stopped while its setup
// command ran, before its worktree fields were stored (P8 review TH-4). Simulated: the runtime turn of the new thread (FakeRuntime).
// Live: git on a bare origin, the setup command, HTTP, the hub and the ledgers.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectWorkSettingsSchema, ThreadCreatedViewSchema, ThreadOverrideViewSchema, defaultProjectWorkSettings } from '../packages/core/dist/index.js';
import { HubProjectAccess } from '../packages/mesh/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { expectNoLeaks, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});

test('Restart after a Stop during the setup command removes the worktree and the local branch the stopped thread left', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  const settings = new HubProjectAccess(f.app.hub, f.app.device.deviceId);
  await settings.putSettings(ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('project'), setupCommand: 'touch setup-started && sleep 60' }), 0);
  const { threadId } = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title: 'Setup', task: 'Set it up.', isolation: 'worktree' });
  const path = f.homes.at('worktrees', 'project', threadId);
  await f.waitFor(() => existsSync(join(path, 'setup-started')), Boolean);
  expect((await f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' })).status).toBe(202);
  expect(await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped')).toMatchObject({ cwd: '' });
  const branch = f.git(f.checkout, 'for-each-ref', '--format=%(refname)', 'refs/heads/jv');
  expect(branch).toMatch(/^refs\/heads\/jv\/setup-/); expect(existsSync(path)).toBe(true);

  await settings.putSettings(ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('project'), setupCommand: null }), 1);
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Set up.' }), forThread());
  const restarted = await f.json(`/api/projects/project/threads/${threadId}/override`, ThreadOverrideViewSchema, 'POST', { schema: 'thread-override-request-v1',
    clientRequestId: `ovr_${randomUUID()}`, mode: 'restart', isolation: 'worktree', modelId: 'fixture', effort: 'high', deviceId: f.app.device.deviceId });
  const newId = restarted.newThreadId!;
  await f.waitFor(() => f.thread(threadId), (thread) => thread.stateReason === `Restarted as ${newId}.`);
  await f.waitFor(() => existsSync(path), (present) => !present);
  expect(f.git(f.checkout, 'for-each-ref', '--format=%(refname)', branch)).toBe('');
  expect(f.git(f.checkout, 'worktree', 'list', '--porcelain')).not.toContain(threadId);
  await f.waitFor(() => f.thread(newId), (thread) => thread.state === 'idle' && thread.turns === 1);
});
