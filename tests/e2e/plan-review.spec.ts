import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ConversationEventSchema, ConversationPublicSchema, HandoffSchema, StretchSchema } from '../../packages/core/dist/client.js';

test('plans are readable, wait for acceptance, and offer revision with stale-plan context', async ({ page, baseURL }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const id = `plan_${randomUUID()}`;
  const created = await page.request.post('/api/conversations', { headers: { Origin: baseURL! }, data: {
    schema: 'start-conversation-v1', id, projectId: 'browser_fixture', title: 'Calendar proposal', message: 'Plan the calendar integration.', clientMessageId: 'initial',
  } });
  expect(created.status()).toBe(201);
  const view = ConversationPublicSchema.parse(await created.json());
  const pointer = 'blobs/fixture-plan';
  const step = StretchSchema.omit({ native: true }).parse({
    schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'plan', modelId: 'claude-fable', runtime: 'claude', model: 'claude-fable-5-1',
    effortRequested: 'low', effortEffective: 'low', accountId: 'simulated_account', deviceId: view.conversation.ownerDeviceId, decisionId: 'simulated_decision',
    startedAt: '2026-10-03T09:00:00.000Z', endedAt: '2026-10-03T09:02:00.000Z', status: 'completed', usage: { inputTokens: 100, outputTokens: 50, costSource: 'unknown' },
  });
  const handoff = HandoffSchema.parse({ schema: 'handoff-v2', stretch: 1, action: 'plan', status: 'done', summary: 'The proposal is ready for review.',
    evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: 'implement', changedFiles: [], result: { type: 'plan', ref: pointer },
  });
  let snapshot = ConversationPublicSchema.parse({ ...view, busy: false,
    conversation: { ...view.conversation, state: 'waiting-for-you', stretchCount: 1, work: { ...view.conversation.work, latestPlanRef: pointer } }, stretches: [step], handoffs: [handoff],
  });
  const payloads = [
    { id: 1, type: 'user-message', data: { text: 'Plan the calendar integration.' } },
    { id: 2, type: 'stretch-start', data: step }, { id: 3, type: 'handoff', data: handoff },
  ].map(event => ConversationEventSchema.parse({ schema: 'conversation-event-v1', event: { schema: 'ledger-event-v1', ...event, stretch: event.type === 'user-message' ? undefined : 1, t: step.startedAt } }));
  let content: unknown = { goal: 'Connect calendars with **explicit consent**.', steps: ['Set up OAuth', { title: 'Read availability', details: 'Return only busy ranges.' }],
    architecture: { session: 'Keep tokens on the server.', endpoints: ['GET /calendars', 'POST /availability'] }, affectedFiles: { added: ['calendar.ts'], modified: ['app.ts'] },
    checks: ['Verify token refresh', 'Check expired authorization'], risks: ['Rate limits'], decisionsNeeded: ['Choose a calendar provider'],
  };
  await page.route(`**/api/conversations/${id}`, route => route.fulfill({ json: snapshot }));
  await page.route(`**/api/conversations/${id}/events`, route => route.fulfill({ contentType: 'text/event-stream', body: payloads.map(payload => `id: ${payload.event.id}\nevent: conversation\ndata: ${JSON.stringify(payload)}\n\n`).join('') }));
  let failRead = true;
  await page.route(`**/api/conversations/${id}/read?*`, route => failRead ? route.fulfill({ status: 400, json: { error: 'Simulated plan load failure' } }) : route.fulfill({ json: { schema: 'conversation-read-v1', pointer, content } }));
  let change: Record<string, unknown> | undefined;
  await page.route(`**/api/conversations/${id}/messages`, async route => { change = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ json: snapshot }); });
  let approval: Record<string, unknown> | undefined;
  await page.route(`**/api/conversations/${id}/approve-plan`, async route => {
    approval = route.request().postDataJSON() as Record<string, unknown>;
    snapshot = ConversationPublicSchema.parse({ ...snapshot, conversation: { ...snapshot.conversation, work: { ...snapshot.conversation.work, approvedPlanRef: pointer } } });
    await route.fulfill({ json: snapshot });
  });
  await page.goto(`/conversations/${id}`);
  const plan = page.getByRole('region', { name: 'Plan from step 1' });
  await expect(plan.getByRole('button', { name: 'Approve plan', exact: true })).toBeDisabled();
  failRead = false; await plan.getByRole('button', { name: 'Retry loading plan', exact: true }).click();
  await expect(plan.getByRole('heading', { name: 'Goal', exact: true })).toBeVisible();
  await expect(plan.locator('strong')).toHaveText('explicit consent');
  await expect(plan.getByRole('heading', { name: 'Affected files', exact: true })).toBeVisible();
  await expect(plan.locator('ol > li')).toHaveCount(2);
  await expect(plan).toContainText('Awaiting approval');
  expect(await plan.locator('.plan-content').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.toast.error button').click();
  await plan.locator('.plan-review-header').scrollIntoViewIfNeeded(); await page.screenshot({ path: `/private/tmp/jevellan-plan-review-${info.project.name}.png`, fullPage: true });
  await plan.getByRole('button', { name: 'Request changes', exact: true }).click();
  await plan.getByLabel('What should change?').fill('Add an expired-token test.');
  await plan.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(change).toBeUndefined();
  await plan.getByRole('button', { name: 'Request changes', exact: true }).click();
  await plan.getByRole('button', { name: 'Send requested changes', exact: true }).click();
  await expect.poll(() => change).toMatchObject({ text: 'Add an expired-token test.', planChange: { ref: pointer, generation: view.conversation.generation } });
  expect(approval).toBeUndefined();
  // Markdown plans and JSON encoded as strings must remain readable after reload.
  content = JSON.stringify(content); await page.reload(); await expect(plan.getByRole('heading', { name: 'Goal', exact: true })).toBeVisible();
  content = '## Revised approach\n\n1. Connect the calendar.\n2. Test expired tokens.\n\n**Ready for review.**';
  await page.reload(); await expect(plan.getByRole('heading', { name: 'Revised approach', exact: true })).toBeVisible();
  await plan.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect.poll(() => approval).toMatchObject({ ref: pointer, generation: view.conversation.generation });
  await expect(plan).toContainText('Approved'); await expect(plan.getByRole('button', { name: 'Approve plan', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
