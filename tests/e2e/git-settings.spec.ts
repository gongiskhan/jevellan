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
  // Each end that hides tabs also shows a chevron button, clear of the selected tab, that scrolls the strip that way; a strip
  // that fits shows none.
  const nav = page.getByRole('navigation', { name: 'Settings', exact: true }); const strip = nav.locator('.settings-tabs-strip');
  const earlier = nav.getByRole('button', { name: 'Earlier settings tabs', exact: true }); const more = nav.getByRole('button', { name: 'More settings tabs', exact: true });
  if (test.info().project.name.startsWith('phone')) {
    await expect(earlier).toBeVisible(); await expect(more).toBeVisible();
    const selected = (await nav.locator('[aria-current="page"]').boundingBox())!;
    for (const chevron of [earlier, more]) { const box = (await chevron.boundingBox())!; expect(box.x + box.width <= selected.x || box.x >= selected.x + selected.width).toBe(true); }
    const start = await strip.evaluate(element => element.scrollLeft);
    await more.click(); await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(start + 50);
    const moved = await strip.evaluate(element => element.scrollLeft);
    await earlier.click(); await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeLessThan(moved - 50);
    // At every scroll position of the strip, no tab label passes under a chevron: the part of a tab the strip shows never meets a
    // chevron that is shown. (The chevrons once sat over the strip's ends, and Devices or Improver ran under them.)
    const covered = await strip.evaluate(async (element) => {
      const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const problems: string[] = []; const last = element.scrollWidth - element.clientWidth;
      for (let left = 0; left <= last + 8; left += 8) {
        element.scrollLeft = Math.min(left, last); await frames();
        const box = element.getBoundingClientRect();
        const chevrons = [...element.parentElement!.querySelectorAll('.strip-scroll')].filter((chevron) => getComputedStyle(chevron).display !== 'none').map((chevron) => chevron.getBoundingClientRect());
        for (const tab of element.children) {
          const at = tab.getBoundingClientRect(); const from = Math.max(at.left, box.left); const to = Math.min(at.right, box.right);
          if (to > from && chevrons.some((chevron) => chevron.left < to && chevron.right > from)) problems.push(`${element.scrollLeft}px: ${tab.textContent}`);
        }
      }
      return problems;
    });
    expect(covered).toEqual([]);
  } else { await expect(earlier).toBeHidden(); await expect(more).toBeHidden(); }
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
