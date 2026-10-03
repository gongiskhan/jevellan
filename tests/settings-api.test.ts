import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Homes, ConfigRevisionSchema, exportConfiguration, RiggingViewSchema, RiggingDiskListSchema, RiggingDiskDetailSchema, RiggingSaveSchema } from '../packages/core/dist/index.js';
import { AccountViewSchema, LoginViewSchema } from '../packages/accounts/dist/index.js';
import { createRuntime as createClaude } from '../runtimes/claude/dist/index.js';
import { createRuntime as createCodex } from '../runtimes/codex/dist/index.js';
import { Application, createDaemon, RiggingApplicationSchema } from '../apps/daemon/dist/index.js';
import { z } from 'zod';
import { HubUnavailable } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let app: Application; let server: Server; let base: string; let cookie: string;
const empty = { schema: 'empty-request-v1' };
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-settings-api-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'user', '.jevellan'), join(root, 'user'));
  app = new Application({ homes, timers: false, runtimes: (context) => {
    const claude = createClaude(context); const codex = createCodex(context);
    claude.probe = vi.fn(async () => ({ auth: 'ready' as const, identity: { email: 'fixture@example.test' } }));
    claude.listModels = vi.fn(async () => [{ id: 'claude-fable-5-1', label: 'Fable', efforts: ['low' as const, 'high' as const] }]);
    claude.beginLogin = async (account) => {
      let state: 'pending' | 'done' | 'failed' = 'pending';
      return { instructions: 'Paste the code.', url: 'https://claude.ai/oauth/authorize', poll: async () => state,
        submitCode: async () => { await context.saveSecret!(account.id, `fixture-${randomUUID()}`); state = 'done'; }, cancel: async () => { state = 'failed'; } };
    };
    return new Map([['claude', claude], ['codex', codex]]);
  } });
  server = createDaemon({ application: app });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` }) });
  expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true }); });
function request(path: string, method = 'GET', value?: unknown) {
  return fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: base, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}

test('UI admission exposes only typed and safely repeatable hub failures', async () => {
  const outage = new HubUnavailable('Fixture hub');
  const auth = vi.spyOn(app.auth, 'verify').mockRejectedValueOnce(outage);
  const add = vi.spyOn(app.accounts, 'add').mockRejectedValue(outage);
  const blocked = await request('/hub/accounts', 'POST', empty);
  expect(blocked.status).toBe(503); expect(await blocked.json()).toMatchObject({ code: 'hub-unavailable', message: outage.message, retryable: true }); expect(add).not.toHaveBeenCalled();
  auth.mockRestore();
  const input = { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'Admission fixture' };
  const admitted = await request('/hub/accounts', 'POST', input);
  expect(admitted.status).toBe(503); expect(await admitted.json()).toMatchObject({ code: 'hub-unavailable', retryable: false }); expect(add).toHaveBeenCalledTimes(1);
  add.mockRejectedValueOnce(Object.assign(new Error('Ordinary unavailable response'), { status: 503 }));
  expect(await (await request('/hub/accounts', 'POST', input)).json()).toEqual({ schema: 'error-v1', code: 'request-failed', message: 'Ordinary unavailable response' });
});

test('Git settings require UI authentication, enforce revisions and reject arbitrary checks', async () => {
  expect((await fetch(`${base}/api/git/settings`)).status).toBe(401);
  expect((await fetch(`${base}/api/git/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'git-check-request-v1', projectId: 'unknown' }) })).status).toBe(401);
  const initial = await (await request('/api/git/settings')).json();
  expect(initial).toMatchObject({ schema: 'git-settings-v1', githubTransport: 'machine', revision: 0 });
  const updated = await request('/api/git/settings', 'PUT', { ...initial, githubTransport: 'ssh' });
  expect(updated.status).toBe(200); expect(await updated.json()).toMatchObject({ githubTransport: 'ssh', revision: 1 });
  expect((await request('/api/git/settings', 'PUT', initial)).status).toBe(409);
  expect((await request('/api/git/check', 'POST', { schema: 'git-check-request-v1', projectId: 'unknown' })).status).toBe(404);
  expect((await request('/api/git/settings', 'PUT', { ...initial, githubTransport: 'ssh', token: 'unexpected' })).status).toBe(400);
});

test('UI configuration retry recovers a saved revision after post-save hub loss', async () => {
  const current = ConfigRevisionSchema.parse(await (await request('/hub/config')).json());
  const input = { schema: 'config-write-v1', revision: current.revision, configuration: current.configuration, clientRequestId: 'save_lost' };
  vi.spyOn(app, 'applyRigging').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  const interrupted = await request('/hub/config', 'PUT', input);
  expect(interrupted.status).toBe(503); expect(await interrupted.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const saved = app.hub.configuration.current()!; expect(saved.revision).toBe(current.revision + 1);
  const newer = structuredClone(saved.configuration); newer['x-jevellan'].guards.pauseAfterPlan = false;
  app.hub.configuration.put(newer, saved.revision, { deviceId: 'other', source: 'ui' });
  const recovered = await request('/hub/config', 'PUT', input); expect(recovered.status).toBe(200); expect(await recovered.json()).toEqual(saved);
  expect(app.hub.configuration.current()?.configuration).toEqual(newer);
  expect((await request('/hub/config', 'PUT', { ...input, clientRequestId: undefined })).status).toBe(409);
});

test('Jev key save recovers a committed result, while device issuance and local file admission can wait', async () => {
  const outage = new HubUnavailable('Fixture hub'); const secret = `fixture-${randomUUID()}`;
  const put = app.state.jev.put.bind(app.state.jev);
  vi.spyOn(app.state.jev, 'put').mockImplementationOnce(async (...args) => { await put(...args); throw outage; });
  const input = { schema: 'save-secret-v1', clientRequestId: 'jev_save_lost', value: secret };
  const lost = await request('/hub/secrets/jev', 'PUT', input); expect(lost.status).toBe(503); expect(await lost.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  expect((await request('/hub/secrets/jev', 'PUT', input)).status).toBe(200); expect(await app.state.jev.credential()).toBe(secret);
  vi.spyOn(app, 'inviteDevice').mockRejectedValueOnce(outage);
  expect(await (await request('/hub/devices/invitations', 'POST', empty)).json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  vi.spyOn(app, 'switchDevice').mockRejectedValueOnce(outage);
  expect(await (await request('/api/devices/switch', 'POST', { schema: 'device-switch-input-v1', targetDeviceId: 'fixture', route: '/' })).json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  vi.spyOn(app, 'consumeSwitch').mockRejectedValueOnce(outage);
  expect(await (await request(`/switch?token=${'x'.repeat(43)}`)).json()).toMatchObject({ code: 'hub-unavailable', retryable: false });
  const edit = vi.spyOn(app.riggingDisk, 'edit'); vi.spyOn(app.accounts, 'list').mockRejectedValueOnce(outage);
  expect(await (await request('/api/rigging/homes/claude/fixture/item', 'PUT', { schema: 'rigging-disk-write-v1', fingerprint: 'fixture', content: 'Later' })).json()).toMatchObject({ code: 'hub-unavailable', retryable: true }); expect(edit).not.toHaveBeenCalled();
});

test('passphrase sign-in waits on typed hub loss without classifying a failed credential as retryable', async () => {
  const login = vi.spyOn(app.auth, 'login').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  const input = { schema: 'passphrase-input-v1', passphrase: 'fixture-passphrase' };
  const unavailable = await request('/api/auth/login', 'POST', input); expect(unavailable.status).toBe(503); expect(await unavailable.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  login.mockRestore(); const rejected = await request('/api/auth/login', 'POST', input); expect(rejected.status).toBe(401); expect(await rejected.json()).not.toHaveProperty('retryable');
});

test('provider login code retries recover readiness without exchanging the accepted code again', async () => {
  const account = AccountViewSchema.parse(await (await request('/hub/accounts', 'POST', { schema: 'add-account-v1', runtime: 'claude', label: 'Recovering login', kind: 'subscription' })).json());
  const input = { schema: 'login-start-v1', clientRequestId: 'login_recovery' };
  const login = LoginViewSchema.parse(await (await request(`/api/accounts/${account.account.id}/login`, 'POST', input)).json());
  const capture = vi.spyOn(app.accounts, 'captureSecret'); vi.spyOn(app.accounts, 'check').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  const code = { schema: 'login-code-v1', code: 'fixture-code' };
  const interrupted = await request(`/api/logins/${login.id}`, 'POST', code); expect(interrupted.status).toBe(503); expect(await interrupted.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const completed = LoginViewSchema.parse(await (await request(`/api/logins/${login.id}`, 'POST', code)).json()); expect(completed.state).toBe('done'); expect(capture).toHaveBeenCalledOnce();
  const replay = LoginViewSchema.parse(await (await request(`/api/accounts/${account.account.id}/login`, 'POST', input)).json()); expect(replay).toMatchObject({ id: login.id, state: 'done' });
  expect((await request(`/api/logins/${login.id}`, 'POST', { ...code, code: 'other-code' })).status).toBe(409); expect(capture).toHaveBeenCalledOnce();
});

test('provider login polling exposes a repeatable hub wait and cancellation ends it', async () => {
  const account = AccountViewSchema.parse(await (await request('/hub/accounts', 'POST', { schema: 'add-account-v1', runtime: 'claude', label: 'Waiting login', kind: 'subscription' })).json());
  const login = LoginViewSchema.parse(await (await request(`/api/accounts/${account.account.id}/login`, 'POST', { schema: 'login-start-v1', clientRequestId: 'login_wait' })).json());
  vi.spyOn(app.accounts, 'check').mockRejectedValue(new HubUnavailable('Fixture hub'));
  expect((await request(`/api/logins/${login.id}`, 'POST', { schema: 'login-code-v1', code: 'fixture-code' })).status).toBe(503);
  const waiting = await request(`/api/logins/${login.id}`); expect(waiting.status).toBe(503); expect(await waiting.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const cancelled = LoginViewSchema.parse(await (await request(`/api/logins/${login.id}`, 'DELETE', empty)).json()); expect(cancelled.state).toBe('cancelled');
});

test('settings require a signed cookie, reject foreign origins and revoke logout sessions', async () => {
  expect((await fetch(`${base}/hub/accounts`)).status).toBe(401);
  expect((await fetch(`${base}/hub/accounts`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify(empty) })).status).toBe(403);
  expect((await request('/hub/accounts')).status).toBe(200);
  const logout = await request('/api/auth/logout', 'POST', empty); expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await request('/hub/accounts')).status).toBe(401);
});

test('API keys reach Ready through a probe and never return in HTTP account data', async () => {
  const secret = `fixture-${randomUUID()}`;
  const response = await request('/hub/accounts', 'POST', { schema: 'add-account-v1', runtime: 'claude', label: 'Fixture', kind: 'api-key', secret, paidUse: 'always' });
  expect(response.status).toBe(201); const raw = await response.text(); expect(raw).not.toContain(secret);
  const view = AccountViewSchema.parse(JSON.parse(raw)); expect(view.statuses[0]?.auth).toBe('ready'); expect(view.secret?.lastFour).toBe(secret.slice(-4));
  const edit = await request(`/hub/accounts/${view.account.id}`, 'PATCH', { schema: 'update-account-v1', revision: view.revision, label: 'Edited', enabled: false, ceilingPct: 80, paidUse: 'never' }); expect(edit.status).toBe(200);
  expect(app.hub.vault.forLaunch(view.account.secretRef!)).toBe(secret);
  const list = await request('/hub/accounts'); expect(await list.text()).not.toContain(secret);
  expect(JSON.stringify(app.hub.db.prepare('SELECT document FROM documents').all())).not.toContain(secret);
});

test('UI-driven subscription login finishes with a ready per-device status', async () => {
  const created = AccountViewSchema.parse(await (await request('/hub/accounts', 'POST', { schema: 'add-account-v1', runtime: 'claude', label: 'Login', kind: 'subscription' })).json());
  const login = LoginViewSchema.parse(await (await request(`/api/accounts/${created.account.id}/login`, 'POST', empty)).json()); expect(login.state).toBe('pending');
  const finished = LoginViewSchema.parse(await (await request(`/api/logins/${login.id}`, 'POST', { schema: 'login-code-v1', code: 'fixture-code' })).json()); expect(finished.state).toBe('done');
  const account = AccountViewSchema.parse(await (await request(`/hub/accounts/${created.account.id}`)).json()); expect(account.statuses[0]?.auth).toBe('ready'); expect(account.account.identity?.email).toBe('fixture@example.test');
});

test('configuration import previews a diff, applies with CAS and records the authenticated device', async () => {
  const current = ConfigRevisionSchema.parse(await (await request('/hub/config')).json()); const proposed = structuredClone(current.configuration); proposed['x-jevellan'].guards.pauseAfterPlan = false;
  const preview = await request('/hub/config/import-preview', 'POST', { schema: 'config-import-v1', yaml: exportConfiguration(proposed) });
  expect(preview.status).toBe(200); const diff = await preview.json() as { revision: number; changedPaths: string[] }; expect(diff.changedPaths).toContain('/x-jevellan/guards/pauseAfterPlan'); expect(app.hub.configuration.current()?.revision).toBe(current.revision);
  const input = { schema: 'config-write-v1', revision: diff.revision, configuration: proposed };
  const saved = await request('/hub/config', 'PUT', input); expect(saved.status).toBe(200); expect(ConfigRevisionSchema.parse(await saved.json()).changedBy.deviceId).toBe(app.device.deviceId);
  const stale = await request('/hub/config', 'PUT', input); expect(stale.status).toBe(409); expect(await stale.text()).toContain('Settings changed elsewhere. Reloaded the latest version.');
  expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('pauseAfterPlan: false');
  const exported = await request('/hub/config/export'); expect(exported.headers.get('content-disposition')).toContain('apm.yml'); expect(await exported.text()).toContain('pauseAfterPlan: false');
});

test('a local skill submitted over HTTP is installed by APM into the account home and parks when disabled', async () => {
  const native = join(homes.userHome, '.claude'); mkdirSync(native); writeFileSync(join(native, 'sentinel'), 'unchanged');
  const account = AccountViewSchema.parse(await (await request('/hub/accounts', 'POST', { schema: 'add-account-v1', runtime: 'claude', label: 'Rigging', kind: 'subscription' })).json());
  const response = await request('/hub/rigging', 'POST', { schema: 'add-rigging-v1', name: 'Fixture skill', kind: 'skill', runtimes: { claude: true, codex: false }, content: 'Read the fixture carefully.' }); expect(response.status).toBe(201);
  const SaveSchema = z.strictObject({ schema: z.literal('rigging-save-v1'), item: RiggingViewSchema, application: RiggingApplicationSchema }); const saved = SaveSchema.parse(await response.json()); expect(saved.application.accounts[0]?.results[0]?.applied).toBe(true); expect(saved.application.accounts[0]?.error).toBeUndefined();
  const file = join(homes.account('claude', account.account.id), 'skills', saved.item.item.id.replaceAll('_', '-').toLowerCase(), 'SKILL.md'); expect(readFileSync(file, 'utf8')).toContain('Read the fixture carefully.');
  const parked = await request(`/hub/rigging/${saved.item.item.id}`, 'PUT', { schema: 'update-rigging-v1', revision: saved.item.revision, name: saved.item.item.name, content: saved.item.item.content, runtimes: { claude: false, codex: false }, state: 'parked' }); expect(parked.status).toBe(200); expect(existsSync(file)).toBe(false);
  expect(readdirSync(native)).toEqual(['sentinel']); expect(readFileSync(join(native, 'sentinel'), 'utf8')).toBe('unchanged');
}, 120_000);

test('Safety cannot be disabled and package-managed content cannot be edited', async () => {
  const safety = (await app.rigging.get('builtin_safety'));
  const denied = await request('/hub/rigging/builtin_safety', 'PUT', { schema: 'update-rigging-v1', revision: safety.revision, name: 'Safety', content: safety.item.content, runtimes: { claude: false }, state: 'parked' }); expect(denied.status).toBe(400);
  const pkg = (await app.rigging.add({ schema: 'add-rigging-v1', name: 'Package', kind: 'skill', runtimes: { claude: true }, content: '', packageRef: 'fixture/skills' }));
  const response = await request(`/hub/rigging/${pkg.item.id}`, 'PUT', { schema: 'update-rigging-v1', revision: pkg.revision, name: 'Package', content: 'Local change', runtimes: { claude: true }, state: 'owned' }); expect(response.status).toBe(400); expect(await response.text()).toContain('read-only');
});

test('account-local Rigging HTTP requires authentication, protects account boundaries and supports stale-safe edit/park/restore', async () => {
  const account = (await app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Disk fixture', kind: 'subscription' })).account;
  const home = homes.account('claude', account.id); mkdirSync(join(home, 'skills/local'), { recursive: true }); writeFileSync(join(home, 'skills/local/SKILL.md'), '# Original');
  expect((await fetch(`${base}/api/rigging/homes`)).status).toBe(401);
  const inventory = RiggingDiskListSchema.parse(await (await request('/api/rigging/homes')).json()); const item = inventory.items[0]!; const path = `/api/rigging/homes/claude/${account.id}/${item.id}`;
  expect((await request(`/api/rigging/homes/codex/${account.id}/${item.id}`)).status).toBe(404);
  expect((await request(`/api/rigging/homes/claude/missing/${item.id}`)).status).toBe(404);
  const input = { schema: 'rigging-disk-write-v1', fingerprint: item.fingerprint, content: '# Edited' };
  const edited = await request(path, 'PUT', input); expect(edited.status).toBe(200); const current = RiggingDiskDetailSchema.parse(await edited.json()); expect(current.content).toBe('# Edited');
  expect((await request(path, 'PUT', { ...input, content: 'Stale' })).status).toBe(409);
  const parked = { schema: 'rigging-disk-transition-v1', requestId: 'http_park', fingerprint: current.item.fingerprint, action: 'park' };
  expect((await request(path, 'POST', parked)).status).toBe(200); expect((await request(path, 'POST', parked)).status).toBe(200); expect(existsSync(join(home, 'skills/local'))).toBe(false);
  const archive = RiggingDiskListSchema.parse(await (await request('/api/rigging/homes')).json()).items[0]!; expect(archive.state).toBe('parked');
  const restored = await request(`/api/rigging/homes/claude/${account.id}/${archive.id}`, 'POST', { ...parked, requestId: 'http_restore', fingerprint: archive.fingerprint, action: 'restore' }); expect(restored.status).toBe(200);
  expect(readFileSync(join(home, 'skills/local/SKILL.md'), 'utf8')).toBe('# Edited');
});

test('Project memory starts enabled and supports persistent per-runtime toggles with immutable content', async () => {
  const initial = (await app.rigging.get('builtin_project_memory')); expect(initial.item.runtimes).toEqual({ claude: true, codex: true });
  const input = { schema: 'update-rigging-v1', revision: initial.revision, name: initial.item.name, content: initial.item.content, state: 'owned', runtimes: { claude: false, codex: true } };
  expect((await request('/hub/rigging/builtin_project_memory', 'PUT', { ...input, content: '{}' })).status).toBe(400);
  expect((await request('/hub/rigging/builtin_project_memory', 'PUT', input)).status).toBe(200);
  expect((await app.rigging.get('builtin_project_memory')).item.runtimes).toEqual({ claude: false, codex: true });
  expect((await app.rigging.items('claude')).find((item) => item.id === initial.item.id)?.enabled).toBe(false);
  expect((await app.rigging.items('codex')).find((item) => item.id === initial.item.id)?.enabled).toBe(true);
  expect((await request('/hub/rigging/builtin_project_memory', 'PUT', input)).status).toBe(409);
});

test('authenticated promotion delivers the captured bundle and exposes metadata without asset payloads', async () => {
  const account = (await app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Promotion fixture', kind: 'subscription' })).account;
  const home = homes.account('claude', account.id); mkdirSync(join(home, 'skills/captured/assets'), { recursive: true });
  writeFileSync(join(home, 'skills/captured/SKILL.md'), '# Captured skill\n'); writeFileSync(join(home, 'skills/captured/assets/example.txt'), 'Private bundled fixture contents.');
  const item = app.riggingDisk.list([account]).items.find((item) => item.name === 'captured')!;
  const path = `/api/rigging/homes/claude/${account.id}/${item.id}/promote`; const input = { schema: 'rigging-promotion-input-v1', requestId: 'http_promote', fingerprint: item.fingerprint, name: 'Captured skill', runtimes: { claude: true } };
  expect((await fetch(`${base}${path}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(401);
  expect((await request(path.replace('/claude/', '/codex/'), 'POST', input)).status).toBe(404);
  expect((await request(path.replace(account.id, 'missing_account'), 'POST', input)).status).toBe(404);
  expect((await request(path, 'POST', { ...input, fingerprint: '0'.repeat(64) })).status).toBe(409);
  const response = await request(path, 'POST', input); expect(response.status).toBe(200); const raw = await response.text(); const result = RiggingSaveSchema.parse(JSON.parse(raw));
  expect(result.item.item.bundle?.fileCount).toBe(1); expect(result.application.accounts.every((entry) => !entry.error)).toBe(true); expect(raw).not.toMatch(/base64|Private bundled/);
  expect(readFileSync(join(home, 'skills/captured/assets/example.txt'), 'utf8')).toBe('Private bundled fixture contents.');
  const repeated = RiggingSaveSchema.parse(await (await request(path, 'POST', input)).json()); expect(repeated.item).toEqual(result.item);
  expect(await (await request('/hub/rigging')).text()).not.toMatch(/base64|Private bundled/);
  expect((await request(path, 'PATCH', { schema: 'rigging-disk-cancel-v1', requestId: input.requestId })).status).toBe(409);
});

test('Jev secret fields expose Saved and the suffix without a readback route', async () => {
  const secret = `fixture-${randomUUID()}`; const response = await request('/hub/secrets/jev', 'PUT', { schema: 'save-secret-v1', value: secret }); expect(response.status).toBe(200); expect(await response.text()).not.toContain(secret);
  const saved = await request('/hub/secrets/jev'); expect(await saved.text()).toContain(secret.slice(-4));
  expect((await request('/hub/secrets/jev/value')).status).toBe(404);
});

test('account and Rigging UI saves permit receipt-backed recovery after post-save hub loss', async () => {
  const input = { schema: 'add-account-v1', runtime: 'claude', kind: 'subscription', label: 'Recoverable account', secret: `fixture-${randomUUID()}`, clientRequestId: 'account_ui_lost' };
  vi.spyOn(app, 'applyRigging').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  const first = await request('/hub/accounts', 'POST', input); expect(first.status).toBe(503); expect(await first.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const recovered = await request('/hub/accounts', 'POST', input); expect(recovered.status).toBe(201); const account = AccountViewSchema.parse(await recovered.json()); expect((await app.accounts.list()).filter(row => row.account.label === input.label)).toHaveLength(1);
  const key = { schema: 'replace-credential-v1', revision: account.revision, secret: `fixture-${randomUUID()}`, clientRequestId: 'key_ui_lost' };
  vi.spyOn(app.accounts, 'check').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  const replacing = await request(`/hub/accounts/${account.account.id}/credential`, 'PUT', key); expect(replacing.status).toBe(503); expect(await replacing.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const captured = (await app.accounts.get(account.account.id)).account.secretRef;
  expect((await request(`/hub/accounts/${account.account.id}/credential`, 'PUT', key)).status).toBe(200); expect((await app.accounts.get(account.account.id)).account.secretRef).toBe(captured);
  const rigging = { schema: 'add-rigging-v1', kind: 'skill', name: 'Recoverable item', runtimes: { claude: true }, content: 'Keep project scope.', clientRequestId: 'rigging_ui_lost' };
  vi.mocked(app.applyRigging).mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  const interrupted = await request('/hub/rigging', 'POST', rigging); expect(interrupted.status).toBe(503); expect(await interrupted.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  expect((await request('/hub/rigging', 'POST', rigging)).status).toBe(201); expect((await app.rigging.list()).filter(row => row.item.name === rigging.name)).toHaveLength(1);
});
