import { expect, test } from './fixtures.js';
import { DeviceRosterSchema } from '../../packages/core/dist/client.js';

// B5: a member whose version differs from its hub's says so, with the command that fixes it. The fixture server is a hub, so the
// roster it returns is rewritten into a member's view: this device on 0.3.2, its hub on 0.3.4.
test('a member on another version than its hub shows the update banner, and a hub shows none', async ({ page }, info) => {
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  await expect(page.locator('.version-banner')).toHaveCount(0);
  await page.route('**/hub/devices/roster', async route => {
    const response = await route.fetch(); const roster = DeviceRosterSchema.parse(await response.json());
    const self = roster.devices.find(row => row.device.id === roster.currentDeviceId)!;
    const hub = { ...self, device: { ...self.device, id: 'dev_fixturehub', name: 'Fixture hub', role: 'hub' as const, version: '0.3.4' } };
    const member = { ...self, device: { ...self.device, role: 'member' as const, version: '0.3.2' } };
    await route.fulfill({ response, json: { ...roster, devices: [hub, member, ...roster.devices.filter(row => row.device.id !== roster.currentDeviceId)] } });
  });
  await page.reload();
  const banner = page.locator('.version-banner');
  await expect(banner).toHaveText('This device runs 0.3.2. The hub runs 0.3.4. Update this device with jevellan update.');
  await expect(banner.locator('code')).toHaveText('jevellan update');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`version-banner-${info.project.name}.png`) });
});
