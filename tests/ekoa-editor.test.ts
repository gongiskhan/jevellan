import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

test('removing a mirror token disables the mirror in the canonical service for every caller', async () => {
  f = await projectFixture(); f.app.hub.vault.put('ekoa', `fixture-${randomUUID()}`);
  const response = await f.request('/hub/ekoa', 'PUT', { schema: 'ekoa-settings-input-v1', clientRequestId: 'mirror_remove_disables', revision: 0, url: '', enabled: true, removeToken: true });
  expect(response.status).toBe(200); const state = await response.json();
  expect(state.settings).toMatchObject({ enabled: false, url: '', revision: 1 }); expect(state.tokenSaved).toBe(false); expect(f.fake.runs).toHaveLength(0);
});

test('a stale mirror save cannot disconnect the current provider transaction', async () => {
  f = await projectFixture();
  const saved = await f.request('/hub/ekoa', 'PUT', { schema: 'ekoa-settings-input-v1', clientRequestId: 'mirror_initial', revision: 0, url: '', enabled: false }); expect(saved.status).toBe(200);
  const disconnect = vi.spyOn(f.app.ekoa!.oauth, 'disconnect');
  const response = await f.request('/hub/ekoa', 'PUT', { schema: 'ekoa-settings-input-v1', clientRequestId: 'mirror_stale', revision: 0, url: '', enabled: false, token: `fixture-${randomUUID()}` });
  expect(response.status).toBe(409); expect(disconnect).not.toHaveBeenCalled(); expect(f.app.ekoa!.settings().revision).toBe(1);
});

test('mirror editor owns default connect URL and truthful connection and mirror copy', async () => {
  f = await projectFixture(); const base = f.app.ekoa!.state();
  const mirror = { schema: 'ekoa-mirror-v1' as const, projectId: 'project', kind: 'decision' as const, jevellanId: 'choice', endpoint: 'https://fixture.example/mcp', marker: 'fixture_marker', ekoaTaskId: null, createAttempted: false, payloadDigest: null, attempts: 0, retryAt: null, updatedAt: '2026-10-21T08:00:00Z' };
  vi.spyOn(f.app.ekoa!, 'state').mockReturnValue({ ...base, tokenSaved: true, connection: { schema: 'ekoa-connection-v1', at: '2026-10-21T08:00:00Z', status: 'blocked', reason: 'Fixture connection blocked.', tools: [], attempts: 1, retryAt: null, settingsRevision: 0 }, mirrors: [
    { ...mirror, id: 'mirror_open', title: 'Open fixture', state: 'open' }, { ...mirror, id: 'mirror_done', state: 'completed' }, { ...mirror, id: 'mirror_pending', state: 'pending', error: 'Fixture retry pending.', retryAt: '2026-10-21T09:00:00Z' },
  ] });
  const response = await f.request('/hub/ekoa/editor'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'ekoa-editor-v1', fields: { url: '', enabled: false }, connect: { defaultUrl: 'https://mcp.ekoa.io/mcp' }, presentation: { oauthLine: 'Sign in to grant task read and write access.', tokenLine: 'Token saved in the hub vault.', tokenPlaceholder: 'Saved · enter a replacement', connection: { title: 'Connection blocked' }, mirrorsLine: '1 open · 1 completed' } });
  expect(view.presentation.mirrors.map((row: { title: string }) => row.title)).toEqual(['Open fixture', 'decision', 'decision']);
  expect(view.presentation.errors).toEqual([{ id: 'mirror_pending', message: 'Fixture retry pending.', retryLine: 'Jevellan will retry.' }]); expect(f.fake.runs).toHaveLength(0);
});

test('mirror previews reject missing URL and exclude passwords without writing or connecting', async () => {
  f = await projectFixture(); const input = { schema: 'ekoa-editor-preview-v1', revision: 0, fields: { url: '', enabled: true }, operation: 'save', credentialPresent: true };
  const response = await f.request('/hub/ekoa/editor/preview', 'POST', input); expect(response.status).toBe(200); const blocked = await response.json();
  expect(blocked.canSave).toBe(false); expect(blocked.validation).toContain('Add the MCP URL before enabling the mirror.');
  const allowed = await f.request('/hub/ekoa/editor/preview', 'POST', { ...input, fields: { url: 'https://fixture.example/mcp', enabled: false } }); expect(allowed.status).toBe(200); const view = await allowed.json();
  expect(view).toMatchObject({ canSave: true, plan: { body: { schema: 'ekoa-settings-input-v1', revision: 0, enabled: false }, includeCredential: true } }); expect('token' in view.plan.body).toBe(false); expect('credential' in view.plan.body).toBe(false);
  expect((await f.request('/hub/ekoa/editor/preview', 'POST', { ...input, credential: 'fixture-hidden' })).status).toBe(400); expect(f.app.ekoa!.settings().revision).toBe(0); expect(f.fake.runs).toHaveLength(0);
});

test('mirror editor saves credentials only through the canonical vault writer and removes them while disabling', async () => {
  f = await projectFixture(); const credential = `fixture-${randomUUID()}`, input = { schema: 'ekoa-editor-save-v1', revision: 0, fields: { url: '', enabled: false }, operation: 'save', credential, clientRequestId: 'mirror_editor_save' };
  const response = await f.request('/hub/ekoa/editor', 'PUT', input); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'ekoa-editor-v1', state: { tokenSaved: true, settings: { revision: 1, enabled: false } } }); expect(JSON.stringify(view).includes(credential)).toBe(false);
  expect((await f.request('/hub/ekoa/editor', 'PUT', input)).status).toBe(200); expect(f.app.ekoa!.settings().revision).toBe(1);
  const removed = await f.request('/hub/ekoa/editor', 'PUT', { schema: 'ekoa-editor-save-v1', revision: 1, fields: { url: '', enabled: true }, operation: 'remove-token', clientRequestId: 'mirror_editor_remove' }); expect(removed.status).toBe(200); expect(await removed.json()).toMatchObject({ fields: { enabled: false }, state: { tokenSaved: false } }); expect(f.fake.runs).toHaveLength(0);
});

test('mirror editor connect delegates default URL selection through the normal owned OAuth boundary', async () => {
  f = await projectFixture(); const base = f.app.ekoa!.state(), request = vi.spyOn(f.app, 'ekoaRequest').mockResolvedValue({ ...base, oauth: { schema: 'ekoa-oauth-status-v1', connected: false, connecting: true, authorizationUrl: 'https://provider.example/authorize' } });
  const response = await f.request('/hub/ekoa/editor/connect', 'POST', { schema: 'ekoa-editor-connect-v1', url: '', clientRequestId: 'mirror_editor_connect' }); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ connect: { authorizationUrl: 'https://provider.example/authorize' } });
  expect(request.mock.calls[0]?.[0]).toMatchObject({ operation: 'oauth-start', input: { schema: 'ekoa-oauth-start-v1', url: 'https://mcp.ekoa.io/mcp', clientRequestId: 'mirror_editor_connect' } }); expect(f.fake.runs).toHaveLength(0);
});

test('member mirror editor retains the normal owner session and original device at the canonical writer', async () => {
  f = await projectFixture(); const member = await projectMember(f), save = vi.spyOn(f.app.ekoa!, 'save');
  const initial = await member.request('/hub/ekoa/editor'); expect(initial.status).toBe(200); const view = await initial.json();
  const response = await member.request('/hub/ekoa/editor', 'PUT', { schema: 'ekoa-editor-save-v1', revision: view.state.settings.revision, fields: view.fields, operation: 'save', clientRequestId: 'mirror_member_save' });
  expect(response.status).toBe(200); expect(save.mock.calls).toHaveLength(1); expect(save.mock.calls[0]?.[1]).toBe(member.deviceId); expect(f.app.ekoa!.settings()).toMatchObject({ revision: 1, enabled: false }); expect(member.fake.runs).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
});
