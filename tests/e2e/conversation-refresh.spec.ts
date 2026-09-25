import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { ConversationPublicSchema } from '../../packages/core/dist/client.js';

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
  await expect(page.locator('.conversation-page > .small-text')).not.toContainText('Ready');
  await expect(page.getByRole('combobox', { name: 'Next step', exact: true })).not.toBeVisible();
  await page.locator('.composer-options > summary').click();
  await expect(page.getByRole('combobox', { name: 'Next step', exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate(body => body.clientWidth));
  await page.locator('.composer-options > summary').click();
  await page.screenshot({ path: `test-results/conversation-progress-${test.info().project.name}.png`, fullPage: true });
  await page.request.post(`/api/conversations/${id}/cancel`, { data: { schema: 'empty-request-v1' } });
});

test('a project can be added directly without losing the new conversation draft', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft while I add a project.');
  await page.getByRole('button', { name: '＋ Add project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add project' })).toBeVisible();
  await expect(page.getByLabel('Path on Mac.lan', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Browse folders on Mac.lan' }).click();
  await expect(page.getByRole('region', { name: 'Project folders' })).toBeVisible();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByLabel('Path on Mac.lan', { exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.locator('.new-conversation-form textarea')).toHaveValue('Keep my draft while I add a project.');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
});
