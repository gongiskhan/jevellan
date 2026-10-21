import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/config/landing-editor';
async function editor(f: Pick<ProjectFixture, 'request'>, settings: unknown) {
  const response = await f.request(path, 'POST', { schema: 'project-landing-editor-request-v1', settings }); expect(response.status).toBe(200); return response.json();
}
async function preview(f: Pick<ProjectFixture, 'request'>, view: Awaited<ReturnType<typeof editor>>, fields: object) {
  const response = await f.request(path, 'POST', { ...view.request.base, fields: { ...view.fields, ...fields } }); expect(response.status).toBe(200); return response.json();
}

test('landing editor supplies canonical constraints, choices, help and the raw draft from the supplied snapshot', async () => {
  const f = fixture = await projectFixture(), settings = (await f.app.projectWork.settingsView('project')).settings, view = await editor(f, settings);
  expect(view).toMatchObject({ schema: 'project-landing-editor-v1', projectId: 'project', fields: { delivery: settings.delivery, autoLand: settings.autoLand, checks: [], smokeCheck: '', mergeCommitPaths: '' },
    limits: { checks: 30, paths: 30, name: 80, command: 2000, smokeCheck: 2000, mergePaths: 20 }, canAddCheck: true, apply: { enabled: true, errors: [] },
    newCheck: { name: '', paths: '', command: '' }, routeHelp: 'Jev chooses the route after the configured checks pass. Existing threads keep their delivery.' });
  expect(view.deliveryChoices.map((row: { value: string }) => row.value)).toEqual(['land', 'pull-request']);
  expect(f.fake.runs).toHaveLength(0);
});

test('landing previews preserve path whitespace, drop empty lines and keep raw text separate from canonical values', async () => {
  const f = fixture = await projectFixture(), settings = (await f.app.projectWork.settingsView('project')).settings, initial = await editor(f, settings);
  const checks = [{ name: 'Focused check', paths: 'src\n\n spaced path \n', command: 'npm test' }], view = await preview(f, initial, { checks, smokeCheck: '', mergeCommitPaths: 'docs\n\n notes \n' });
  expect(view.fields.checks).toEqual(checks); expect(view.fields.mergeCommitPaths).toBe('docs\n\n notes \n');
  expect(view.patch).toMatchObject({ landingChecks: [{ name: 'Focused check', paths: ['src', ' spaced path '], command: 'npm test' }], smokeCheck: null, mergeCommitPaths: ['docs', ' notes '] });
  expect((await preview(f, initial, { smokeCheck: ' ' })).patch.smokeCheck).toBe(' ');
  expect((await f.app.projectWork.settingsView('project')).settings).toEqual(settings);
});

test('invalid landing drafts have field errors and cannot prepare a save', async () => {
  const f = fixture = await projectFixture(), settings = (await f.app.projectWork.settingsView('project')).settings, initial = await editor(f, settings);
  for (const fields of [{ checks: [{ name: '', paths: '', command: '' }] }, { checks: [{ name: 'Check', paths: '../outside', command: 'true' }] }, { smokeCheck: 'x'.repeat(2001) }, { mergeCommitPaths: Array.from({ length: 21 }, (_, i) => `path${i}`).join('\n') }]) {
    const view = await preview(f, initial, fields); expect(view.apply.enabled).toBe(false); expect(view.apply.errors.length).toBeGreaterThan(0); expect(view.patch).toBeNull(); expect(view.saveRequest).toBeNull();
  }
  const full = await preview(f, initial, { checks: Array.from({ length: 30 }, (_, i) => ({ name: `Check${i}`, paths: '', command: 'true' })) });
  expect(full.apply.enabled).toBe(true); expect(full.canAddCheck).toBe(false);
  expect((await f.app.projectWork.settingsView('project')).settings).toEqual(settings);
});

test('landing prepared saves use the canonical CAS writer, preserve unrelated fields and recover a normal retry', async () => {
  const f = fixture = await projectFixture(), before = (await f.app.projectWork.settingsView('project')).settings, view = await preview(f, await editor(f, before), { smokeCheck: 'npm test', mergeCommitPaths: 'docs' });
  const first = await f.request(view.request.savePath, 'POST', view.saveRequest); expect(first.status).toBe(200); const saved = await first.json();
  expect(saved.settings).toEqual({ ...before, revision: before.revision + 1, smokeCheck: 'npm test', mergeCommitPaths: ['docs'] });
  const retry = await f.request(view.request.savePath, 'POST', view.saveRequest); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(saved);
  const stale = await preview(f, await editor(f, before), { smokeCheck: 'Other check' });
  expect((await f.request(stale.request.savePath, 'POST', stale.saveRequest)).status).toBe(409); expect((await f.app.projectWork.settingsView('project')).settings).toEqual(saved.settings);
});

test('member landing previews match the hub and reject foreign snapshots without writes', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), settings = (await f.app.projectWork.settingsView('project')).settings, view = await editor(member, settings);
  const prepared = await preview(member, view, { smokeCheck: 'true' });
  expect((await member.request(prepared.request.savePath, 'POST', prepared.saveRequest)).status).toBe(200);
  expect((await f.app.projectWork.settingsView('project')).settings.smokeCheck).toBe('true');
  expect((await member.request(path, 'POST', { schema: 'project-landing-editor-request-v1', settings: { ...settings, projectId: 'another' } })).status).toBe(400);
});
