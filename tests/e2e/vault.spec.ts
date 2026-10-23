import { expect, test } from './fixtures.js';
import { ProjectDefinitionEditorSchema, ProjectDefinitionsViewSchema, VaultViewSchema } from '../../packages/core/dist/client.js';
import { projectDefinitionEditor, projectDefinitionsView, projectVaultPresentation } from '../../packages/core/dist/index.js';

// Phase 5: Settings → Projects shows the vault, and adding a project whose origin has a vault folder offers to restore it.
test('Projects shows the vault and offers Restore from the vault for an origin it holds', async ({ page }, info) => {
  await page.goto('/settings/runtimes');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const vault = VaultViewSchema.parse({ schema: 'vault-view-v1', remote: 'https://github.com/example/test-vault.git', lastSyncAt: new Date(Date.now() - 120_000).toISOString(), lastError: null, pending: false, folders: ['example__shop'] });
  await page.context().route('**/api/projects/view', async route => {
    const response = await route.fetch(); const view = ProjectDefinitionsViewSchema.parse(await response.json());
    await route.fulfill({ response, json: { ...view, vault: projectVaultPresentation(vault) } });
  });
  for (const path of ['**/api/projects/editor', '**/api/projects/editor/preview']) await page.context().route(path, async route => {
    const response = await route.fetch(); const view = ProjectDefinitionEditorSchema.parse(await response.json());
    await route.fulfill({ response, json: projectDefinitionEditor({ schema: 'project-definition-preview-v1', context: view.context, fields: view.fields }, { deviceId: view.currentDeviceId, devices: view.devices, current: null, vault }) });
  });
  await page.goto('/settings/projects');
  const card = page.getByRole('region', { name: 'Vault' });
  await expect(card).toContainText('https://github.com/example/test-vault.git'); await expect(card).toContainText('Synced');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const restore = page.getByRole('checkbox', { name: 'Restore from the vault' });
  await expect(restore).toHaveCount(0);
  await page.getByLabel('Remote URL').fill('https://github.com/example/shop.git');
  await expect(restore).toBeChecked();
  await expect(page.getByText('come back from example__shop')).toBeVisible();
  await page.getByLabel('Remote URL').fill('https://github.com/example/other.git');
  await expect(restore).toHaveCount(0);
  await page.getByLabel('Remote URL').fill('https://github.com/example/shop.git');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`vault-restore-${info.project.name}.png`) });
});

test('a project card keeps a long test command inside the card and its Edit button in view', async ({ page }, info) => {
  // A long configured check must stay inside the card and leave Edit visible.
  await page.goto('/settings/runtimes');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const long = 'npm run build --workspace shared && npm run typecheck && npm run lint && npm run test:unit --workspace server';
  await page.context().route('**/api/projects/view', async route => {
    const response = await route.fetch(); const body = ProjectDefinitionsViewSchema.parse(await response.json());
    const first = body.projects[0]!; first.view.project.testCommand = long;
    body.projects[0] = projectDefinitionsView([{ view: first.view, public: first.publicMemoryNotice }], body.currentDeviceId, null).projects[0]!;
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
