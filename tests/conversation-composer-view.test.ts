import { UiAuth } from '../packages/mesh/dist/index.js';
import { ownerConversationComposer } from '../apps/daemon/dist/owner-proxy.js';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationComposerViewSchema, ComposerInitialSchema, type ComposerChoice, type ConversationComposerView } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
const empty = () => ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: {}, pins: {} });
type Editor = ConversationComposerView;
async function draft(initial = empty(), choice?: ComposerChoice): Promise<Editor> {
  const response = await f!.request('/api/conversation-composer', 'POST', { schema: 'conversation-composer-request-v1', projectId: 'project', initial, ...(choice ? { choice } : {}) });
  expect(response.status).toBe(200); return ConversationComposerViewSchema.parse(await response.json());
}

test('composer draft projection preserves unavailable selections, resource pins and canonical initial action guards', async () => {
  f = await projectFixture();
  const revision = f.app.hub.configuration.current()!; revision.configuration['x-jevellan'].guards.reviewCap = 0;
  revision.configuration['x-jevellan'].menu.push({ ...revision.configuration['x-jevellan'].menu[0]!, id: 'disabled_model', label: 'Disabled fixture', enabled: false });
  f.app.hub.configuration.put(revision.configuration, revision.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  const initial = ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: { action: 'plan', effort: 'high' }, pins: { modelId: 'removed_model', effort: 'low', runtimeId: 'fake', accountId: 'acc_fixture' } });
  const view = await draft(initial);
  expect(view).toMatchObject({ schema: 'conversation-composer-view-v1', projectId: 'project', conversationId: null, initial, summary: 'Plan · removed_model · high' });
  const model = view.fields.find(field => field.id === 'model')!, effort = view.fields.find(field => field.id === 'effort')!, action = view.fields.find(field => field.id === 'action')!;
  expect(model.options).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'removed_model', disabled: true, label: 'removed_model · unavailable' }), expect.objectContaining({ value: 'disabled_model', disabled: true, label: 'Disabled fixture · unavailable' })]));
  expect(effort).toMatchObject({ selected: 'high', scope: 'once-then-pin', scopeLabel: 'Once, then low', keep: { field: 'effort', mode: 'pin', value: 'high' } });
  for (const unavailable of ['integrate', 'done', 'test', 'review', 'adversarial-review']) expect(action.options.some(option => option.value === unavailable)).toBe(false);
  expect(f.fake.starts).toHaveLength(0); expect((await f.app.conversations.list()).conversations).toHaveLength(0);
});

test('composer draft preview applies canonical once, pin and Auto transitions without creating work', async () => {
  f = await projectFixture();
  const initial = ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: { effort: 'high' }, pins: { effort: 'low', runtimeId: 'fake', accountId: 'acc_fixture' } });
  const first = await draft(initial), field = first.fields.find(row => row.id === 'effort')!;
  const pinned = await draft(first.initial, field.keep!);
  expect(pinned.initial).toMatchObject({ once: {}, pins: { effort: 'high', runtimeId: 'fake', accountId: 'acc_fixture' } });
  expect(pinned.fields.find(row => row.id === 'effort')).toMatchObject({ selected: 'high', scope: 'kept', scopeLabel: 'Kept for this conversation', keep: null });
  const cleared = await draft(pinned.initial, pinned.fields.find(row => row.id === 'effort')!.clear!);
  expect(cleared.initial).toEqual({ schema: 'composer-initial-v1', once: {}, pins: { runtimeId: 'fake', accountId: 'acc_fixture' } });
  expect(initial.once.effort).toBe('high'); expect(initial.pins.effort).toBe('low');
  expect(f.fake.starts).toHaveLength(0); expect((await f.app.conversations.list()).conversations).toHaveLength(0);
});

test('conversation composer UI and tool saves retain one canonical choice receipt across retries', async () => {
  f = await projectFixture();
  await f.app.conversations.create({ schema: 'start-conversation-v1', id: 'composer_fixture', projectId: 'project', title: 'Composer fixture', message: 'Explain the fixture.', clientMessageId: 'composer_first', choices: { schema: 'composer-initial-v1', once: {}, pins: { modelId: 'fixture', effort: 'low' } } });
  await f.app.conversations.wait('composer_fixture');
  const response = await f.request('/api/conversations/composer_fixture/choices-view'); expect(response.status).toBe(200); const view = ConversationComposerViewSchema.parse(await response.json());
  expect(view.fields.find(field => field.id === 'effort')).toMatchObject({ selected: 'low', scope: 'kept', scopeLabel: 'Kept for this conversation' });
  const choice = view.fields.find(field => field.id === 'effort')!.options.find(option => option.value === 'high')!.choice;
  const saved = await f.request('/api/conversations/composer_fixture/choices-editor', 'POST', choice); expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ initial: { once: { effort: 'high' }, pins: { effort: 'low' } } });
  const repeated = await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'composer_save', args: { project: 'project', conversation: 'composer_fixture', request: choice } });
  expect(repeated).toMatchObject({ ok: true, data: { schema: 'conversation-composer-view-v1', initial: { once: { effort: 'high' }, pins: { effort: 'low' } } } });
  expect((await f.app.conversations.view('composer_fixture')).composerOverrides.filter(row => row.request.clientRequestId === choice.clientRequestId)).toHaveLength(1);
  const stale = view.fields.find(field => field.id === 'effort')!.clear!;
  expect((await f.request('/api/conversations/composer_fixture/choices-editor', 'POST', stale)).status).toBe(409);
  expect((await f.request('/api/conversations/composer_fixture/choices-editor', 'POST', { ...choice, value: 'medium' })).status).toBe(409);
  expect(f.fake.starts).toHaveLength(0);
});

test('the owner composer tool exposes the same side-effect-free initial projection as the UI', async () => {
  f = await projectFixture(); const initial = ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: { effort: 'high' }, pins: { effort: 'low' } });
  const answer = await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'composer_editor', args: { project: 'project', initial } });
  expect(answer).toMatchObject({ ok: true, data: { schema: 'conversation-composer-view-v1', projectId: 'project', conversationId: null, initial, fields: expect.arrayContaining([expect.objectContaining({ id: 'effort', selected: 'high', scope: 'once-then-pin', scopeLabel: 'Once, then low' })]) } });
  expect(f.fake.starts).toHaveLength(0); expect((await f.app.conversations.list()).conversations).toHaveLength(0);
});


test('composer editor retries recover after the canonical save succeeds but its projection is lost', async () => {
  f = await projectFixture();
  await f.app.conversations.create({ schema: 'start-conversation-v1', id: 'composer_partial', projectId: 'project', title: 'Partial response', message: 'Explain the fixture.', clientMessageId: 'partial_first' });
  await f.app.conversations.wait('composer_partial');
  const view = ConversationComposerViewSchema.parse(await (await f.request('/api/conversations/composer_partial/choices-view')).json());
  const choice = view.fields.find(field => field.id === 'effort')!.options.find(option => option.value === 'high')!.choice;
  vi.spyOn(f.app.conversations, 'composerEditor').mockRejectedValueOnce(Object.assign(new Error('Fixture projection unavailable after save.'), { status: 503 }));
  expect((await f.request('/api/conversations/composer_partial/choices-editor', 'POST', choice)).status).toBe(503);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'composer_save', args: { project: 'project', conversation: 'composer_partial', request: choice } })).toMatchObject({ ok: true, data: { initial: { once: { effort: 'high' } } } });
  expect((await f.app.conversations.view('composer_partial')).composerOverrides.filter(row => row.request.clientRequestId === choice.clientRequestId)).toHaveLength(1);
  expect(f.fake.starts).toHaveLength(0);
});

test('member conversation composer reads and UI/tool writes stay on their indexed owner', async () => {
  f = await projectFixture(); const member = await projectMember(f);
  await member.app.conversations.create({ schema: 'start-conversation-v1', id: 'composer_member', projectId: 'project', title: 'Member composer', message: 'Explain the fixture.', clientMessageId: 'member_first' });
  await member.app.conversations.wait('composer_member'); await member.app.conversations.list();
  const response = await f.request('/api/conversations/composer_member/choices-view'); expect(response.status).toBe(200); const view = ConversationComposerViewSchema.parse(await response.json());
  const choice = view.fields.find(field => field.id === 'effort')!.options.find(option => option.value === 'high')!.choice;
  const auth = f.app.auth; if (!(auth instanceof UiAuth)) throw new Error('Expected the fixture state-point authority.');
  const hubWrite = vi.spyOn(f.app.conversations, 'composerChoice'), memberWrite = vi.spyOn(member.app.conversations, 'composerChoice'), revoke = vi.spyOn(auth, 'logout'), issue = vi.spyOn(auth, 'issue');
  expect((await f.request('/api/conversations/composer_member/choices-editor', 'POST', choice)).status).toBe(200);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'composer_save', args: { project: 'project', conversation: 'composer_member', request: choice } })).toMatchObject({ ok: true, data: { conversationId: 'composer_member', initial: { once: { effort: 'high' } } } });
  expect(hubWrite).not.toHaveBeenCalled(); expect(memberWrite).toHaveBeenCalledTimes(2); expect(issue).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledTimes(1);
  await expect(ownerConversationComposer(f.app, 'another_project', 'composer_member', choice)).rejects.toThrow('another conversation or project');
  expect(memberWrite).toHaveBeenCalledTimes(2); expect(revoke.mock.calls.length).toBe(issue.mock.calls.length);
  expect(f.app.conversations.hasLocalConversation('composer_member')).toBe(false);
  expect((await member.app.conversations.view('composer_member')).composerOverrides.filter(row => row.request.clientRequestId === choice.clientRequestId)).toHaveLength(1);
  expect(member.fake.starts).toHaveLength(0);
});
