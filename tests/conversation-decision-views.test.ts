import { afterEach, expect, test, vi } from 'vitest';
import { UiAuth } from '../packages/mesh/dist/index.js';
import { seedConversationDecision } from './helpers/conversation-decision-fixture.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

async function setup(external = false) {
  f = await projectFixture({ branchPolicy: external ? 'external' : 'main', testCommand: 'true' });
  return { fixture: f, ...await seedConversationDecision(f) };
}

test('conversation step presentation owns status, correction badges, recorded login actions and timing state', async () => {
  const { fixture, id } = await setup(); const view = await fixture.app.conversations.view(id);
  expect(view.stretches[0]).toMatchObject({ presentation: { schema: 'conversation-step-presentation-v1', statusBadge: null,
    corrections: [{ text: 'corrected: effort → low' }], notices: [{ text: 'Simulated account notice.', action: { label: 'Log in', href: '/settings/runtimes?account=acc_fixture&login=1' } }],
    timing: { ticking: false, endLabel: 'Ended', durationLabel: 'Duration' } } });
  expect(fixture.fake.starts.length).toBe(1);
});

test('recorded conversation Why orders known probabilities and projects memory, corrections, account and Jev facts', async () => {
  const { fixture, path, decision } = await setup();
  const response = await fixture.request(`${path}/decision-why`, 'POST', { schema: 'conversation-decision-why-request-v1', decisionId: decision.id }); expect(response.status).toBe(200); const why = await response.json();
  expect(why).toMatchObject({ schema: 'conversation-decision-why-view-v1', conversationId: decision.conversationId, projectId: 'project', decisionId: decision.id,
    effort: { mapping: { requested: 'medium', effective: 'high' } }, memory: { sourceLabel: 'Selected by search rank.', chosen: ['notes/one'] } });
  expect(why.action.options.map((row: { id: string }) => row.id)).toEqual(['implement', 'plan', 'reply']);
  expect(why.model.options.map((row: { id: string }) => row.id)).toEqual(['other_model', 'fixture']);
  expect(why.model.options.find((row: { id: string }) => row.id === 'fixture').selected).toBe(true);
  expect(why.corrections).toEqual(expect.arrayContaining([expect.objectContaining({ heading: 'Back to Auto' }), expect.objectContaining({ heading: 'Just override' }), expect.objectContaining({ unavailable: true })]));
  expect(why.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'acc_fixture', selected: true }), expect.objectContaining({ id: 'acc_other', excluded: true })]));
  expect(why.jev.calls.map((row: { label: string }) => row.label)).toEqual(['Next step', 'Model and effort', 'Memory']);
  expect(fixture.fake.starts.length).toBe(1);
});

test('conversation Why UI and explicit owner tool share the same recorded model without launching work', async () => {
  const { fixture, id, path, decision } = await setup();
  const response = await fixture.request(`${path}/decision-why`, 'POST', { schema: 'conversation-decision-why-request-v1', decisionId: decision.id }); expect(response.status).toBe(200); const why = await response.json();
  const result = await fixture.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'conversation_why', args: { project: 'project', conversation: id, decision: decision.id } });
  expect(result).toMatchObject({ ok: true, data: why }); expect(fixture.fake.starts.length).toBe(1);
});

test('step editor preview prepares changed fields and UI/tool saves reuse the canonical correction receipt', async () => {
  const { fixture, id, path } = await setup();
  const read = await fixture.request(`${path}/step-editor/1`); expect(read.status).toBe(200); const editor = await read.json();
  expect(editor).toMatchObject({ schema: 'step-correction-editor-v1', fields: { action: 'reply', modelId: 'fixture', effort: 'medium' }, canNoted: false, canRedo: false });
  const response = await fixture.request(`${path}/step-preview`, 'POST', { ...editor.preview.request, fields: { ...editor.fields, effort: 'low' } }); expect(response.status).toBe(200); const preview = await response.json();
  expect(preview).toMatchObject({ canNoted: true, canRedo: true, requests: { noted: { schema: 'correct-step-v1', choices: { effort: 'low' }, mode: 'noted' }, redo: { mode: 'redo', choices: { effort: 'low' } } } });
  expect((await fixture.request(`${path}/correct`, 'POST', preview.requests.noted)).status).toBe(202);
  expect(await fixture.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'correction_save', args: { project: 'project', conversation: id, request: preview.requests.noted } })).toMatchObject({ ok: true });
  expect((await fixture.app.conversations.view(id)).overrides.filter(row => row.request.clientRequestId === preview.requests.noted.clientRequestId)).toHaveLength(1);
  expect(fixture.fake.starts.length).toBe(1);
});

test('step correction consequences preserve external repository files and the actual selected choice', async () => {
  const { fixture, path } = await setup(true);
  const read = await fixture.request(`${path}/step-editor/1`); expect(read.status).toBe(200); const editor = await read.json();
  const response = await fixture.request(`${path}/step-preview`, 'POST', { ...editor.preview.request, fields: { ...editor.fields, effort: 'low' } }); expect(response.status).toBe(200); const preview = await response.json();
  expect(preview.consequences.externalNotice).toBe('This project follows its own git rules. Undo changes the conversation history; repository files are kept.');
  expect(preview.consequences.redoText).toContain('Repository files are kept.'); expect(preview.consequences.redoText).toContain('Reply, Fixture, low');
  expect(fixture.fake.starts.length).toBe(1);
});


test('settled step presentation is stable and closed history needs no shared configuration read', async () => {
  const { fixture, id, path } = await setup();
  let view = await fixture.app.conversations.view(id); expect(view.allowed.includes('done')).toBe(true);
  await fixture.app.conversations.manual(id, { schema: 'manual-step-v1', generation: view.conversation.generation, action: 'done', modelId: 'fixture', effort: 'high' }); await fixture.app.conversations.wait(id);
  view = await fixture.app.conversations.view(id); expect(view.conversation.work).toBeNull();
  const settings = vi.spyOn(fixture.app.conversations.options, 'settings').mockRejectedValue(new Error('Fixture shared configuration unavailable.'));
  expect(await fixture.app.conversations.view(id)).toEqual(view); expect(settings.mock.calls.length).toBe(0); settings.mockRestore();
  await fixture.app.conversations.message(id, { schema: 'conversation-message-v1', clientMessageId: 'newer_work_fixture', text: 'Explain another fixture.', kind: 'message' }); await fixture.app.conversations.wait(id);
  const response = await fixture.request(`${path}/step-editor/1`); expect(response.status).toBe(200);
  expect((await response.json()).consequences.newerWorkText).toBe('This also undoes the newer open work. Its request and notes stay with the reopened work.');
  expect(fixture.fake.starts.length).toBe(1);
});

test('step previews reject integration intents and extra fields without writing a correction', async () => {
  const { fixture, id, path } = await setup(); const editor = await (await fixture.request(`${path}/step-editor/1`)).json();
  const before = (await fixture.app.conversations.view(id)).overrides.length;
  expect((await fixture.request(`${path}/step-preview`, 'POST', { ...editor.preview.request, fields: { ...editor.fields, action: 'integrate' } })).status).toBe(400);
  expect((await fixture.request(`${path}/step-preview`, 'POST', { ...editor.preview.request, bypass: true })).status).toBe(400);
  expect((await fixture.app.conversations.view(id)).overrides.length).toBe(before); expect(fixture.fake.starts.length).toBe(1);
});

test('a correction lost-response retry returns its canonical receipt without a second correction or launch', async () => {
  const { fixture, id, path } = await setup(); const editor = await (await fixture.request(`${path}/step-editor/1`)).json();
  const preview = await (await fixture.request(`${path}/step-preview`, 'POST', { ...editor.preview.request, fields: { ...editor.fields, effort: 'low' } })).json();
  vi.spyOn(fixture.app.conversations, 'view').mockRejectedValueOnce(Object.assign(new Error('Fixture reply unavailable after the canonical write.'), { status: 503 }));
  expect((await fixture.request(`${path}/correct`, 'POST', preview.requests.noted)).status).toBe(503);
  expect(await fixture.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'correction_save', args: { project: 'project', conversation: id, request: preview.requests.noted } })).toMatchObject({ ok: true });
  expect((await fixture.app.conversations.view(id)).overrides.filter(row => row.request.clientRequestId === preview.requests.noted.clientRequestId)).toHaveLength(1); expect(fixture.fake.starts.length).toBe(1);
});

test('member decision models and UI/tool corrections retain ownership and revoke their issued authority', async () => {
  f = await projectFixture({ testCommand: 'true' }); const member = await projectMember(f), { id, path, decision } = await seedConversationDecision(member, 'member_decision_fixture');
  await member.app.conversations.list();
  const why = await f.request(`${path}/decision-why`, 'POST', { schema: 'conversation-decision-why-request-v1', decisionId: decision.id }); expect(why.status).toBe(200);
  const read = await f.request(`${path}/step-editor/1`); expect(read.status).toBe(200); const editor = await read.json();
  const previewResponse = await f.request(`${path}/step-preview`, 'POST', { ...editor.preview.request, fields: { ...editor.fields, effort: 'low' } }); expect(previewResponse.status).toBe(200); const preview = await previewResponse.json();
  const hubWrite = vi.spyOn(f.app.conversations, 'correct'), memberWrite = vi.spyOn(member.app.conversations, 'correct'), auth = f.app.auth;
  if (!(auth instanceof UiAuth)) throw new Error('Expected fixture state-point authority.'); const issue = vi.spyOn(auth, 'issue'), revoke = vi.spyOn(auth, 'logout');
  expect((await f.request(`${path}/correct`, 'POST', preview.requests.noted)).status).toBe(202);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'correction_save', args: { project: 'project', conversation: id, request: preview.requests.noted } })).toMatchObject({ ok: true });
  expect(hubWrite.mock.calls.length).toBe(0); expect(memberWrite.mock.calls.length).toBe(2); expect(issue.mock.calls.length).toBe(1); expect(revoke.mock.calls.length).toBe(1);
  expect(f.app.conversations.hasLocalConversation(id)).toBe(false); expect(member.fake.starts.length).toBe(1);
});
