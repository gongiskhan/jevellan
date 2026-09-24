import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Homes, ConfigRevisionSchema, exportConfiguration, RiggingViewSchema } from '../packages/core/dist/index.js';
import { AccountViewSchema, LoginViewSchema } from '../packages/accounts/dist/index.js';
import { createRuntime as createClaude } from '../runtimes/claude/dist/index.js';
import { createRuntime as createCodex } from '../runtimes/codex/dist/index.js';
import { Application, createDaemon, RiggingApplicationSchema } from '../apps/daemon/dist/index.js';
import { z } from 'zod';

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
  const current = ConfigRevisionSchema.parse(await (await request('/hub/config')).json()); const proposed = structuredClone(current.configuration); proposed['x-jevellan'].guards.pauseAfterPlan = true;
  const preview = await request('/hub/config/import-preview', 'POST', { schema: 'config-import-v1', yaml: exportConfiguration(proposed) });
  expect(preview.status).toBe(200); const diff = await preview.json() as { revision: number; changedPaths: string[] }; expect(diff.changedPaths).toContain('/x-jevellan/guards/pauseAfterPlan'); expect(app.hub.configuration.current()?.revision).toBe(current.revision);
  const input = { schema: 'config-write-v1', revision: diff.revision, configuration: proposed };
  const saved = await request('/hub/config', 'PUT', input); expect(saved.status).toBe(200); expect(ConfigRevisionSchema.parse(await saved.json()).changedBy.deviceId).toBe(app.device.deviceId);
  const stale = await request('/hub/config', 'PUT', input); expect(stale.status).toBe(409); expect(await stale.text()).toContain('Settings changed elsewhere. Reloaded the latest version.');
  expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('pauseAfterPlan: true');
  const exported = await request('/hub/config/export'); expect(exported.headers.get('content-disposition')).toContain('apm.yml'); expect(await exported.text()).toContain('pauseAfterPlan: true');
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
  const safety = app.rigging.get('builtin_safety');
  const denied = await request('/hub/rigging/builtin_safety', 'PUT', { schema: 'update-rigging-v1', revision: safety.revision, name: 'Safety', content: safety.item.content, runtimes: { claude: false }, state: 'parked' }); expect(denied.status).toBe(400);
  const pkg = app.rigging.add({ schema: 'add-rigging-v1', name: 'Package', kind: 'skill', runtimes: { claude: true }, content: '', packageRef: 'fixture/skills' });
  const response = await request(`/hub/rigging/${pkg.item.id}`, 'PUT', { schema: 'update-rigging-v1', revision: pkg.revision, name: 'Package', content: 'Local change', runtimes: { claude: true }, state: 'owned' }); expect(response.status).toBe(400); expect(await response.text()).toContain('read-only');
});

test('Jev secret fields expose Saved and the suffix without a readback route', async () => {
  const secret = `fixture-${randomUUID()}`; const response = await request('/hub/secrets/jev', 'PUT', { schema: 'save-secret-v1', value: secret }); expect(response.status).toBe(200); expect(await response.text()).not.toContain(secret);
  const saved = await request('/hub/secrets/jev'); expect(await saved.text()).toContain(secret.slice(-4));
  expect((await request('/hub/secrets/jev/value')).status).toBe(404);
});
