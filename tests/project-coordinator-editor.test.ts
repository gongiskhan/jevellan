import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, FIXTURE_MENU, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/coordinator/editor';
async function editor(f: Pick<ProjectFixture, 'request'>) { const response = await f.request(path); expect(response.status).toBe(200); return response.json(); }
async function preview(f: Pick<ProjectFixture, 'request'>, view: Awaited<ReturnType<typeof editor>>, fields: object) {
  const response = await f.request(view.request.previewPath, 'POST', { ...view.request.base, fields: { ...view.fields, ...fields } }); expect(response.status).toBe(200); return response.json();
}

test('coordinator editor owns model availability, requested effort preview and Fresh eligibility', async () => {
  const f = fixture = await projectFixture({ menu: [...FIXTURE_MENU, { ...FIXTURE_MENU[0]!, id: 'legacy', label: 'Legacy', enabled: false }] });
  const settings = await f.app.projectWork.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, coordinator: { ...settings.coordinator, modelId: 'legacy', effort: 'low' } }, settings.revision);
  const view = await editor(f);
  expect(view).toMatchObject({ schema: 'project-coordinator-editor-v1', projectId: 'project', fields: { modelId: 'legacy', effort: 'low', fresh: false },
    freshEnabled: (await f.app.projectWork.view('project')).coordinator.online, help: 'These choices apply from the next turn. The current turn can finish.' });
  expect(view.models.map((row: { value: string }) => row.value)).toEqual(['', 'fixture', 'legacy']);
  expect(view.models.find((row: { value: string }) => row.value === 'legacy').disabled).toBe(true);
  const changed = await preview(f, view, { modelId: 'fixture', effort: 'low' });
  expect(changed.effectiveEffort).toEqual({ requested: 'low', actual: 'high', line: 'low → high: nearest effort this model supports.' });
  expect(changed.saveRequest.settingsRequest.settings.coordinator.effort).toBe('low'); expect(f.fake.runs).toHaveLength(0);
  expect(changed.saveRequest.settingsRequest.clientRequestId).not.toBe(view.saveRequest.settingsRequest.clientRequestId);
});

test('coordinator prepared saves preserve unrelated fields and normal no-Fresh retry receipts', async () => {
  const f = fixture = await projectFixture(), before = (await f.app.projectWork.settingsView('project')).settings;
  const view = await preview(f, await editor(f), { modelId: 'fixture', effort: 'low' });
  const first = await f.request(view.request.savePath, 'POST', view.saveRequest); expect(first.status).toBe(200); const saved = await first.json();
  expect(saved.settings).toEqual({ ...before, revision: before.revision + 1, coordinator: { ...before.coordinator, modelId: 'fixture', effort: 'low' } });
  const retry = await f.request(view.request.savePath, 'POST', view.saveRequest); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(saved);
  expect(f.fake.runs).toHaveLength(0);
});

test('stale coordinator choices cannot replace newer unrelated settings', async () => {
  const f = fixture = await projectFixture(), view = await preview(f, await editor(f), { modelId: 'fixture' });
  const settings = await f.app.projectWork.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, instructions: 'A later owner edit.' }, settings.revision);
  expect((await f.request(view.request.savePath, 'POST', view.saveRequest)).status).toBe(409);
  const current = (await f.app.projectWork.settingsView('project')).settings;
  expect(current).toMatchObject({ revision: settings.revision + 1, coordinator: settings.coordinator, instructions: 'A later owner edit.' });
  expect((await f.request(view.request.previewPath, 'POST', { ...view.request.base, fields: view.fields })).status).toBe(409);
});

test('member coordinator reads and saves share the canonical owner workflow', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), initial = await editor(member);
  const view = await preview(member, initial, { modelId: 'fixture', effort: 'low' });
  expect((await member.request(view.request.savePath, 'POST', view.saveRequest)).status).toBe(200);
  expect((await f.app.projectWork.settingsView('project')).settings.coordinator).toMatchObject({ modelId: 'fixture', effort: 'low' });
  expect((await editor(f)).fields).toEqual({ modelId: 'fixture', effort: 'low', fresh: false });
});

test('prepared Fresh uses the assigned coordinator session reset without starting a turn', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), work = f.app.projectWork;
  await work.coordinators.ensureAssigned('project');
  work.coordinators.store.update('project', state => ({ ...state, session: { runtime: 'fake', modelId: 'fixture', model: 'scripted-model', effort: 'high', accountId: 'fixture_account', startedAt: new Date().toISOString(), turns: 1 } }));
  const initial = await editor(f); expect(initial.freshEnabled).toBe(true);
  const view = await preview(f, initial, { fresh: true });
  expect((await f.request(view.request.savePath, 'POST', view.saveRequest)).status).toBe(200);
  expect(f.coordinatorState().session).toBeNull(); expect(f.fake.runs).toHaveLength(0);
});

test('unavailable model and offline Fresh previews cannot produce an applicable save', async () => {
  const f = fixture = await projectFixture({ menu: [...FIXTURE_MENU, { ...FIXTURE_MENU[0]!, id: 'disabled', enabled: false }] });
  const initial = await editor(f), blocked = await preview(f, initial, { modelId: 'disabled' });
  expect(blocked.apply.enabled).toBe(false); expect(blocked.saveRequest).toBeNull();
  const unassigned = await preview(f, initial, { fresh: true }); expect(unassigned.freshEnabled).toBe(false);
  expect(unassigned.apply.enabled).toBe(false); expect(unassigned.saveRequest).toBeNull();
  expect((await f.request(initial.request.savePath, 'POST', { ...initial.saveRequest, fresh: true })).status).toBe(409);
  expect((await f.app.projectWork.settingsView('project')).settings.revision).toBe(initial.revision); expect(f.fake.runs).toHaveLength(0);
});

test('owner tools save and Fresh on the assigned member while preserving its coordinator ownership', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), work = member.app.projectWork;
  await work.coordinators.ensureAssigned('project');
  work.coordinators.store.update('project', state => ({ ...state, session: { runtime: 'fake', modelId: 'fixture', model: 'scripted-model', effort: 'high', accountId: 'acc_member', startedAt: new Date().toISOString(), turns: 1 } }));
  await member.heartbeat();
  const view = await preview(f, await editor(f), { modelId: 'fixture', effort: 'low', fresh: true });
  expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'coordinator_save', args: { project: 'project', request: view.saveRequest } })).toMatchObject({ ok: true, data: { settings: { coordinator: { modelId: 'fixture', effort: 'low' } } } });
  expect(work.coordinators.get('project').state().session).toBeNull();
  expect(await f.app.projectWork.coordinatorDevice('project')).toBe(member.deviceId); expect(member.fake.runs).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
});

test('coordinator editor refuses unknown fields and cross-project requests before any settings change', async () => {
  const f = fixture = await projectFixture(), view = await editor(f), base = { ...view.request.base, fields: view.fields };
  for (const body of [{ ...base, extra: true }, { ...base, fields: { ...view.fields, extra: true } }, { ...base, projectId: 'another' }]) {
    expect((await f.request(view.request.previewPath, 'POST', body)).status).toBe(400);
  }
  expect((await f.request(view.request.savePath, 'POST', { ...view.saveRequest, projectId: 'another' })).status).toBe(400);
  expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'coordinator_save', args: { project: 'project', request: { ...view.saveRequest, projectId: 'another' } } })).toMatchObject({ ok: false });
  expect((await f.app.projectWork.settingsView('project')).settings.revision).toBe(view.revision); expect(f.fake.runs).toHaveLength(0);
});
