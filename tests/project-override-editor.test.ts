import { afterEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { overrideEditorView } from '../packages/projects/dist/override-editor.js';
import { ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
async function setup() {
  const f = fixture = await projectFixture({ menu: [
    { id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model.', efforts: ['high'], enabled: true },
    { id: 'alternate', runtime: 'fake', model: 'alternate-model', label: 'Alternate', description: 'Simulated alternate.', efforts: ['low', 'high'], enabled: true },
  ] });
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Override editor fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'override_editor_fixture', title: 'Override editor fixture', task: 'Inspect the simulated fixture.', modelId: 'fixture', effort: 'medium' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  return { f, id: made.threadId, path: `/api/projects/project/threads/${made.threadId}/override-editor` };
}
async function editor(f: ProjectFixture, path: string) { const response = await f.request(path); expect(response.status).toBe(200); return response.json(); }

test('override editor defaults preserve requested effort and supply consequences, choices and Apply eligibility', async () => {
  const { f, id, path } = await setup(), view = await editor(f, path);
  expect(view).toMatchObject({ schema: 'project-thread-override-editor-v1', projectId: 'project', threadId: id,
    fields: { mode: 'next-turn', isolation: 'worktree', modelId: 'fixture', effort: 'medium', deviceId: f.app.device.deviceId, note: '' }, apply: { enabled: false }, constraints: { noteMax: 400 } });
  expect(view.choices.efforts).toEqual([{ value: 'medium', label: 'medium (runs as high)' }, { value: 'high', label: 'high' }]);
  expect(view.choices.modes).toContainEqual(expect.objectContaining({ value: 'next-turn', enabled: true, help: 'The model and effort change for the next turn; a running turn finishes as it started.' }));
  expect(view.choices.modes).toContainEqual(expect.objectContaining({ value: 'restart', enabled: true, help: 'This thread stops and its worktree is removed. A new thread with the same title and task starts with these choices.' }));
});

test('override editor preview normalizes model effort choices in the engine without changing the thread', async () => {
  const { f, id, path } = await setup(), view = await editor(f, path), before = structuredClone(f.thread(id));
  const response = await f.request(view.request.previewPath, 'POST', { schema: 'thread-override-editor-preview-request-v1', changed: 'model', fields: { ...view.fields, modelId: 'alternate', effort: 'max' } });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ fields: { modelId: 'alternate', effort: 'high' }, apply: { enabled: true } });
  expect(f.thread(id)).toEqual(before);
});

test('override editor UI and owner saves retain canonical next-turn retry behavior', async () => {
  const { f, id, path } = await setup(), view = await editor(f, path), request = { ...view.request.base, fields: { ...view.fields, effort: 'high', note: '  Use the supported effort.  ' } };
  const first = await f.request(view.request.savePath, 'POST', request); expect(first.status).toBe(200);
  await f.waitFor(() => f.thread(id), row => row.placement.effortRequested === 'high');
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'override_save', args: { project: 'project', thread: id, request } })).toMatchObject({ ok: true, data: { schema: 'thread-override-view-v1' } });
  expect(await f.app.projectHub.recentOverrides('project', 8)).toMatchObject([{ note: 'Use the supported effort.', changes: [{ field: 'effort', from: 'medium', to: 'high' }] }]);
  expect((await editor(f, path)).apply.enabled).toBe(false);
});

test('override editor restart retries reach the canonical receipt after the original thread stops', async () => {
  const { f, id, path } = await setup(), view = await editor(f, path), request = { ...view.request.base, fields: { ...view.fields, mode: 'restart' } };
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Restarted editor fixture.' }), forThread());
  const response = await f.request(view.request.savePath, 'POST', request); expect(response.status).toBe(200); const first = await response.json(); expect(first.newThreadId).toBeTruthy();
  await f.waitFor(() => f.thread(id), row => row.state === 'stopped'); await f.waitFor(() => f.thread(first.newThreadId), row => row.state === 'idle');
  const repeated = await f.request(view.request.savePath, 'POST', request); expect(repeated.status).toBe(200); expect(await repeated.json()).toEqual(first);
  expect(f.app.projectWork.store.all()).toHaveLength(2);
});


test('override metadata preserves a disabled current model and normalizes a return to the current runtime', async () => {
  const { f, id, path } = await setup(), config = f.app.hub.configuration.current()!;
  config.configuration['x-jevellan'].menu.find(row => row.id === 'fixture')!.enabled = false;
  f.app.hub.configuration.put(config.configuration, config.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  const model = await editor(f, path); expect(model.fields.modelId).toBe('fixture');
  expect(model.choices.models).toContainEqual(expect.objectContaining({ value: 'fixture' }));
  const view = await f.app.projectWork.views.thread('project', id), work = await f.app.projectWork.view('project'), roster = (await f.app.roster()).devices;
  const menu = [...config.configuration['x-jevellan'].menu, { ...config.configuration['x-jevellan'].menu[0]!, id: 'other_runtime_model', runtime: 'other_runtime' }];
  const restored = overrideEditorView('project', view, work, menu, roster, f.app.device.deviceId, value => value, {
    schema: 'thread-override-editor-preview-request-v1', changed: 'mode', fields: { ...model.fields, mode: 'next-turn', modelId: 'other_runtime_model', effort: '' },
  });
  expect(restored.fields).toMatchObject({ modelId: 'fixture', effort: 'medium' }); expect(restored.apply.enabled).toBe(false);
});

test('engine override consequences distinguish external checkouts, saved main commits and a refused restart', async () => {
  const { f, id } = await setup(), view = await f.app.projectWork.views.thread('project', id), work = await f.app.projectWork.view('project');
  const menu = f.app.hub.configuration.current()!.configuration['x-jevellan'].menu, roster = (await f.app.roster()).devices;
  const model = (v: typeof view, w: typeof work) => overrideEditorView('project', v, w, menu, roster, f.app.device.deviceId, value => value);
  expect(model(view, { ...work, project: { ...work.project, branchPolicy: 'external' } }).choices.modes.find(row => row.value === 'restart')?.help).toBe('This thread stops and its edits stay in your checkout. A new thread starts with the same title and task. Git is left to you.');
  expect(model({ ...view, thread: { ...view.thread, isolation: 'main' } }, work).choices.modes.find(row => row.value === 'restart')?.help).toContain('commits it has not published are saved under refs/jevellan/discard');
  const refused = model({ ...view, canOverride: { nextTurn: false, restart: false, restartReason: 'This thread has an open pull request.' } }, work);
  expect(refused.choices.modes.find(row => row.value === 'restart')).toMatchObject({ enabled: false, help: 'This thread has an open pull request.' }); expect(refused.apply.enabled).toBe(false);
});

test('override editor UI and tool saves stay on the member thread owner', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  member.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Member override fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'member_override_editor', title: 'Member override editor', task: 'Inspect the simulated member fixture.', deviceId: member.deviceId, effort: 'medium' });
  await f.waitFor(async () => { await member.app.projectWork.pulse(); return existsSync(member.app.projectWork.paths.threadFile('project', made.threadId)) ? member.thread(made.threadId).state : 'not-arrived'; }, state => state === 'idle');
  await member.app.projectWork.pulse(); await f.app.projectWork.pulse();
  const path = `/api/projects/project/threads/${made.threadId}/override-editor`, view = await editor(f, path), request = { ...view.request.base, fields: { ...view.fields, effort: 'high' } };
  const hubWrite = vi.spyOn(f.app.projectWork.threads, 'overrideNextTurn'), memberWrite = vi.spyOn(member.app.projectWork.threads, 'overrideNextTurn');
  expect((await f.request(path, 'POST', request)).status).toBe(200);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'override_save', args: { project: 'project', thread: made.threadId, request } })).toMatchObject({ ok: true });
  expect(hubWrite).not.toHaveBeenCalled(); expect(memberWrite).toHaveBeenCalledTimes(2); expect(member.thread(made.threadId).placement.effortRequested).toBe('high');
});

test('owner editor restart preserves normal authority when the coordinator is on the other device', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), member = await projectMember(f); member.fake.capabilities.readOnlyEnforced = true;
  await f.app.projectWork.prepareDailyWork('project'); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect((await member.request('/api/projects/project/coordinator/move', 'POST', { schema: 'empty-request-v1' })).status).toBe(200); await member.app.projectWork.idle();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Hub thread with member coordinator.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'remote_coordinator_editor', title: 'Remote coordinator editor', task: 'Inspect the simulated hub fixture.', deviceId: f.app.device.deviceId });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  const model = await editor(f, `/api/projects/project/threads/${made.threadId}/override-editor`), request = { ...model.request.base, fields: { ...model.fields, mode: 'restart' } };
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Owner-authorized restart through member coordinator.' }), forThread());
  const result = await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'override_save', args: { project: 'project', thread: made.threadId, request } });
  expect(result).toMatchObject({ ok: true, data: { schema: 'thread-override-view-v1', newThreadId: expect.any(String) } });
  if (!result.ok) throw new Error('Expected the normal owner restart.'); const id = (result.data as { newThreadId: string }).newThreadId;
  await f.waitFor(() => f.thread(id), row => row.state === 'idle'); expect(f.thread(made.threadId).restartedAs).toBe(id);
});
