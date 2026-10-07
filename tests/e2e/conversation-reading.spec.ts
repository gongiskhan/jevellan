import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ConversationEventSchema, ConversationPublicSchema, HandoffSchema, StretchSchema } from '../../packages/core/dist/client.js';

test('conversation replies read as chat while tools and recorded details remain available', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const id = `reading_${randomUUID()}`;
  const created = await page.request.post('/api/conversations', { headers: { Origin: baseURL! }, data: {
    schema: 'start-conversation-v1', id, projectId: 'browser_fixture', title: 'Short summary',
    message: 'Give me a short summary of the work.', clientMessageId: 'initial',
  } });
  expect(created.status()).toBe(201);
  const view = ConversationPublicSchema.parse(await created.json());
  const answer = 'The fixture is safe to retire. Its background hooks are removed and nothing is running.';
  const finding = 'No background hooks remain in the simulated fixture.';
  const step = StretchSchema.omit({ native: true }).parse({
    schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'reply', modelId: 'claude-fable',
    runtime: 'claude', model: 'claude-fable-5-1', effortRequested: 'low', effortEffective: 'low',
    accountId: 'simulated_account', deviceId: view.conversation.ownerDeviceId, decisionId: 'simulated_decision',
    startedAt: '2026-10-01T12:00:00.000Z', endedAt: '2026-10-01T12:00:12.000Z', status: 'completed',
    usage: { inputTokens: 100, outputTokens: 50, costSource: 'unknown' },
  });
  const handoff = HandoffSchema.parse({
    schema: 'handoff-v2', stretch: 1, action: 'reply', status: 'done', summary: answer,
    evidence: [], findings: [{ claim: finding, pointer: 'value.txt:1' }], blockers: [],
    failedApproaches: ['The simulated command returned an error; the recorded file still answered the question.'],
    proposedNext: null, changedFiles: [],
  });
  let snapshot = ConversationPublicSchema.parse({ ...view, busy: false,
    conversation: { ...view.conversation, state: 'waiting-for-you', stretchCount: 1 }, stretches: [step], handoffs: [handoff],
  });
  const payloads = [
    { id: 1, type: 'user-message', data: { text: 'Give me a short summary of the work.' } },
    { id: 2, type: 'stretch-start', data: step },
    { id: 3, type: 'thinking', data: { delta: 'I will answer from the work already recorded.' } },
    { id: 4, type: 'tool-start', data: { id: 'read', name: 'Read', input: { path: 'value.txt' } } },
    { id: 5, type: 'tool-end', data: { id: 'read', ok: true, output: 'Recorded file contents.' } },
    { id: 6, type: 'tool-start', data: { id: 'command', name: 'Bash', input: { command: 'simulated-command' } } },
    { id: 7, type: 'tool-end', data: { id: 'command', ok: false, output: 'Simulated failure details.' } },
    { id: 8, type: 'text', data: { delta: answer } },
    { id: 9, type: 'handoff', data: handoff },
  ].map(event => ConversationEventSchema.parse({ schema: 'conversation-event-v1', event: {
    schema: 'ledger-event-v1', ...event, stretch: event.type === 'user-message' ? undefined : 1, t: step.startedAt,
  } }));
  await page.route(`**/api/conversations/${id}`, route => route.fulfill({ json: snapshot }));
  await page.route(`**/api/conversations/${id}/events`, route => route.fulfill({
    contentType: 'text/event-stream', body: payloads.map(payload => `id: ${payload.event.id}\nevent: conversation\ndata: ${JSON.stringify(payload)}\n\n`).join(''),
  }));
  await page.goto(`/conversations/${id}`);
  const reply = page.locator('.stretch-block');
  await expect(reply.getByText(answer, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(reply.locator('.cursor-thinking')).toHaveAttribute('open', '');
  await expect(reply.locator('.cursor-thinking')).toContainText('I will answer from the work already recorded.');
  await expect(reply.locator('.findings')).not.toBeVisible();
  await expect(reply.locator('.handoff')).not.toBeVisible();
  await expect(reply.locator('.stretch-timing')).toContainText('Started');
  await expect(reply.locator('.stretch-timing')).toContainText('Ended');
  await expect(reply.locator('.stretch-timing')).toContainText('12s');
  await expect(reply.getByRole('button', { name: 'Changes', exact: true })).toBeVisible();
  await expect(reply.getByRole('button', { name: 'Why', exact: true })).toBeVisible();
  const tools = reply.locator('.conversation-tools');
  await expect(tools.locator('.cursor-tool')).toHaveCount(2);
  await expect(tools.locator('details.cursor-tool')).toHaveCount(0);
  const read = tools.locator('.cursor-tool').first();
  await expect(read).toContainText('Recorded file contents.');
  const command = tools.locator('.cursor-tool').last();
  await expect(command).toContainText('Simulated failure details.');
  await reply.locator('.step-details > summary').click();
  await expect(reply.locator('.findings')).toContainText(finding);
  await expect(reply.getByRole('button', { name: 'Change effort for step 1', exact: true })).toHaveText('low');
  await expect(reply.locator('.step-details')).toContainText('simulated_account');
  await expect(page.locator('.user-message').getByRole('button', { name: 'Edit message', exact: true })).toBeVisible();
  await expect(page.locator('.user-message').getByRole('button', { name: 'Retry message', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Older stretches sometimes saved their answer only in the handoff.
  const finalReply = payloads.splice(payloads.findIndex(payload => payload.event.type === 'text'), 1)[0]!;
  await page.reload();
  await expect(reply.getByText(answer, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(reply.locator('.handoff')).not.toBeVisible();

  // A durable answer is the primary reply; its original stream stays available in details.
  payloads.push(finalReply);
  const durableAnswer = 'Nothing is running. The simulated fixture can be retired.';
  snapshot = ConversationPublicSchema.parse({ ...snapshot, handoffs: [{ ...handoff, result: { type: 'answer', ref: 'blob:simulated-answer' } }] });
  await page.route(`**/api/conversations/${id}/read?*`, route => route.fulfill({ json: {
    schema: 'conversation-read-v1', pointer: 'blob:simulated-answer', content: `## Short answer\n\n${durableAnswer}`,
  } }));
  await page.reload();
  await expect(reply.getByRole('heading', { name: 'Short answer', exact: true })).toBeVisible();
  await expect(reply.getByText(durableAnswer, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(reply.getByText(answer, { exact: true }).filter({ visible: true })).toHaveCount(0);
  await reply.locator('.step-details > summary').click();
  await expect(reply.locator('.recorded-response')).toContainText(answer);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Old blockers are historical details; the current question remains actionable.
  const oldBlocker = 'An earlier fixture account needed a login.';
  const oldQuestion = 'An earlier question has already been answered.';
  const currentBlocker = 'The current fixture needs your answer.';
  const nextStep = { ...step, n: 2 };
  snapshot = ConversationPublicSchema.parse({ ...snapshot,
    stretches: [step, nextStep], handoffs: [{ ...snapshot.handoffs[0], blockers: [oldBlocker], question: oldQuestion }, { ...handoff, stretch: 2, summary: 'The next reply is recorded.', blockers: [currentBlocker] }],
  });
  for (const event of [
    { id: 10, type: 'stretch-start', stretch: 2, data: nextStep },
    { id: 11, type: 'text', stretch: 2, data: { delta: 'The next reply is recorded.' } },
    { id: 12, type: 'notice', stretch: 1, data: { schema: 'conversation-notice-v1', kind: 'closing', text: answer } },
    { id: 13, type: 'notice', stretch: 2, data: { schema: 'conversation-notice-v1', kind: 'info', text: 'A separate operational notice stays visible.' } },
  ]) payloads.push(ConversationEventSchema.parse({ schema: 'conversation-event-v1', event: { schema: 'ledger-event-v1', ...event, t: step.startedAt } }));
  await page.reload();
  const history = page.locator('.stretch-block').first();
  await expect(history.getByText(oldBlocker, { exact: true })).not.toBeVisible();
  await expect(history.getByText(oldQuestion, { exact: true })).not.toBeVisible();
  await expect(page.locator('.stretch-block').last().getByText(currentBlocker, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(page.locator('.timeline > .notice').filter({ hasText: answer })).toHaveCount(0);
  await expect(page.getByText('A separate operational notice stays visible.', { exact: true })).toBeVisible();
  await history.locator('.step-details > summary').click();
  await expect(history.getByText(oldBlocker, { exact: true })).toBeVisible();
  await expect(history.getByText(oldQuestion, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
