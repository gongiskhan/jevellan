import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConversationControlsViewSchema, ConversationPublicSchema, ConversationStartRequestSchema, ConversationStartResultSchema, OwnerToolResultSchema } from '../../packages/core/dist/index.js';
import { projectFixture } from '../helpers/project-fixture.js';
import { expect, test } from './fixtures.js';
import { closeConversationSettings, openConversationSettings } from './navigation.js';

test('STARTPAR1 browser creation and MCP retry preserve one canonical conversation and ledger', async ({ page, context }, info) => {
  const f = await projectFixture({ control: true }); let client: Client | undefined;
  try {
    const separator = f.cookie.indexOf('=');
    await context.addCookies([{ name: f.cookie.slice(0, separator), value: f.cookie.slice(separator + 1), url: f.base, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(f.base + '/new');
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('project');
    await page.getByPlaceholder('What should we build or fix?').fill('Wait for the next fixture step.');
    const creation = page.waitForRequest(request => request.url() === f.base + '/api/conversation-new/start' && request.method() === 'POST');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const request = ConversationStartRequestSchema.parse((await creation).postDataJSON());
    await expect(page).toHaveURL(/\/conversations\/[^/]+$/u);
    const id = new URL(page.url()).pathname.split('/')[2]!;
    await f.app.conversations.wait(id);
    const before = await f.app.conversations.view(id), events = f.app.conversations.ledger(id).events().length;
    expect(before.messages).toHaveLength(1);
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', '..', 'bin', 'jevellan.mjs'), 'mcp'],
      cwd: f.checkout, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JEVELLAN_HOME: f.homes.root }, stderr: 'ignore' });
    client = new Client({ name: 'conversation-parity-fixture', version: '1' }); await client.connect(transport);
    const result = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_start', request } })).structuredContent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('The canonical MCP creation retry was refused.');
    const reply = ConversationStartResultSchema.parse(result.data);
    expect(reply.status).toBe('existing'); expect(reply.view?.conversation).toEqual(before.conversation); expect(reply.view?.messages).toEqual(before.messages);
    const prepared = ConversationControlsViewSchema.parse(before.controls);
    expect(reply.view?.controls).toEqual(prepared);
    const read = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_view', conversation: id } })).structuredContent);
    expect(read.ok).toBe(true); if (!read.ok) throw new Error('The canonical MCP control read was refused.');
    expect(ConversationPublicSchema.parse(read.data).controls).toEqual(prepared);
    expect(prepared).toMatchObject({ running: false, messageActions: { canEdit: true, canRetry: true }, settlement: { shown: true, label: 'Close this work' }, canFinishOutside: true });
    await expect(page.locator('.conversation-meta .state-' + prepared.state)).toHaveText(prepared.stateLabel);
    await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Edit message', exact: true })).toBeEnabled();
    await expect(page.locator('.decision-recovery')).toHaveCount(prepared.recovery.decision ? 1 : 0);
    await expect(page.locator('.answer-card')).toHaveCount(prepared.question ? 1 : 0);
    await page.locator('summary[aria-label="Conversation menu"]').click();
    await expect(page.getByRole('button', { name: 'Finished outside Jevellan', exact: true })).toBeEnabled();
    await page.locator('summary[aria-label="Conversation menu"]').click();
    const settings = await openConversationSettings(page);
    await expect(settings.getByRole('button', { name: prepared.settlement.label, exact: true })).toBeEnabled();
    await closeConversationSettings(page);
    expect(f.app.conversations.ledger(id).events()).toHaveLength(events);
    expect((await f.app.conversations.list()).conversations).toHaveLength(1); expect(f.fake.starts).toHaveLength(0);
    await expect(page.locator('.manual-picker')).toBeVisible();
    await page.screenshot({ path: info.outputPath('canonical-creation-parity.png'), fullPage: true });
  } finally { await client?.close(); await f.close(); }
});

test('CONTROLSPAR1 recorded question controls match MCP and the browser answer preserves canonical history', async ({ page, context }, info) => {
  const f = await projectFixture({ control: true }); let client: Client | undefined;
  try {
    f.fake.capabilities.readOnlyEnforced = true;
    const id = 'question_controls', question = 'Which fixture value should stay?', options = [{ label: 'Keep the first value', detail: 'Preserve the fixture.' }, { label: 'Use the second value' }];
    await f.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Question controls', message: 'Ask the fixture question.', clientMessageId: 'question_first' });
    await f.app.conversations.wait(id);
    f.fake.enqueue(async ({ input, emit }) => {
      emit({ type: 'text', delta: 'The fixture question is recorded.' });
      const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` },
        body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: { schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'The fixture question is recorded.', question, options, proposedNext: null, evidence: [], findings: [], blockers: [], failedApproaches: [], changedFiles: [] } }) });
      expect(response.status).toBe(200); return { status: 'completed' };
    });
    await f.app.conversations.manual(id, { schema: 'manual-step-v1', generation: (await f.app.conversations.view(id)).conversation.generation, action: 'reply', modelId: 'fixture', effort: 'medium' });
    await f.app.conversations.wait(id); const before = await f.app.conversations.view(id), count = f.app.conversations.ledger(id).events().length;
    const separator = f.cookie.indexOf('='); await context.addCookies([{ name: f.cookie.slice(0, separator), value: f.cookie.slice(separator + 1), url: f.base, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(f.base + '/conversations/' + id);
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', '..', 'bin', 'jevellan.mjs'), 'mcp'], cwd: f.checkout,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JEVELLAN_HOME: f.homes.root }, stderr: 'ignore' });
    client = new Client({ name: 'question-controls-fixture', version: '1' }); await client.connect(transport);
    const result = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_view', conversation: id } })).structuredContent);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error('The canonical question control read was refused.');
    const view = ConversationPublicSchema.parse(result.data), controls = ConversationControlsViewSchema.parse(view.controls);
    expect(controls).toEqual(before.controls); expect(controls.question?.text).toBe(question);
    expect(controls.question?.options).toEqual(options.map((option, index) => ({ ...option, index, primary: index === 0 })));
    const card = page.getByRole('region', { name: 'Answer the question' }); await expect(card).toContainText(question);
    await expect(card.getByRole('button')).toHaveText(options.map(option => option.label));
    await expect(card.getByRole('button').nth(0)).not.toHaveClass(/secondary/u); await expect(card.getByRole('button').nth(1)).toHaveClass(/secondary/u);
    await expect(card.getByRole('button').nth(0)).toHaveAttribute('title', options[0]!.detail!);
    expect(f.app.conversations.ledger(id).events()).toHaveLength(count); expect(f.fake.starts).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('controls-question.png'), fullPage: true });
    await card.getByRole('button', { name: options[0]!.label, exact: true }).click(); await expect(card).toHaveCount(0); await f.app.conversations.wait(id);
    const answered = await f.app.conversations.view(id); expect(answered.messages.at(-1)).toMatchObject({ text: options[0]!.label, answer: { stretch: 1, option: 0, label: options[0]!.label } }); expect(answered.controls?.question).toBeNull(); expect(answered.handoffs).toEqual(before.handoffs); expect(f.fake.starts).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('controls-answer.png'), fullPage: true });
  } finally { await client?.close().catch(() => undefined); await f.close(); }
});
