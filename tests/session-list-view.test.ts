import { afterEach, expect, test } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });

test('shared session preferences preserve monotonic responses and canonical revision-bound writes', () => {
  expect(core.defaultSessionListPreferences).toBeTypeOf('function');
  const initial = core.defaultSessionListPreferences(); expect(initial).toEqual({ schema: 'session-list-preferences-v1', revision: 0, titles: {}, order: [] });
  const current = { ...initial, revision: 2, titles: { fixture: 'Current title' } };
  expect(core.acceptSessionListPreferences(current, initial)).toBe(current);
  const next = { ...current, titles: { fixture: 'Equal revision title' } }; expect(core.acceptSessionListPreferences(current, next)).toBe(next);
  const request = core.prepareSessionListUpdate(current, { operation: 'rename', id: 'fixture', title: ' New title ' }); expect(request).toEqual({ schema: 'session-list-update-v1', revision: 2, operation: 'rename', id: 'fixture', title: 'New title' });
  const saved = core.applySessionListUpdate(current, request); expect(saved).toMatchObject({ revision: 3, titles: { fixture: 'New title' } }); expect(current.titles.fixture).toBe('Current title');
  expect(core.applySessionListUpdate(saved, { schema: 'session-list-update-v1', revision: 3, operation: 'order', order: ['fixture', 'other', 'fixture'] })).toMatchObject({ revision: 4, order: ['fixture', 'other'] });
  expect(() => core.applySessionListUpdate(saved, request)).toThrow('The session list changed elsewhere. Try again with the refreshed list.');
  expect(() => core.prepareSessionListUpdate(current, { operation: 'rename', id: 'fixture', title: ' ' })).toThrow();
  expect(() => core.prepareSessionListUpdate(current, { operation: 'order', order: Array.from({ length: 10001 }, () => 'fixture') })).toThrow();
});

test('session preference HTTP views and owner tools share per-device storage and unchanged legacy revision guards', async () => {
  f = await projectFixture(); const initial = await f.request('/api/session-list/view'); expect(initial.status).toBe(200); const value = await initial.json();
  expect(value).toMatchObject({ schema: 'session-list-view-v1', deviceId: f.app.device.deviceId, preferences: { schema: 'session-list-preferences-v1', revision: 0, titles: {}, order: [] } });
  const rename = { schema: 'session-list-update-v1', revision: 0, operation: 'rename', id: 'fixture_session', title: ' Renamed fixture ' };
  const changed = await f.request('/api/session-list/view', 'POST', rename); expect(changed.status).toBe(200); const saved = await changed.json(); expect(saved.preferences).toMatchObject({ revision: 1, titles: { fixture_session: 'Renamed fixture' } });
  expect(await (await f.request('/api/session-list')).json()).toEqual(saved.preferences);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'session_list', args: { project: 'project' } })).toMatchObject({ ok: true, data: saved });
  const request = { schema: 'session-list-update-v1', revision: 1, operation: 'order', order: ['fixture_session', 'other', 'fixture_session'] };
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'session_list_save', args: { project: 'project', request } })).toMatchObject({ ok: true, data: { schema: 'session-list-view-v1', deviceId: f.app.device.deviceId, preferences: { revision: 2, order: ['fixture_session', 'other'] } } });
  for (const path of ['/api/session-list', '/api/session-list/view']) expect((await f.request(path, 'POST', rename)).status).toBe(409);
  const current = await (await f.request('/api/session-list/view')).json(); expect(current.preferences).toMatchObject({ revision: 2, titles: { fixture_session: 'Renamed fixture' }, order: ['fixture_session', 'other'] });
  expect((await f.request('/api/session-list/view', 'POST', { ...rename, revision: 2, title: ' ' })).status).toBe(400); expect(await (await f.request('/api/session-list/view')).json()).toEqual(current); expect(f.fake.runs).toHaveLength(0);
});
