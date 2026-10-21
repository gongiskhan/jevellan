import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
import { settingsEditorRigging } from '../packages/projects/dist/index.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('project settings coordinator choices preserve the existing form labels through the shared engine', async () => {
  const f = fixture = await projectFixture(), response = await f.request('/api/projects/project/coordinator/editor'); expect(response.status).toBe(200);
  const editor = await response.json();
  const preview = await f.request(editor.request.previewPath, 'POST', { ...editor.request.base, presentation: 'project-settings', fields: editor.fields });
  expect(preview.status).toBe(200); const model = await preview.json();
  expect(model.models).toEqual([{ value: '', label: 'Automatic: first available', disabled: false }, { value: 'fixture', label: 'Fixture', disabled: false }]);
  expect(model.efforts).toEqual([{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra high' }, { value: 'max', label: 'Max' }]);
  expect(model.request.base.presentation).toBe('project-settings'); expect(model.saveRequest.settingsRequest.settings.coordinator).toEqual(editor.saveRequest.settingsRequest.settings.coordinator);
  expect(f.fake.runs).toHaveLength(0);
});

test('settings rigging summary is projected by the engine and shared with member readers', async () => {
  const f = fixture = await projectFixture();
  await f.app.rigging.add({ schema: 'add-rigging-v1', name: 'Project fixture guide', kind: 'skill', runtimes: { fake: true }, projects: ['project'], content: 'Fixture project instructions.' });
  await f.app.rigging.add({ schema: 'add-rigging-v1', name: 'Other fixture guide', kind: 'skill', runtimes: { fake: true }, projects: ['other'], content: 'Unrelated fixture instructions.' });
  const parked = await f.app.rigging.add({ schema: 'add-rigging-v1', name: 'Parked fixture guide', kind: 'skill', runtimes: { fake: true }, projects: ['project'], content: 'Parked fixture instructions.' });
  await f.app.rigging.update(parked.item.id, { schema: 'update-rigging-v1', revision: parked.revision, name: parked.item.name, runtimes: parked.item.runtimes, projects: parked.item.projects, content: parked.item.content, state: 'parked' });
  const response = await f.request('/api/projects/project/config/editor'); expect(response.status).toBe(200); const view = await response.json();
  expect(view.rigging, 'The engine projects the project Rigging summary.').toBeDefined();
  expect(view.rigging).toMatchObject({ schema: 'project-settings-rigging-v1', editPath: '/settings/rigging' });
  expect(view.rigging.names).toContain('Project fixture guide'); expect(view.rigging.names).not.toContain('Other fixture guide'); expect(view.rigging.names).not.toContain('Parked fixture guide');
  expect(view.rigging.message).toBe(`Rigging for this project: ${view.rigging.names.join(', ')}`);
  const member = await projectMember(f), remote = await member.request('/api/projects/project/config/editor'); expect(remote.status).toBe(200); expect((await remote.json()).rigging).toEqual(view.rigging);
});

test('empty scoped rigging metadata supplies the existing fallback without runtime work', () => {
  expect(settingsEditorRigging('project', [])).toEqual({ schema: 'project-settings-rigging-v1', names: [], message: 'No rigging items apply to this project.', editPath: '/settings/rigging' });
});
