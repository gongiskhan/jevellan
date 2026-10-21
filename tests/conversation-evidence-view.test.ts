import { afterEach, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../packages/core/dist/index.js';
import { UiAuth } from '../packages/mesh/dist/index.js';
import { ownerConversationOperation } from '../apps/daemon/dist/owner-proxy.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
import { conversationPlanFixture } from './helpers/conversation-plan-fixture.js';
import { conversationPlanReviewFixture } from './helpers/conversation-plan-review-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

test('shared evidence references preserve exact pointer, file, URL and relative-link rules', () => {
  expect(core.evidenceReference).toBeTypeOf('function');
  for (const ref of ['handoffs/1', 'ledger/2', `blobs/${'a'.repeat(64)}`]) expect(core.evidenceReference(ref)).toMatchObject({ kind: 'pointer', value: ref });
  for (const ref of ['src/value.ts:2:7', '/project/docs/a note.md', 'docs/README.md#L2-L4']) expect(core.evidenceReference(ref).kind).toBe('file');
  for (const ref of ['npm test', '0.25', '1.2.3', 'mailto:team@example.invalid', 'javascript:alert(1)', 'data:text/plain,x']) expect(core.evidenceReference(ref).kind).toBe('text');
  expect(core.evidenceReference('https://example.invalid/a.ts').kind).toBe('url');
  expect(core.decodeReference('docs/a%20note.md')).toBe('docs/a note.md'); expect(core.decodeReference('100%complete.md')).toBe('100%complete.md');
  expect(core.relativeEvidenceReference('docs/guide.md', '../src/value.ts#L2')).toBe('src/value.ts#L2');
  expect(core.relativeEvidenceReference('docs/guide.md', 'handoffs/1')).toBe('handoffs/1');
  expect(core.relativeEvidenceReference('docs/guide.md', '/project/value.ts:2')).toBe('/project/value.ts:2');
  expect(core.markdownEvidenceTarget('docs/a%20note.md', 'link', true, false)).toBe('docs/a note.md');
  expect(core.markdownEvidenceTarget('https://example.invalid/a.png', 'image', true, true)).toBeNull();
  expect(core.markdownEvidenceTarget('screen.png', 'code', false, true)).toBe('screen.png');
  expect(core.markdownEvidenceTarget('src/a.ts', 'code', false, true)).toBeNull();
  expect(core.markdownEvidenceTarget('screen.png', 'code', true, false, 'language-ts')).toBeNull();
});

test('canonical evidence reader shares typed public documents through HTTP and owner tools without starting work', async () => {
  const made = await conversationPlanFixture(); f = made.f;
  const starts = f.fake.starts.length, count = f.app.conversations.ledger(made.id).events().length;
  expect(f.app.conversations.ledger(made.id).read(made.pointer)).toEqual(made.content);
  const request = { schema: 'conversation-evidence-request-v1', ref: made.pointer, output: false };
  const response = await f.request(`/api/conversations/${made.id}/evidence-read`, 'POST', request); expect(response.status).toBe(200); const value = await response.json();
  expect(value).toMatchObject({ schema: 'conversation-evidence-view-v1', projectId: 'project', conversationId: made.id, reference: { kind: 'pointer', value: made.pointer }, view: { kind: 'text', text: JSON.stringify(f.app.conversations.ledger(made.id).read(made.pointer), null, 2) }, switching: null });
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'evidence_read', args: { project: 'project', conversation: made.id, request } })).toMatchObject({ ok: true, data: value });
  const markdown = f.app.conversations.ledger(made.id).putBlob('# Public evidence').ref;
  expect(await f.app.conversations.evidenceRead(made.id, { ...request, ref: markdown })).toMatchObject({ view: { kind: 'markdown', text: '# Public evidence' } });
  expect(await f.app.conversations.evidenceRead(made.id, { ...request, ref: markdown, output: true })).toMatchObject({ view: { kind: 'text', text: '# Public evidence' } });
  const native = f.app.conversations.ledger(made.id).putBlob({ schema: 'stretch-v2', n: 1, native: { sessionId: 'synthetic-evidence-process' } }).ref;
  expect(JSON.stringify(await f.app.conversations.evidenceRead(made.id, { ...request, ref: native }))).not.toContain('synthetic-evidence-process');
  expect(f.fake.starts).toHaveLength(starts); expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);
});

test('evidence files preserve canonical source confinement and prepare source labels and toggles', async () => {
  const made = await conversationPlanReviewFixture(); f = made.f; writeFileSync(join(f.checkout, 'guide.md'), '# Fixture guide\n\n[Value](value.txt#L1)\n');
  const request = { schema: 'conversation-evidence-request-v1', ref: 'guide.md', stretch: 1, source: 'working-tree' };
  const before = f.fake.starts.length, response = await f.request(`/api/conversations/${made.id}/evidence-read`, 'POST', request); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ reference: { kind: 'file', value: 'guide.md' }, view: { kind: 'file', file: { path: 'guide.md', source: 'working-tree', kind: 'markdown' }, presentation: { schema: 'evidence-file-presentation-v1', sourceLabel: 'Current working copy · not a saved step', initialSource: false, linkBase: 'guide.md' } }, switching: { workingDisabled: true, recordedDisabled: false } });
  expect(await f.app.conversations.evidenceRead(made.id, { ...request, ref: 'guide.md:1' })).toMatchObject({ view: { presentation: { initialSource: true } } });
  expect((await f.request(`/api/conversations/${made.id}/evidence-read`, 'POST', { ...request, ref: '../outside.md' })).status).toBe(403);
  expect((await f.request(`/api/conversations/${made.id}/evidence-read`, 'POST', { ...request, ref: '.env' })).status).toBe(403);
  expect(f.fake.starts).toHaveLength(before);
});

test('member evidence tools bind the owning project and exact reference and revoke temporary authority', async () => {
  f = await projectFixture(); const member = await projectMember(f), id = 'member_evidence_read';
  await member.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Member evidence', message: 'Read the simulated evidence.', clientMessageId: 'evidence_first' });
  await member.app.conversations.wait(id); await member.app.conversations.list();
  const ref = member.app.conversations.ledger(id).putBlob('# Owner evidence').ref, request = { schema: 'conversation-evidence-request-v1', ref };
  const auth = f.app.auth; if (!(auth instanceof UiAuth)) throw Error('Expected state-point authority.');
  const local = vi.spyOn(f.app.conversations, 'evidenceRead'), remote = vi.spyOn(member.app.conversations, 'evidenceRead'), issue = vi.spyOn(auth, 'issue'), revoke = vi.spyOn(auth, 'logout');
  const result = core.ConversationEvidenceViewSchema.parse(await ownerConversationOperation(f.app, 'project', id, 'evidence-read', request)); expect(result).toMatchObject({ projectId: 'project', conversationId: id, reference: { value: ref }, view: { kind: 'markdown', text: '# Owner evidence' } });
  expect(local).not.toHaveBeenCalled(); expect(remote).toHaveBeenCalledTimes(1);
  await expect(ownerConversationOperation(f.app, 'another_project', id, 'evidence-read', request)).rejects.toMatchObject({ status: 409 });
  remote.mockResolvedValueOnce({ ...result, reference: { schema: 'evidence-reference-v1', kind: 'pointer', value: 'handoffs/99' } });
  await expect(ownerConversationOperation(f.app, 'project', id, 'evidence-read', request)).rejects.toMatchObject({ status: 502 });
  expect(revoke.mock.calls.length).toBe(issue.mock.calls.length); expect(f.app.conversations.hasLocalConversation(id)).toBe(false); expect(member.fake.starts).toHaveLength(0);
});
