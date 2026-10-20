import { afterEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { UiAuth } from '../packages/mesh/dist/index.js';
import { commitStep, projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
const call = (f: ProjectFixture, action: string, thread: string, args: Record<string, unknown> = {}) =>
  f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action, args: { project: 'project', thread, ...args } });
async function start(f: ProjectFixture, key: string, deviceId?: string) {
  return (await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: `request_${key}`, title: key, task: `Prepare ${key}.`, ...(deviceId ? { deviceId } : {}),
  })).threadId;
}

test('thread tools return the exact UI action model and resolve/reopen through canonical retry guards', async () => {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Fixture ready.' }), forThread());
  const id = await start(f, 'owner_actions'); await f.waitFor(() => f.thread(id), row => row.state === 'idle');
  await f.app.projectWork.pulse();
  const ui = await (await f.request(`/api/projects/project/threads/${id}/actions-view`)).json();
  expect(await call(f, 'actions', id)).toMatchObject({ ok: true, data: ui });
  const input = { operation: 'resolve', clientRequestId: 'owner_resolve' };
  expect(await call(f, 'act', id, input)).toMatchObject({ ok: true, data: { thread: { resolution: { by: 'owner' } } } });
  const resolved = f.thread(id).resolution;
  expect(await call(f, 'act', id, input)).toMatchObject({ ok: true });
  expect(f.thread(id).resolution).toEqual(resolved);
  expect(await call(f, 'act', id, { operation: 'reopen', clientRequestId: 'owner_resolve' })).toMatchObject({ ok: false });
  expect(await call(f, 'act', id, { operation: 'reopen', clientRequestId: 'owner_reopen' })).toMatchObject({ ok: true });
  expect(f.thread(id).resolution).toBeUndefined();
  const uiResolve = await f.request(`/api/projects/project/threads/${id}/actions`, 'POST', {
    schema: 'thread-action-request-v1', clientRequestId: 'ui_resolve', action: 'resolve',
  });
  expect(uiResolve.status).toBe(200);
  expect((await uiResolve.json()).thread.resolution.by).toBe(resolved!.by);
});

test('thread publish and merge tools retain confirmation, checks and resulting UI state', async () => {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(commitStep({ 'owner-action.txt': 'Fixture\n' }, { status: 'progress', summary: 'Saved fixture.' }), forThread());
  const id = await start(f, 'owner_publish'); await f.waitFor(() => f.thread(id), row => row.state === 'idle');
  await f.app.projectWork.pulse();
  expect(await call(f, 'act', id, { operation: 'resolve', clientRequestId: 'unconfirmed_resolve' })).toMatchObject({ ok: false, error: { code: 'confirmation_required' } });
  expect(f.thread(id).resolution).toBeUndefined();
  const input = { operation: 'publish', clientRequestId: 'owner_publish' };
  expect(await call(f, 'act', id, input)).toMatchObject({ ok: true });
  await f.waitFor(() => f.thread(id), row => row.state === 'in-review');
  expect(await call(f, 'act', id, input)).toMatchObject({ ok: true });
  expect(f.github.requests.filter(row => row.method === 'POST' && row.path.endsWith('/pulls'))).toHaveLength(1);
  expect(await call(f, 'merge', id)).toMatchObject({ ok: false, error: { code: 'confirmation_required' } });
  f.github.setChecks(1, 'failing'); await f.app.projectWork.pulse();
  expect(await call(f, 'merge', id, { confirm: true })).toMatchObject({ ok: false });
  expect(f.thread(id).pr?.state).toBe('open');
  f.github.setChecks(1, 'passing'); await f.app.projectWork.pulse();
  expect(await call(f, 'merge', id, { confirm: true })).toMatchObject({ ok: true, data: { merged: true } });
  const view = await (await f.request(`/api/projects/project/threads/${id}`)).json();
  expect(view.thread.pr.state).toBe('merged');
  expect(view.card.mergedOutcome).toBeTruthy();
});

test('thread tools use the existing authenticated owner route for member work without creating local work', async () => {
  const f = fixture = await projectFixture(); const member = await projectMember(f);
  const auth = f.app.auth; if (!(auth instanceof UiAuth)) throw new Error('Expected the fixture state point.');
  const issued: string[] = [], issue = auth.issue.bind(auth);
  vi.spyOn(auth, 'issue').mockImplementation(device => { const token = issue(device); issued.push(token); return token; });
  member.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Member fixture ready.' }), forThread());
  const id = await start(f, 'member_owner_action', member.deviceId);
  await f.waitFor(async () => {
    await member.app.projectWork.pulse();
    return existsSync(member.app.projectWork.paths.threadFile('project', id)) ? member.thread(id).state : 'not-arrived';
  }, state => state === 'idle');
  await member.app.projectWork.pulse(); await f.app.projectWork.pulse();
  const ui = await (await f.request(`/api/projects/project/threads/${id}/actions-view`)).json();
  expect(await call(f, 'actions', id)).toMatchObject({ ok: true, data: ui });
  expect(await call(f, 'act', id, { operation: 'resolve', clientRequestId: 'member_resolve' })).toMatchObject({ ok: true, data: { thread: { resolution: { by: 'owner' } } } });
  expect(member.thread(id).resolution?.by).toBe('owner');
  expect(f.app.projectWork.store.get(id)).toBeUndefined();
  expect(await call(f, 'act', id, { operation: 'reopen', clientRequestId: 'member_reopen' })).toMatchObject({ ok: true });
  expect(member.thread(id).resolution).toBeUndefined();
  expect(f.app.projectWork.store.get(id)).toBeUndefined();
  expect(issued.length).toBeGreaterThan(0);
  expect(issued.every(token => auth.verify(token) === null)).toBe(true);
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).startsWith(`${member.base}/api/mesh/projects/`)
    ? Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://example.invalid/' } })) : originalFetch(input, init));
  expect(await call(f, 'actions', id)).toMatchObject({ ok: false });
  expect(issued.every(token => auth.verify(token) === null)).toBe(true);
  expect(member.thread(id).resolution).toBeUndefined();
});
