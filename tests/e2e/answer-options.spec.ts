import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { ConversationPublicSchema } from '../../packages/core/dist/client.js';

// This journey saves a Jev key, so it runs on the keyed fixture servers (see playwright.config.ts) and never
// turns the shared servers' "Jev is not set up" starting point into a configured one.
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
  await page.screenshot({ path: `docs/acceptance/screenshots/answer-options-${String(info.project.metadata.layout ?? info.project.name)}.png` });
  await card.getByRole('button', { name: 'Yes, change the value to two', exact: true }).click();
  await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 60_000 }); await expect(card).toHaveCount(0);
  const id = new URL(page.url()).pathname.split('/')[2]!; const view = ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${id}`)).json());
  expect(view.messages.at(-1)).toMatchObject({ text: 'Yes, change the value to two', answer: { stretch: 1, option: 0, label: 'Yes, change the value to two' } });
  expect(view.decisions.map((decision) => decision.action.chosen)).toEqual(['ask-you', 'implement', 'done']);
});
