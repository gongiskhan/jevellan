import { afterEach, expect, test } from 'vitest';
import { ProjectConfigurationInfoSchema, ProjectWorkSettingsViewSchema } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('configuration documents are strict and older settings responses remain readable without invented metadata', async () => {
  const f = fixture = await projectFixture(), view = await f.app.projectWork.settingsView('project');
  expect(ProjectConfigurationInfoSchema.safeParse(view.configuration).success).toBe(true);
  expect(ProjectConfigurationInfoSchema.safeParse({ ...view.configuration, unexpected: true }).success).toBe(false);
  expect(ProjectConfigurationInfoSchema.safeParse({ ...view.configuration, instructions: { ...view.configuration!.instructions, unexpected: true } }).success).toBe(false);
  const { configuration: _configuration, ...legacy } = view; void _configuration;
  expect(ProjectWorkSettingsViewSchema.parse(legacy)).not.toHaveProperty('configuration');
});

test('project configuration publishes canonical limits and consequences on the normal settings read', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/projects/project/work-settings'); expect(response.status).toBe(200);
  const view = await response.json();
  expect(view.configuration).toMatchObject({ schema: 'project-configuration-info-v1',
    instructions: { maxLength: 16000, help: 'The coordinator and every new thread receive these. Threads already running keep the version they started with.' },
    guidance: { maxLength: 2000 }, pauseHelp: 'Nothing new starts: no coordinator turns, no new threads or turns, no routines. Turns already running finish.',
    archiveHelp: 'Paused and hidden from the sidebar.', dailyThreadHelp: "Counted from midnight in the project's time zone.",
    conflictText: 'These settings changed elsewhere. Reload to see them.' });
  expect(f.fake.runs).toHaveLength(0);
});

test('the config alias and owner reader share settings and revision-checked writes without retired isolation fields', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/projects/project/config'); expect(response.status).toBe(200);
  const view = ProjectWorkSettingsViewSchema.parse(await response.json());
  const { schema: _schema, projectId: _id, revision, ...settings } = view.settings; void _schema; void _id;
  const request = { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, instructions: 'Keep the project focused.', placement: { ...settings.placement, guidance: 'Prefer careful changes.' } } };
  const saved = await f.request('/api/projects/project/config', 'PUT', request); expect(saved.status).toBe(200);
  const next = await saved.json(); expect(next.settings.revision).toBe(revision + 1); expect(next.settings.instructions).toBe(request.settings.instructions);
  expect(next.settings).not.toHaveProperty('defaultIsolation');
  expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'get', args: { project: 'project', section: 'project' } })).toMatchObject({ ok: true, data: next });
  const conflict = await f.request('/api/projects/project/config', 'PUT', request); expect(conflict.status).toBe(409);
  expect((await conflict.json()).message).toBe(next.configuration.conflictText);
});

test('a member receives the same configuration metadata and canonical length refusals', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  const response = await member.request('/api/projects/project/config'); expect(response.status).toBe(200);
  const view = await response.json(); expect(view).toEqual(await (await f.request('/api/projects/project/work-settings')).json());
  const { schema: _schema, projectId: _id, revision, ...settings } = view.settings; void _schema; void _id;
  for (const fields of [{ instructions: 'x'.repeat(view.configuration.instructions.maxLength + 1) }, { placement: { ...settings.placement, guidance: 'x'.repeat(view.configuration.guidance.maxLength + 1) } }]) {
    expect((await member.request('/api/projects/project/config', 'PUT', { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, ...fields } })).status).toBe(400);
  }
  expect(await (await f.request('/api/projects/project/work-settings')).json()).toEqual(view);
});

test('engine status banner requests unarchive to paused and then resume to active without replacing other settings', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork, current = await work.settingsView('project');
  const { schema: _schema, projectId: _id, revision, ...settings } = current.settings; void _schema; void _id;
  await work.putSettings('project', { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, status: 'archived', instructions: 'Retain this instruction.' } });
  for (const [actionLabel, status] of [['Unarchive', 'paused'], ['Resume', 'active']] as const) {
    const view = await work.pageView('project'); expect(view.header.banner?.actionLabel).toBe(actionLabel);
    const banner = view.header.banner!; expect(banner.request.settings.status).toBe(status);
    const saved = await f.request('/api/projects/project/config', 'PUT', banner.request); expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ status, instructions: 'Retain this instruction.' });
  }
  expect((await work.pageView('project')).header.banner).toBeNull(); expect(f.fake.runs).toHaveLength(0);
});
