import { afterEach, expect, test } from 'vitest';
import { ThreadCreateRequestSchema, ThreadSchema, projectToolNames, parseProjectLedgerData, CoordinatorEventSchema, ThreadOverrideRequestSchema } from '../packages/core/dist/index.js';
import { eventLine } from '../packages/projects/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const retired = ['jevellan_mail_send', 'jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_release'];
test('current scopes offer no mail or reservations, and start/restart requests reject Main', () => {
  for (const scope of [{ kind: 'coordinator' as const }, { kind: 'thread' as const, isolation: 'main' as const }, { kind: 'thread' as const, isolation: 'worktree' as const }]) for (const tool of retired) expect(projectToolNames(scope)).not.toContain(tool);
  expect(ThreadCreateRequestSchema.safeParse({ schema: 'thread-create-request-v1', clientRequestId: 'new', title: 'Main', task: 'Old request', isolation: 'main' }).success).toBe(false);
  expect(ThreadOverrideRequestSchema.safeParse({ schema: 'thread-override-request-v1', clientRequestId: 'new', mode: 'restart', isolation: 'main' }).success).toBe(false);
});
test('old mail and publication events still parse and render as history', () => {
  const event = CoordinatorEventSchema.parse({ schema: 'coordinator-event-v1', kind: 'mail', id: 'old', at: '2026-10-01T00:00:00Z', mailId: 'mail', fromThreadId: 'thread', fromTitle: 'Historical thread', subject: 'Old work', body: 'Historical mail.' });
  expect(eventLine(event, { title: id => id, base: 'main' })).toContain('Historical mail.');
  expect(parseProjectLedgerData('thread-publication', { schema: 'thread-publication-v1', result: 'main-published', commit: 'a'.repeat(40) })).toMatchObject({ result: 'main-published' });
  expect(parseProjectLedgerData('coordinator-tool', { schema: 'coordinator-tool-v1', tool: 'jevellan_mail_send', ok: true, summary: 'Historical mail' })).toMatchObject({ tool: 'jevellan_mail_send' });
  expect(ThreadSchema.shape.isolation.parse('main')).toBe('main');
});
test('retired owner and mesh requests mutate no registered checkout or thread state', async () => {
  f = await projectFixture(); const head = f.git(f.checkout, 'rev-parse', 'HEAD'), status = f.git(f.checkout, 'status', '--porcelain=v1');
  const response = await f.request('/api/projects/project/threads', 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'old_main', title: 'Old main request', task: 'Do not run.', isolation: 'main' }); expect(response.status).toBe(400);
  for (const request of [{ operation: 'mail-inbox', projectId: 'project', threadId: 'historical' }, { operation: 'reservations-list', projectId: 'project' }, { operation: 'checkouts-held', projectId: 'project' }]) {
    const { HubProjectStore } = await import('../packages/mesh/dist/index.js');
    expect(() => new HubProjectStore(f!.app.hub, f!.app.device.deviceId).request({ schema: 'project-hub-request-v1', ...request })).toThrow('retired');
  }
  expect(f.app.projectWork.store.all()).toHaveLength(0); expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe(status);
});
