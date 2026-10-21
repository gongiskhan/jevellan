import { afterEach, expect, test, vi } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
test('owner task creation reaches its existing coordinator without moving work to the hub', async () => {
  f = await projectFixture({ coordinator: true }); const member = await projectMember(f);
  await member.app.projectHub.assignCoordinator(f.project.id, member.deviceId, 0);
  const remote = vi.spyOn(member.app.projectWork, 'createTask'), local = vi.spyOn(f.app.projectWork, 'createTask');
  const result = await f.app.ownerTools.call('work', { schema: 'owner-tool-request-v1', caller: 'cli', args: { action: 'add', title: 'Remote queue fixture', description: 'Keep the task on the existing coordinator.' } });
  expect(result.ok).toBe(true); expect(remote).toHaveBeenCalledTimes(1); expect(local).not.toHaveBeenCalled();
  expect((await f.app.projectWork.taskList(f.project.id)).tasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Remote queue fixture' })]));
});
