import { afterEach, expect, test } from 'vitest';
import { join } from 'node:path';
import { OwnerLogins } from '../apps/daemon/dist/owner-logins.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { ATTACH_MENU, named } from './helpers/attach-cli.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const text = async (name: string, args: Record<string, unknown>, caller = 'bridge:project') => { const result = await f!.app.ownerTools.call(name, { schema: 'owner-tool-request-v1', caller, args }); return result.ok ? result.text : `ERROR ${result.error.code}: ${result.error.text}`; };

test('accounts are added, budgeted and disabled through config; secrets list names without values', async () => {
  f = await projectFixture({ menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude: named('claude') } });
  expect(await text('config', { action: 'add_account', label: 'second', runtime: 'claude', budgetPercent: 80 })).toBe('Added account second (claude). Log it in with login start second, and with interactive for remote control.');
  expect(await text('config', { action: 'add_account', label: 'second', runtime: 'claude' })).toBe('ERROR exists: There is already an account second.');
  expect(await text('config', { action: 'set', section: 'accounts', key: 'second.budgetPercent', value: 70 })).toBe('Changed accounts.second.budgetPercent from 80 to 70. New work stops using second at 70% of its limits.');
  expect(await text('config', { action: 'get', section: 'accounts' })).toContain('second budget 70%');
  expect(await text('login', { action: 'status', account: 'second' })).toMatch(/^second: (logged in|needs login \(.+\)), no interactive login for remote control$/u);
  expect(await text('config', { action: 'remove_account', label: 'second' })).toBe('Disabled account second. Accounts are never deleted, so its history stays; turn it back on with config set accounts second.enabled true.');
  expect(await text('config', { action: 'secrets' })).toBe('Environment: 0 set, 0 not set.');
  expect(await text('config', { action: 'set_secret', name: 'DEPLOY_TOKEN', value: 'fixture-secret-value' })).toBe("Saved DEPLOY_TOKEN. Its value is now in this conversation's transcript; the terminal prompt (jevellan secret set DEPLOY_TOKEN) keeps it out.");
  expect(await text('config', { action: 'set_secret', name: 'OTHER_TOKEN', value: 'x' }, 'cli')).toBe('Saved OTHER_TOKEN.');
  const secrets = await text('config', { action: 'secrets' });
  expect(secrets).toBe('Environment: 2 set, 0 not set.'); expect(secrets).not.toContain('fixture-secret-value');
});

test('owner secret commands select check scope explicitly and never fall back to a work secret', async () => {
  f = await projectFixture();
  expect(await text('config', { action: 'set_secret', name: 'SHARED_NAME', value: 'synthetic-work-only-value' }, 'cli')).toBe('Saved SHARED_NAME.');
  expect(await text('config', { action: 'set_secret', purpose: 'check', name: 'SHARED_NAME', value: 'synthetic-check-only-value' }, 'cli')).toContain('Configure a separate check environment');
  expect((await f.app.state.environment.summary('project', 'SHARED_NAME', 'check')).saved).toBe(false);
  const base = (await f.app.projectWork.settingsView('project')).settings;
  await f.app.projectHub.putSettings({ ...base, checkEnvironment: { schema: 'project-check-environment-v1', variables: [], secrets: [], copyFiles: [] } }, base.revision);
  expect(await text('config', { action: 'set_secret', purpose: 'check', name: 'SHARED_NAME', value: 'synthetic-check-only-value' }, 'cli')).toBe('Saved SHARED_NAME.');
  expect(await text('config', { action: 'secrets', purpose: 'check' })).toBe('Environment: 1 set, 0 not set.');
  const view = await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', args: { action: 'environment_editor', purpose: 'check' } });
  expect(view.ok && view.data).toMatchObject({ purpose: 'check', fields: { enabled: true, secrets: ['SHARED_NAME'], variables: [] } });
  expect(await text('config', { action: 'remove_secret', purpose: 'check', name: 'SHARED_NAME' })).toBe('Removed SHARED_NAME.');
  expect((await f.app.state.environment.summary('project', 'SHARED_NAME', 'check')).saved).toBe(false);
  expect((await f.app.state.environment.summary('project', 'SHARED_NAME')).saved).toBe(true);
  expect((await f.app.state.environment.credentials('project')).SHARED_NAME === 'synthetic-work-only-value').toBe(true);
});

test('an interactive login captures the link, completes with the code and pushes login_done', async () => {
  f = await projectFixture({ menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude: named('claude') } });
  await text('config', { action: 'add_account', label: 'bridge', runtime: 'claude' });
  const logins = new OwnerLogins(f.app, join(import.meta.dirname, 'fixtures', 'claude-auth-login.mjs'));
  Object.defineProperty(f.app, 'ownerLogins', { value: logins });
  expect(await text('login', { action: 'start', account: 'bridge', interactive: true })).toBe('Open this link and approve access for account bridge: https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture Then tell me the code it shows.');
  expect(await text('login', { action: 'complete', account: 'bridge', code: 'good' })).toBe('Account bridge is logged in.');
  expect(await text('login', { action: 'status', account: 'bridge' })).toMatch(/remote control ready$/u);
  expect(f.app.ownerPushes.describe('project').join('\n')).toContain('login_done Account bridge is logged in.');
  expect(await text('login', { action: 'complete', account: 'bridge', code: 'good' })).toBe('ERROR not_pending: There is no login waiting for bridge. Start one with login start.');
});
