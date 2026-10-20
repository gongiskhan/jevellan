import { afterEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
async function setup() {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Fixture explanation ready.' }), forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'thread_why_fixture', title: 'Placement explanation fixture', task: 'Inspect the simulated fixture.' });
  await f.waitFor(() => f.thread(created.threadId), row => row.state === 'idle');
  return { f, id: created.threadId, path: `/api/projects/project/threads/${created.threadId}/why-view` };
}

test('thread Why supplies engine labels, ordered probabilities and owner-changed provenance', async () => {
  const { f, id, path } = await setup(), before = f.thread(id), beforeLabel = (await f.app.projectWork.views.thread('project', id)).thread.modelLabel;
  f.app.projectWork.store.update(id, row => ({ ...row, placement: { ...row.placement, source: 'jev', fixed: ['model'],
    probabilities: { pick_model: { alternative_model: 0.8, [row.placement.modelId]: 0.2 } }, eligibleModels: [row.placement.modelId, 'alternative_model'],
    excludedModels: [{ modelId: 'excluded_model', reason: 'Not selected by the owner.' }] } }));
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-thread-why-view-v1', projectId: 'project', threadId: id, title: before.title, placement: { sourceLabel: 'Jev', fixedLine: 'Fixed: Model' } });
  const field = view.fields.find((row: { field: string }) => row.field === 'model');
  expect(field).toMatchObject({ sourceLabel: 'changed by you', bars: [{ option: 'alternative_model', p: 0.8, chosen: false }, { option: before.placement.modelId, p: 0.2, chosen: true }], excluded: [{ label: 'excluded_model', reason: null }] });
  expect(field.valueLabel).toContain(beforeLabel);
});

test('Jev Why owner reads return the exact UI explanation without changing the thread', async () => {
  const { f, id, path } = await setup(), response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  const before = structuredClone(f.thread(id));
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'why', args: { project: 'project', thread: id } })).toMatchObject({ ok: true, data: view });
  expect(f.thread(id)).toEqual(before);
});

test('thread fallback notice is supplied by the engine and legacy account placements remain readable', async () => {
  const { f, id, path } = await setup();
  f.app.projectWork.store.update(id, row => ({ ...row, placement: { ...row.placement, source: 'fallback', accountChoice: undefined,
    fixed: [], probabilities: undefined, error: { kind: 'auth', message: 'Fixture placement unavailable.' } } }));
  const response = await f.request(`/api/projects/project/threads/${id}`); expect(response.status).toBe(200);
  expect((await response.json()).placementNotice).toBe('Placed without Jev: Fixture placement unavailable.');
  const why = await f.request(path); expect(why.status).toBe(200);
  expect(await why.json()).toMatchObject({ placement: { fallbackNotice: 'Placed without Jev: Fixture placement unavailable.' }, account: { showStandalone: true }, jev: { emptyLine: 'No Jev answer was used for this placement.' } });
});


test('thread Why preserves historical account candidate eligibility and unknown usage', async () => {
  const { f, id, path } = await setup(), modelLabel = (await f.app.projectWork.views.thread('project', id)).thread.modelLabel;
  f.app.projectWork.store.update(id, row => ({ ...row, placement: { ...row.placement, accountChoice: {
    schema: 'placement-account-choice-v1', questionSet: 'a-v1', source: 'session', accountId: row.placement.accountId, at: row.placement.decidedAt, jevCalls: [], candidates: [
      { accountId: row.placement.accountId, label: 'Chosen fixture', eligible: true, reason: 'Eligible fixture account.', ceilingPct: 90, credential: 'shared' },
      { accountId: 'unserved_fixture', label: 'Other fixture', eligible: false, reason: 'model-not-served', ceilingPct: 75, credential: 'per-device' },
    ],
  } } }));
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view.account).toMatchObject({ showCandidates: true, showStandalone: false, retainedMessage: 'Kept the eligible account of the current session.', candidates: [
    { label: 'Chosen fixture', chosen: true, detail: 'eligible · Shared saved login · Five hours unknown · Week unknown · Ceiling 90%' },
    { label: 'Other fixture', chosen: false, detail: `This account does not serve ${modelLabel}. · Device-local login · Five hours unknown · Week unknown · Ceiling 75%` },
  ] });
});

test('thread Why UI and tool reads stay on the member owning the thread', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  member.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Member explanation fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'member_thread_why', title: 'Member explanation', task: 'Inspect the simulated member fixture.', deviceId: member.deviceId });
  await f.waitFor(async () => { await member.app.projectWork.pulse(); return existsSync(member.app.projectWork.paths.threadFile('project', made.threadId)) ? member.thread(made.threadId).state : 'not-arrived'; }, state => state === 'idle');
  await member.app.projectWork.pulse(); await f.app.projectWork.pulse();
  const hubRead = vi.spyOn(f.app.projectWork.views, 'why'), memberRead = vi.spyOn(member.app.projectWork.views, 'why');
  const response = await f.request(`/api/projects/project/threads/${made.threadId}/why-view`); expect(response.status).toBe(200); const ui = await response.json();
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'why', args: { project: 'project', thread: made.threadId } })).toMatchObject({ ok: true, data: ui });
  expect(hubRead).not.toHaveBeenCalled(); expect(memberRead).toHaveBeenCalledTimes(2); expect(f.app.projectWork.store.get(made.threadId)).toBeUndefined();
});
