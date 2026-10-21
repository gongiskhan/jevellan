import { afterEach, expect, test } from 'vitest';
import { CoordinatorEventSchema } from '../packages/core/dist/index.js';
import { publicProjectData } from '../packages/projects/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/config/change-view';
async function prepare() {
  const f = fixture = await projectFixture(), work = f.app.projectWork, before = (await work.settingsView('project')).settings;
  const { change } = await work.coordinatorSettings('project', { maxRunningThreads: 7, startMode: 'propose', prAutoFix: { checks: false }, instructionsAppend: 'Keep it focused.', guidanceAppend: 'Choose carefully.', ownerWords: 'Fixture settings changes.' }, 'change_view_fixture');
  return { f, work, before, change, request: { schema: 'project-settings-change-view-request-v1', change } };
}

test('settings change views supply exact sentences and canonical per-field Undo requests', async () => {
  const { f, before, change, request } = await prepare(), response = await f.request(path, 'POST', request); expect(response.status).toBe(200);
  const view = await response.json(); expect(view).toMatchObject({ schema: 'project-settings-change-view-v1', projectId: 'project', changeId: change.id, undoLabel: 'Undo' });
  expect(view.items.map((row: { line: string }) => row.line)).toEqual([
    `Changed max running threads from ${before.maxRunningThreads} to 7.`, 'Changed start mode from start right away to propose first.',
    'Changed fixing failing checks from on to off.', 'Added to project instructions: "Keep it focused."', 'Added to guidance for Jev: "Choose carefully."',
  ]);
  expect(view.items.every((row: { undo: unknown }) => row.undo !== null)).toBe(true);
  const again = await (await f.request(path, 'POST', request)).json(); expect(again).toEqual(view); expect(f.fake.runs).toHaveLength(0);
});

test('prepared Undo restores only its field and refreshed metadata marks it unavailable', async () => {
  const { f, work, before, request } = await prepare(), response = await f.request(path, 'POST', request); expect(response.status).toBe(200);
  const view = await response.json(), row = view.items.find((row: { field: string }) => row.field === 'maxRunningThreads'), current = (await work.settingsView('project')).settings;
  const saved = await f.request(row.undo.path, 'POST', row.undo.body); expect(saved.status).toBe(200);
  expect((await saved.json()).settings).toEqual({ ...current, revision: current.revision + 1, maxRunningThreads: before.maxRunningThreads });
  const repeat = await f.request(row.undo.path, 'POST', row.undo.body); expect(repeat.status).toBe(200);
  const next = await (await f.request(path, 'POST', request)).json();
  expect(next.items.find((row: { field: string }) => row.field === 'maxRunningThreads')).toMatchObject({ undo: null, refusal: 'Changed again since.' });
});

test('stale Undo refuses while a refreshed request preserves newer unrelated settings', async () => {
  const { f, work, request } = await prepare(), response = await f.request(path, 'POST', request); expect(response.status).toBe(200);
  const view = await response.json(), row = view.items.find((row: { field: string }) => row.field === 'maxRunningThreads'), settings = await work.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, riskyAreas: 'A later unrelated edit.' }, settings.revision);
  expect((await f.request(row.undo.path, 'POST', row.undo.body)).status).toBe(409);
  const next = await (await f.request(path, 'POST', request)).json(), updated = next.items.find((row: { field: string }) => row.field === 'maxRunningThreads');
  expect(updated.undo.body.clientRequestId).not.toBe(row.undo.body.clientRequestId);
  expect((await f.request(updated.undo.path, 'POST', updated.undo.body)).status).toBe(200);
  expect((await work.settingsView('project')).settings.riskyAreas).toBe('A later unrelated edit.');
});

test('member settings change projections match the state point and refuse foreign project documents', async () => {
  const { f, request } = await prepare(), member = await projectMember(f), response = await member.request(path, 'POST', request); expect(response.status).toBe(200);
  const view = await response.json(); expect(view).toEqual(await (await f.request(path, 'POST', request)).json());
  expect((await member.request(path, 'POST', { ...request, change: { ...request.change, projectId: 'another' } })).status).toBe(400);
  expect((await member.request(path, 'POST', { ...request, extra: true })).status).toBe(400);
});

test('historical settings events receive server presentation only on public reads', () => {
  const raw = { schema: 'coordinator-event-v1', id: 'settings_event_fixture', at: '2026-10-20T12:00:00Z', kind: 'settings-changed', by: 'owner', changes: [{ field: 'maxRunningThreads', from: '3', to: '2' }, { field: 'startMode', from: 'start right away', to: 'propose first' }] };
  const saved = structuredClone(raw), view = publicProjectData(raw);
  expect(view).toHaveProperty('settingsPresentation', { schema: 'project-settings-event-presentation-v1', text: 'Project settings changed', detail: 'max running threads: 3 → 2; start mode: start right away → propose first' });
  expect(CoordinatorEventSchema.parse(view)).toEqual(view); expect(raw).toEqual(saved); expect(raw).not.toHaveProperty('settingsPresentation');
});

test('a later edit to the same field disables Undo and the canonical writer still refuses the old request', async () => {
  const { f, work, request } = await prepare(), response = await f.request(path, 'POST', request); expect(response.status).toBe(200);
  const view = await response.json(), row = view.items.find((row: { field: string }) => row.field === 'maxRunningThreads'), settings = await work.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, maxRunningThreads: 11 }, settings.revision);
  const next = await (await f.request(path, 'POST', request)).json(); expect(next.items.find((row: { field: string }) => row.field === 'maxRunningThreads')).toMatchObject({ undo: null, refusal: 'Changed again since.' });
  expect((await f.request(row.undo.path, 'POST', row.undo.body)).status).toBe(409);
  expect((await work.settingsView('project')).settings.maxRunningThreads).toBe(11);
});
