import { expect, test } from './fixtures.js';

test('an agent connection is scoped, shown once, and revocable', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  await page.goto('/settings/agents');
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  const label = `Project agent ${test.info().project.name}`;
  await page.getByLabel('Name', { exact: true }).fill(label);
  await page.getByLabel('Access', { exact: true }).selectOption('selected');
  await expect(page.getByRole('button', { name: 'Create connection', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Browser fixture', exact: true }).check();
  await page.getByLabel('Expires', { exact: true }).selectOption('7');
  await page.getByRole('button', { name: 'Create connection', exact: true }).click();
  const token = page.getByLabel('Connection token', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  expect(await token.evaluate(element => (element as HTMLInputElement).value.startsWith('jva_'))).toBe(true);
  await page.getByRole('button', { name: 'I saved it', exact: true }).click();
  await expect(token).toHaveCount(0);
  const connection = page.locator('.agent-connections li').filter({ hasText: label });
  await expect(connection).toContainText('Active');
  await expect(connection).toContainText('Browser fixture');
  await expect(connection).toContainText('Expires');
  await expect(page.getByLabel('MCP address', { exact: true })).toHaveValue(/\/mcp$/);
  await expect(page.locator('.agent-config').first()).toContainText('Bearer <connection token>');
  await page.reload();
  await expect(token).toHaveCount(0);
  await expect(connection).toContainText('Active');
  expect(await page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
  await page.screenshot({ path: `test-results/agents-${test.info().project.name}.png`, fullPage: true });
  await connection.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke connection', exact: true }).click();
  await expect(connection).toContainText('Revoked');
  await expect(connection.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
});

test('retrying a lost connection response does not create another token', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  await page.goto('/settings/agents');
  const label = `Retry agent ${test.info().project.name}`;
  let lost = false;
  await page.route('**/api/agent-access', async route => {
    if (route.request().method() !== 'POST' || lost) { await route.continue(); return; }
    lost = true;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({
      schema: 'error-v1', message: 'The connection response was interrupted.',
    }) });
  });
  await page.getByLabel('Name', { exact: true }).fill(label);
  await page.getByRole('button', { name: 'Create connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create connection', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Create connection', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This connection was already created' })).toBeVisible();
  await expect(page.locator('.agent-connections li').filter({ hasText: label })).toHaveCount(1);
  await expect(page.getByLabel('Connection token', { exact: true })).toHaveCount(0);
});
