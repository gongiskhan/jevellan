import { UiAuth } from '../packages/mesh/dist/index.js';
import { ownerConversationOperation } from '../apps/daemon/dist/owner-proxy.js';
import { projectFixture, projectMember } from './helpers/project-fixture.js';
import { afterEach, expect, test, vi } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { conversationPlanFixture } from './helpers/conversation-plan-fixture.js';
import type { ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

test('plan reader shares ordered typed content through HTTP and owner tools without starting more work', async () => {
  const made = await conversationPlanFixture(); f = made.f; const { id, pointer, content } = made;
  const raw = await f.request(`/api/conversations/${id}/read?pointer=${encodeURIComponent(pointer)}`); expect(raw.status).toBe(200); expect((await raw.json()).content).toEqual(content);
  const before = await f.app.conversations.view(id), count = f.app.conversations.ledger(id).events().length, starts = f.fake.starts.length;
  const response = await f.request(`/api/conversations/${id}/plan-read`, 'POST', { schema: 'conversation-plan-read-request-v1', pointer }); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'conversation-plan-read-v1', projectId: 'project', conversationId: id, pointer, view: { schema: 'plan-content-view-v1', root: { kind: 'fields', topLevel: true, title: null } } });
  expect(view.view.root.sections.map((row: { key: string }) => row.key)).toEqual(['title', 'steps', 'risks', 'unknownExtra']);
  expect(view.view.root.sections[1]).toMatchObject({ heading: 'Steps', headingLevel: 3, value: { kind: 'list', ordered: true, items: [{ kind: 'fields', topLevel: false, title: { kind: 'markdown', text: 'Inspect' }, sections: [{ key: 'description', heading: null, headingLevel: null, value: { kind: 'markdown', text: 'Preserve data.' } }, { key: 'optional', heading: 'Optional', value: { kind: 'muted', text: 'Not specified' } }] }] } });
  expect(view.view.root.sections[2].value).toEqual({ kind: 'muted', text: 'None' }); expect(view.view.root.sections[3].value).toEqual({ kind: 'value', text: 'No' });
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'plan_read', args: { project: 'project', conversation: id, request: { schema: 'conversation-plan-read-request-v1', pointer } } })).toMatchObject({ ok: true, data: view });
  expect(await f.app.conversations.view(id)).toEqual(before); expect(f.app.conversations.ledger(id).events()).toHaveLength(count); expect(f.fake.starts).toHaveLength(starts);
});

test('plan reading keeps the existing public process-data boundary before content formatting', async () => {
  const made = await conversationPlanFixture(); f = made.f; const marker = 'synthetic-private-process';
  const pointer = f.app.conversations.ledger(made.id).putBlob({ schema: 'stretch-v2', native: { sessionId: marker }, n: 1 }).ref;
  const raw = await f.request(`/api/conversations/${made.id}/read?pointer=${encodeURIComponent(pointer)}`); expect(raw.status).toBe(200); const publicContent = (await raw.json()).content; expect(publicContent).toEqual({ schema: 'stretch-v2', n: 1 });
  const response = await f.request(`/api/conversations/${made.id}/plan-read`, 'POST', { schema: 'conversation-plan-read-request-v1', pointer }); expect(response.status).toBe(200); const view = await response.json(); expect(JSON.stringify(view)).not.toContain(marker); expect(view.view.root.sections.map((row: { key: string }) => row.key)).toEqual(Object.keys(publicContent));
});

test('shared plan display decodes fenced JSON and preserves primitive, nested-heading and list policy', () => {
  expect(core.planContentView).toBeTypeOf('function'); expect(core.decodePlan).toBeTypeOf('function');
  const fence = String.fromCharCode(96).repeat(3);
  expect(core.decodePlan(`${fence}json\n{"goal":"Keep it"}\n${fence}`)).toEqual({ goal: 'Keep it' });
  expect(core.decodePlan('{broken')).toBe('{broken'); expect(core.decodePlan('## Existing Markdown')).toBe('## Existing Markdown');
  expect(core.planContentView(null).root).toEqual({ kind: 'muted', text: 'Not specified' }); expect(core.planContentView(undefined).root).toEqual({ kind: 'muted', text: 'Not specified' });
  expect(core.planContentView(true).root).toEqual({ kind: 'value', text: 'Yes' }); expect(core.planContentView(42).root).toEqual({ kind: 'value', text: '42' });
  expect(core.planContentView('## Existing Markdown').root).toEqual({ kind: 'markdown', text: '## Existing Markdown' });
  const ordered = core.planContentView({ affectedFiles: ['a.ts'], phases: ['One'], steps: ['Two'], tasks: ['Three'], details: 'Keep top heading.' }).root;
  expect(ordered.kind).toBe('fields'); if (ordered.kind !== 'fields') throw Error('Expected ordered plan fields');
  expect(ordered.sections.map(row => row.key)).toEqual(['steps', 'phases', 'affectedFiles', 'tasks', 'details']);
  for (const key of ['steps', 'phases', 'tasks']) expect(ordered.sections.find(row => row.key === key)?.value).toMatchObject({ kind: 'list', ordered: true });
  expect(ordered.sections.find(row => row.key === 'affectedFiles')).toMatchObject({ heading: 'Affected files', value: { kind: 'list', ordered: false } });
  expect(ordered.sections.find(row => row.key === 'details')).toMatchObject({ heading: 'Details', headingLevel: 3 });
});


test('member plan reads keep owner scope and revoke temporary authority after reply mismatch', async () => {
  f = await projectFixture(); const member = await projectMember(f), id = 'member_plan_read';
  await member.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Member plan reader', message: 'Explain the fixture.', clientMessageId: 'member_plan_first' });
  await member.app.conversations.wait(id); await member.app.conversations.list();
  const pointer = member.app.conversations.ledger(id).putBlob({ goal: 'Keep the owner boundary.' }).ref, request = { schema: 'conversation-plan-read-request-v1', pointer };
  const auth = f.app.auth; if (!(auth instanceof UiAuth)) throw Error('Expected fixture state-point authority.');
  const hubRead = vi.spyOn(f.app.conversations, 'planRead'), memberRead = vi.spyOn(member.app.conversations, 'planRead'), issue = vi.spyOn(auth, 'issue'), revoke = vi.spyOn(auth, 'logout');
  const response = await f.request(`/api/conversations/${id}/plan-read`, 'POST', request); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'conversation-plan-read-v1', projectId: 'project', conversationId: id, pointer });
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'plan_read', args: { project: 'project', conversation: id, request } })).toMatchObject({ ok: true, data: view });
  expect(hubRead).not.toHaveBeenCalled(); expect(memberRead).toHaveBeenCalledTimes(2); expect(issue).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledTimes(1);
  await expect(ownerConversationOperation(f.app, 'another_project', id, 'plan-read', request)).rejects.toMatchObject({ status: 409 });
  memberRead.mockResolvedValueOnce({ ...view, pointer: 'blobs/wrong-plan' });
  await expect(ownerConversationOperation(f.app, 'project', id, 'plan-read', request)).rejects.toMatchObject({ status: 502, message: 'The returned plan does not match the request.' });
  expect(revoke.mock.calls.length).toBe(issue.mock.calls.length); expect(f.app.conversations.hasLocalConversation(id)).toBe(false); expect(member.fake.starts).toHaveLength(0);
});
