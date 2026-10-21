import { expect, test } from './fixtures.js';
import { CursorListSchema } from '../../packages/core/dist/client.js';

test('SESSIONS1 canonical preferences preserve rename, order, stale responses and reconnects', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const device = 'fixture_device', first = `claude_${'a'.repeat(32)}`, second = `claude_${'b'.repeat(32)}`;
  const key = (id: string) => `${device}:${device}:${id}`;
  const list = CursorListSchema.parse({ schema: 'cursor-list-v1', observedAt: new Date().toISOString(), sessions: [
    { schema: 'cursor-session-v1', id: first, runtime: 'claude', ownerDeviceId: device, deviceName: 'Fixture device', title: 'Native Alpha', cwd: '/fixture/project', project: 'Fixture project', state: 'idle', lastActivityAt: new Date().toISOString(), connected: true, canSteer: false, canSend: false },
    { schema: 'cursor-session-v1', id: second, runtime: 'claude', ownerDeviceId: device, deviceName: 'Fixture device', title: 'Native Beta', cwd: '/fixture/project', project: 'Fixture project', state: 'idle', lastActivityAt: new Date().toISOString(), connected: true, canSteer: false, canSend: false },
  ], excludedSessionIds: [], unavailable: [] });
  // Only native provider input is simulated; preference reads/writes use the normal fixture daemon.
  await page.context().route('**/api/cursor', route => route.fulfill({ json: list }));
  await page.goto('/settings/runtimes'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible(); await page.goto('/new');
  const alpha = page.locator(`[data-session-id="${key(first)}"]`), beta = page.locator(`[data-session-id="${key(second)}"]`);
  await expect(alpha).toBeVisible(); await expect(beta).toBeVisible();
  const initial = await (await page.request.get('/api/session-list/view')).json(); expect(initial.preferences.revision).toBe(0);
  await alpha.getByRole('button', { name: 'Actions for Native Alpha', exact: true }).click(); await alpha.getByRole('button', { name: 'Rename', exact: true }).click();
  const modal = page.getByRole('dialog').last(); await modal.getByLabel('Name', { exact: true }).fill(' Renamed Alpha '); await modal.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(modal).not.toBeVisible(); await expect(alpha.locator('strong')).toHaveText('Renamed Alpha');
  const renamed = await (await page.request.get('/api/session-list/view')).json(); expect(renamed.preferences).toMatchObject({ revision: 1, titles: { [key(first)]: 'Renamed Alpha' } });
  const ordered = await page.request.post('/api/session-list/view', { data: { schema: 'session-list-update-v1', revision: 1, operation: 'order', order: [key(second), key(first), key(second)] } }); expect(ordered.status()).toBe(200); expect((await ordered.json()).preferences.order).toEqual([key(second), key(first)]);
  await page.evaluate(() => window.dispatchEvent(new Event('jevellan-session-list-updated')));
  const natives = page.locator(`[data-session-id^="${device}:${device}:"]`); await expect(natives.first()).toHaveAttribute('data-session-id', key(second));
  await page.getByRole('button', { name: 'Sort by activity', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sort by activity', exact: true })).toHaveCount(0);
  const saved = await (await page.request.get('/api/session-list/view')).json(); expect(saved.preferences).toMatchObject({ revision: 3, order: [], titles: { [key(first)]: 'Renamed Alpha' } });
  await page.context().route('**/api/session-list/view', route => route.fulfill({ json: initial }));
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session-list/view');
  await page.evaluate(() => window.dispatchEvent(new Event('jevellan-session-list-updated'))); await (await staleResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await expect(alpha.locator('strong')).toHaveText('Renamed Alpha');
  await page.context().unroute('**/api/session-list/view'); await page.context().route('**/api/session-list/view', route => route.abort('failed'));
  const failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/session-list/view'); await page.evaluate(() => window.dispatchEvent(new Event('jevellan-session-list-updated'))); await failed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await expect(alpha.locator('strong')).toHaveText('Renamed Alpha');
  await page.context().unroute('**/api/session-list/view');
  expect((await page.request.post('/api/session-list/view', { data: { schema: 'session-list-update-v1', revision: 0, operation: 'order', order: [] } })).status()).toBe(409);
  expect(await (await page.request.get('/api/session-list/view')).json()).toEqual(saved); await page.reload(); await expect(alpha.locator('strong')).toHaveText('Renamed Alpha');
  expect(errors).toEqual([]); await page.screenshot({ path: info.outputPath('session-list-preferences.png') });
});
