import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ConversationPublicSchema } from '../../packages/core/dist/client.js';

test('user messages stay readable and support retry, cancel editing and resend', async ({ page, baseURL }) => {
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const id = `message_actions_${randomUUID()}`;
  const original = 'Explain this **project** without changing anything.';
  const created = await page.request.post('/api/conversations', { headers: { Origin: baseURL! }, data: {
    schema: 'start-conversation-v1', id, projectId: 'browser_fixture', title: 'Message actions', message: original, clientMessageId: 'initial',
  } });
  expect(created.status()).toBe(201);
  await page.goto(`/conversations/${id}`);
  const first = page.locator('.user-message').first();
  await expect(first.locator('.markdown')).toHaveText('Explain this project without changing anything.');
  const contrast = await first.evaluate(element => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (values: number[]) => values.map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i]!, 0);
    const foreground = luminance(rgb(getComputedStyle(element.querySelector('.markdown p')!).color));
    const background = luminance(rgb(getComputedStyle(element).backgroundColor));
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  const read = async () => ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${id}`)).json());
  await expect.poll(async () => (await read()).decisionWait).toBeTruthy();
  const resumed = page.waitForResponse(response => response.url().endsWith(`/conversations/${id}/resume`) && response.request().method() === 'POST');
  await first.getByRole('button', { name: 'Retry message', exact: true }).click();
  expect((await resumed).ok()).toBe(true);
  expect((await read()).messages).toHaveLength(1);
  await first.getByRole('button', { name: 'Edit message', exact: true }).click();
  await expect(first.getByLabel('Edit message')).toHaveValue(original);
  await first.getByLabel('Edit message').fill('Discard this draft.');
  await first.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await read()).messages).toHaveLength(1);
  await first.getByRole('button', { name: 'Edit message', exact: true }).click();
  const edited = 'Explain the project and its dependencies. Do not change anything.';
  await first.getByLabel('Edit message').fill(edited);
  await first.getByRole('button', { name: 'Send edited message', exact: true }).click();
  await expect(page.locator('.user-message').last().locator('.markdown')).toHaveText(edited);
  expect((await read()).messages.map(message => message.text)).toEqual([original, edited]);
  await expect(first.getByRole('button', { name: 'Retry message', exact: true })).toBeEnabled();
  await first.getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect.poll(async () => (await read()).messages.map(message => message.text)).toEqual([original, edited, original]);
  await page.reload();
  await expect(page.locator('.user-message')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
