import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { ConversationPublicSchema, DeviceRosterSchema } from '../../packages/core/dist/client.js';

test('conversation renders its first snapshot while a replay refresh is pending', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  expect(login.ok()).toBe(true);
  const id = `refresh_${randomUUID()}`;
  const created = await page.request.post('/api/conversations', { data: { schema: 'start-conversation-v1', id, clientMessageId: `message_${randomUUID()}`, projectId: 'browser_fixture', title: 'Snapshot refresh fixture', message: 'Wait for my next step.' } });
  expect(created.status()).toBe(201);
  const view = ConversationPublicSchema.parse(await created.json());
  let releaseFirst!: () => void; let releaseLater!: () => void; let reads = 0;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const later = new Promise<void>(resolve => { releaseLater = resolve; });
  await page.route(`**/api/conversations/${id}`, async route => {
    const n = ++reads; await (n === 1 ? first : later);
    await route.fulfill({ json: { ...view, conversation: { ...view.conversation, title: n === 1 ? 'Initial visible conversation' : 'Updated visible conversation' } } });
  });
  try {
    const streaming = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${id}/events`);
    await page.goto(`/conversations/${id}`);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
    await streaming;
    // Replay notifications arrive while the first snapshot is deliberately held.
    await page.waitForTimeout(300);
    releaseFirst();
    await expect(page.getByRole('heading', { name: 'Initial visible conversation' })).toBeVisible();
    await expect.poll(() => reads).toBe(2);
    releaseLater();
    await expect(page.getByRole('heading', { name: 'Updated visible conversation' })).toBeVisible();
  } finally {
    releaseFirst(); releaseLater();
    await page.request.post(`/api/conversations/${id}/cancel`, { data: { schema: 'empty-request-v1' } });
  }
});

test('pending work shows a live stage while controls stay compact', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  const id = `progress_${randomUUID()}`;
  const created = await page.request.post('/api/conversations', { data: { schema: 'start-conversation-v1', id, clientMessageId: `message_${randomUUID()}`, projectId: 'browser_fixture', title: 'Progress fixture', message: 'Explain the project.' } });
  const view = ConversationPublicSchema.parse(await created.json());
  await page.route(`**/api/conversations/${id}`, route => route.fulfill({ json: { ...view, busy: true, progress: { schema: 'conversation-progress-v1', phase: 'deciding', since: new Date().toISOString() } } }));
  await page.goto(`/conversations/${id}`);
  const activity = page.getByRole('region', { name: 'Current activity' });
  await expect(activity).toContainText('Jev is choosing the next step');
  await expect(page.locator('.conversation-meta')).not.toContainText('Ready');
  await expect(page.getByRole('combobox', { name: 'Next step', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: /^Override/ }).click();
  await expect(page.getByRole('combobox', { name: 'Next step', exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate(body => body.clientWidth));
  await page.getByRole('dialog', { name: 'Override the next step' }).getByRole('button', { name: 'Done', exact: true }).click();
  await page.screenshot({ path: `test-results/conversation-progress-${test.info().project.name}.png`, fullPage: true });
  await page.request.post(`/api/conversations/${id}/cancel`, { data: { schema: 'empty-request-v1' } });
});

test('a project can be added directly without losing the new conversation draft', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft while I add a project.');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add project' })).toBeVisible();
  const roster = DeviceRosterSchema.parse(await (await page.request.get('/hub/devices/roster')).json());
  const device = roster.devices.find(row => row.device.id === roster.currentDeviceId)!.device.name;
  await expect(page.getByLabel(`Path on ${device}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Browse folders on ${device}` }).click();
  await expect(page.getByRole('region', { name: 'Project folders' })).toBeVisible();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByLabel(`Path on ${device}`, { exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.locator('.new-conversation-form textarea')).toHaveValue('Keep my draft while I add a project.');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
});

test('opening a folder in the picker selects it and names the project after it', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  const roster = DeviceRosterSchema.parse(await (await page.request.get('/hub/devices/roster')).json());
  const device = roster.devices.find(row => row.device.id === roster.currentDeviceId)!.device.name;
  await dialog.getByRole('button', { name: `Browse folders on ${device}` }).click();
  const picker = dialog.getByRole('region', { name: 'Project folders' });
  await picker.getByRole('button', { name: '▸ picked-project', exact: true }).click();
  await expect(picker.locator('.project-path')).toHaveText(/\/picked-project$/);
  await expect(dialog.getByLabel(`Path on ${device}`, { exact: true })).toHaveValue(/\/picked-project$/);
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('picked-project');
  // Leaving the name empty still saves under the folder name.
  await dialog.getByLabel('Name', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Project', exact: true }).locator('option', { hasText: 'picked-project' })).toHaveCount(1);
});

test('a question with offered answers shows them as buttons, and a picked answer continues the work', async ({ page }, info) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  expect((await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Answer options account', kind: 'subscription', secret: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  expect((await page.request.put('/hub/secrets/jev', { data: { schema: 'save-secret-v1', value: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('automatic_fixture');
  await page.getByPlaceholder('What should we build or fix?').fill('Exercise answer options: change the value.'); await page.keyboard.press('Enter');
  const card = page.getByRole('region', { name: 'Answer the question' });
  await expect(card).toContainText('Shall I change the value in value.txt to two?', { timeout: 60_000 });
  await expect(card.getByRole('button')).toHaveText(['Yes, change the value to two', 'No, keep the value as it is']);
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/answer-options-${info.project.name}.png` });
  await card.getByRole('button', { name: 'Yes, change the value to two', exact: true }).click();
  await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 60_000 }); await expect(card).toHaveCount(0);
  const id = new URL(page.url()).pathname.split('/')[2]!; const view = ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${id}`)).json());
  expect(view.messages.at(-1)).toMatchObject({ text: 'Yes, change the value to two', answer: { stretch: 1, option: 0, label: 'Yes, change the value to two' } });
  expect(view.decisions.map((decision) => decision.action.chosen)).toEqual(['ask-you', 'implement', 'done']);
});
