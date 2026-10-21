import { afterEach, expect, test } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const fields = { title: '', task: '', isolation: '', modelId: '', effort: '', deviceId: '', type: 'feature', goalId: '', now: false, after: [] as string[], needs: '', fromBranch: '' };

test('task editor reads defaults, shared limits and caller device without starting work', async () => {
  f = await projectFixture(); const before = await f.app.projectWork.taskList(f.project.id), response = await f.request(`/api/projects/${f.project.id}/tasks/editor`); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-task-editor-v1', projectId: f.project.id, currentDeviceId: f.app.device.deviceId, fields, limits: { title: 120, task: 20000, fromBranch: 200 }, mainIsolationRefusal: 'Main isolation is not available yet.' });
  expect(view.models.map((row: { id: string }) => row.id)).toEqual((await f.app.configuration()).configuration['x-jevellan'].menu.filter(row => row.enabled).map(row => row.id));
  expect(await f.app.projectWork.taskList(f.project.id)).toEqual(before); expect(f.fake.runs).toHaveLength(0);
});

test('task preview normalizes explicit form fields and leaves Automatic placement omitted', async () => {
  f = await projectFixture(); const response = await f.request(`/api/projects/${f.project.id}/tasks/editor/preview`, 'POST', { schema: 'project-task-editor-preview-v1', fields: { ...fields, title: '  A queued fixture  ', task: '  Inspect the input boundary.  ', needs: 'residential, mac,, ', fromBranch: '  ' } }); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ canSave: true, plan: { body: { schema: 'task-create-request-v1', title: 'A queued fixture', brief: 'Inspect the input boundary.', type: 'feature', goalId: null, now: false, after: [], needs: ['residential', 'mac'], fixed: {} } } });
  expect('fromBranch' in view.plan.body).toBe(false); expect('clientRequestId' in view.plan.body).toBe(false); expect((await f.app.projectWork.taskList(f.project.id)).tasks).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
});

test('task editor saves through the canonical task boundary and preserves one receipt on retry', async () => {
  f = await projectFixture({ coordinator: true }); await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  const input = { schema: 'project-task-editor-save-v1', clientRequestId: 'task_editor_fixture', fields: { ...fields, title: '  Edited queued fixture  ', task: '  Keep the existing queue guards.  ', needs: 'mac, residential', fromBranch: '  fixture-base  ' } };
  const path = `/api/projects/${f.project.id}/tasks`;
  expect((await f.request(path, 'POST', input)).status).toBe(409); expect((await f.app.projectWork.taskList(f.project.id)).tasks).toHaveLength(0);
  f.git(f.checkout, 'push', f.origin, 'HEAD:refs/heads/fixture-base');
  const response = await f.request(path, 'POST', input); expect(response.status).toBe(201); const receipt = await response.json();
  const stored = await f.app.projectWork.tasks.read(f.project.id, receipt.taskId); expect(stored).toMatchObject({ title: 'Edited queued fixture', brief: 'Keep the existing queue guards.', needs: ['mac', 'residential'], fromBranch: 'fixture-base', fixed: {}, type: 'feature', goalId: null });
  const repeated = await f.request(path, 'POST', input); expect(repeated.status).toBe(201); expect(await repeated.json()).toMatchObject({ taskId: receipt.taskId, repeated: true });
  expect((await f.app.projectWork.tasks.list(f.project.id)).filter(row => row.requestDigest === stored.requestDigest)).toHaveLength(1);
  expect((await f.request(path, 'POST', { ...input, clientRequestId: 'task_editor_bad', command: 'never' })).status).toBe(400);
});

test('member task editor keeps its requesting device and retained unavailable choice', async () => {
  f = await projectFixture(); const member = await projectMember(f), response = await member.request(`/api/projects/${f.project.id}/tasks/editor`); expect(response.status).toBe(200); const initial = await response.json();
  expect(initial.currentDeviceId).toBe(member.deviceId);
  const preview = await member.request(`/api/projects/${f.project.id}/tasks/editor/preview`, 'POST', { schema: 'project-task-editor-preview-v1', fields: { ...fields, deviceId: 'device_no_longer_here' } }); expect(preview.status).toBe(200); const view = await preview.json();
  expect(view.devices.find((row: { id: string }) => row.id === 'device_no_longer_here')).toMatchObject({ id: 'device_no_longer_here', label: 'device_no_longer_here', disabled: true }); expect(member.fake.runs).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
});

test('shared task model command clears only unsupported effort on an explicit model change', () => {
  const command = (core as unknown as { taskEditorCommand(input: typeof fields, models: { id: string; efforts: string[] }[], command: { type: string; value: string }): typeof fields }).taskEditorCommand;
  expect(command({ ...fields, effort: 'high' }, [{ id: 'only_low', efforts: ['low'] }], { type: 'model', value: 'only_low' })).toMatchObject({ modelId: 'only_low', effort: '' });
  expect(command({ ...fields, effort: 'low' }, [{ id: 'only_low', efforts: ['low'] }], { type: 'model', value: 'only_low' })).toMatchObject({ modelId: 'only_low', effort: 'low' });
  expect(command({ ...fields, effort: 'high' }, [], { type: 'model', value: '' })).toMatchObject({ modelId: '', effort: 'high' });
});

test('task preview identifies invalid fields with readable messages instead of validator documents', async () => {
  f = await projectFixture(); const response = await f.request(`/api/projects/${f.project.id}/tasks/editor/preview`, 'POST', { schema: 'project-task-editor-preview-v1', fields: { ...fields, title: 'A valid fixture title', task: 'Check only the entered needs.', needs: 'one,two,three,four,five,six,seven,eight,nine' } }); expect(response.status).toBe(200); const view = await response.json();
  expect(view.canSave).toBe(false); expect(view.plan).toBeNull(); expect(view.validation.some((line: string) => line.startsWith('Needs: '))).toBe(true);
  expect(view.validation.some((line: string) => line.includes('"code"') || line.includes('"path"'))).toBe(false); expect((await f.app.projectWork.taskList(f.project.id)).tasks).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
});
