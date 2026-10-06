import { expect, test } from './fixtures.js';

test('Git settings can be saved, reloaded and checked from Projects', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  await page.goto('/settings/projects');
  await page.getByRole('button', { name: 'Git settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Git', exact: true })).toBeVisible();
  // The settings tabs keep the page shown in view, also on a phone where they scroll sideways in one row; there, each end that
  // hides tabs fades out, and an end that hides none does not.
  const tabs = await page.getByRole('navigation', { name: 'Settings', exact: true }).evaluate((nav) => {
    const strip = nav.querySelector('[aria-current="page"]')!.parentElement!; const box = strip.getBoundingClientRect();
    const tab = nav.querySelector('[aria-current="page"]')!.getBoundingClientRect();
    const hidden = strip.scrollWidth - strip.clientWidth; const mask = getComputedStyle(strip).maskImage;
    return { selected: nav.querySelector('[aria-current="page"]')!.textContent, inView: tab.left >= box.left && tab.right <= box.right,
      fades: hidden > 1 ? { start: strip.scrollLeft > 1, end: strip.scrollLeft < hidden - 1, mask: mask.startsWith('linear-gradient') } : 'fits' };
  });
  expect(tabs).toMatchObject({ selected: 'Git', inView: true });
  if (test.info().project.name.startsWith('phone')) expect(tabs.fades).toEqual({ start: true, end: true, mask: true });
  else expect(tabs.fades).toBe('fits');
  await page.getByLabel('Connection method').selectOption('ssh');
  await page.getByRole('button', { name: 'Save Git settings', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Git settings saved' })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('Connection method')).toHaveValue('ssh');
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.locator('.git-check-result')).toContainText('Connected');
  await expect(page.locator('.git-check-result')).toContainText('Push permission is checked when publishing');
  expect(await page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
  await page.screenshot({ path: `test-results/git-settings-${test.info().project.name}.png`, fullPage: true });
  await page.getByLabel('Connection method').selectOption('machine');
  await page.getByRole('button', { name: 'Save Git settings', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Git settings saved' })).toBeVisible();
});
