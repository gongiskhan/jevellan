import { expect, test } from './fixtures.js';

// Phase 5: Settings → Projects shows the vault, and adding a project whose origin has a vault folder offers to restore it.
test('Projects shows the vault and offers Restore from the vault for an origin it holds', async ({ page }, info) => {
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  await page.route('**/api/vault', route => route.fulfill({ json: { schema: 'vault-view-v1', remote: 'https://github.com/gongiskhan/jevellan-vault.git', lastSyncAt: new Date(Date.now() - 120_000).toISOString(),
    lastError: null, pending: false, folders: ['gongiskhan__ekoa-code'] } }));
  await page.goto('/settings/projects');
  const card = page.getByRole('region', { name: 'Vault' });
  await expect(card).toContainText('https://github.com/gongiskhan/jevellan-vault.git'); await expect(card).toContainText('Synced');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const restore = page.getByRole('checkbox', { name: 'Restore from the vault' });
  await expect(restore).toHaveCount(0);
  await page.getByLabel('Remote URL').fill('https://github.com/gongiskhan/ekoa-code.git');
  await expect(restore).toBeChecked();
  await expect(page.getByText('come back from gongiskhan__ekoa-code')).toBeVisible();
  await page.getByLabel('Remote URL').fill('https://github.com/gongiskhan/other.git');
  await expect(restore).toHaveCount(0);
  await page.getByLabel('Remote URL').fill('https://github.com/gongiskhan/ekoa-code.git');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`vault-restore-${info.project.name}.png`) });
});

test('a project card keeps a long test command inside the card and its Edit button in view', async ({ page }, info) => {
  // Seen on the live hub: ekoa-code's fast checks ran past the card's border and pushed Edit out of the card.
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const long = 'npm run build --workspace shared && npm run typecheck && npm run lint && npm run test:unit --workspace server';
  await page.route('**/hub/projects', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); const body = await response.json();
    body.projects[0].project.testCommand = long;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/settings/projects');
  const card = page.locator('.project-card').first(), command = card.getByText(long, { exact: true }), edit = card.getByRole('button', { name: 'Edit', exact: true });
  await expect(edit).toBeVisible();
  const [box, button] = [(await card.boundingBox())!, (await edit.boundingBox())!];
  expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  // Phones leave the test command out of the card; wider layouts show all of it inside the card.
  if ((page.viewportSize()?.width ?? 0) > 700) {
    await expect(command).toBeVisible(); const text = (await command.boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  } else await expect(command).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The command is only shown, and so only judged by eye, where the layout has room for it.
  if ((page.viewportSize()?.width ?? 0) > 700) { await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`project-card-long-command-${info.project.name}.png`) }); }
});
