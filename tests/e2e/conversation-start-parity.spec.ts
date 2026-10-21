import { join } from 'node:path';
import { ConversationSettlementCommandSchema, ConversationSettlementEditorSchema } from '../../packages/core/dist/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConversationControlCommandSchema, ConversationMessageCommandSchema, ConversationControlsViewSchema, ConversationPublicSchema, ConversationStartRequestSchema, ConversationStartResultSchema, OwnerToolResultSchema } from '../../packages/core/dist/index.js';
import { projectFixture } from '../helpers/project-fixture.js';
import { expect, test } from './fixtures.js';
import { closeConversationSettings, openConversationSettings } from './navigation.js';

for (const branchPolicy of ['main', 'external'] as const) test(`SETTLEPAR1 browser settlement and MCP receipts preserve later work (${branchPolicy})`, async ({ page, context }, info) => {
  const f = await projectFixture({ control: true, branchPolicy }); let client: Client | undefined;
  try {
    const id = 'settlement_parity';
    await f.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Settlement parity', message: 'Preserve this fixture work.', clientMessageId: 'settlement_parity_first' }); await f.app.conversations.wait(id);
    const refs = f.git(f.checkout, 'show-ref'), status = f.git(f.checkout, 'status', '--porcelain');
    const separator = f.cookie.indexOf('='); await context.addCookies([{ name: f.cookie.slice(0, separator), value: f.cookie.slice(separator + 1), url: f.base, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(f.base + '/conversations/' + id);
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', '..', 'bin', 'jevellan.mjs'), 'mcp'], cwd: f.checkout,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JEVELLAN_HOME: f.homes.root }, stderr: 'ignore' });
    client = new Client({ name: 'settlement-parity-fixture', version: '1' }); await client.connect(transport);
    const read = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_settlement_editor', conversation: id, request: { schema: 'conversation-settlement-editor-request-v1' } } })).structuredContent);
    expect(read.ok).toBe(true); if (!read.ok) throw new Error('The canonical settlement editor was refused.');
    const editor = ConversationSettlementEditorSchema.parse(read.data);
    const settings = await openConversationSettings(page); await settings.getByRole('button', { name: 'Close this work', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: editor.title, exact: true }); await expect(dialog).toContainText(editor.intro);
    for (const option of editor.choices) { await expect(dialog.getByRole('button', { name: option.label, exact: true })).toBeEnabled(); if (option.description) await expect(dialog).toContainText(option.description); }
    if (branchPolicy === 'external') {
      await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Discard…', exact: true })).toHaveCount(0); expect(editor.confirmation).toBeNull();
    } else {
      await dialog.getByRole('button', { name: 'Discard…', exact: true }).click(); const confirmation = page.getByRole('dialog', { name: editor.confirmation!.title, exact: true });
      for (const paragraph of editor.confirmation!.paragraphs) await expect(confirmation).toContainText(paragraph);
      await expect(confirmation.getByRole('button', { name: editor.confirmation!.submitLabel, exact: true })).toBeEnabled();
      await page.screenshot({ path: info.outputPath('settlement-confirmation.png'), fullPage: true }); await confirmation.getByRole('button', { name: editor.confirmation!.backLabel, exact: true }).click();
    }
    await page.screenshot({ path: info.outputPath('settlement-choices.png'), fullPage: true });
    const submission = page.waitForRequest(request => request.url() === f.base + '/api/conversations/' + id + '/settlement-command' && request.method() === 'POST');
    await dialog.getByRole('button', { name: editor.choices.find(option => option.choice === 'keep')!.label, exact: true }).click(); await expect(dialog).toHaveCount(0); await f.app.conversations.wait(id);
    const command = ConversationSettlementCommandSchema.parse((await submission).postDataJSON()), settled = await f.app.conversations.view(id), count = f.app.conversations.ledger(id).events().length;
    expect(settled.settlements).toMatchObject([{ id: command.body.clientRequestId, workId: editor.context.workId, choice: 'keep', status: 'completed' }]);
    const replay = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_settle', conversation: id, request: command } })).structuredContent);
    expect(replay.ok).toBe(true); if (!replay.ok) throw new Error('The canonical settlement receipt was refused.'); expect(ConversationPublicSchema.parse(replay.data).conversation).toEqual(settled.conversation); expect(f.app.conversations.ledger(id).events()).toHaveLength(count);
    await f.app.conversations.message(id, { schema: 'conversation-message-v1', clientMessageId: 'later_settlement_parity', text: 'Preserve the newer fixture work.' }); await f.app.conversations.wait(id); const later = await f.app.conversations.view(id), laterCount = f.app.conversations.ledger(id).events().length;
    const oldReplay = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_settle', conversation: id, request: command } })).structuredContent);
    expect(oldReplay.ok).toBe(true); if (!oldReplay.ok) throw new Error('The old settlement receipt was refused.'); expect(ConversationPublicSchema.parse(oldReplay.data).conversation).toEqual(later.conversation); expect(later.conversation.work?.request).toBe('Preserve the newer fixture work.'); expect(f.app.conversations.ledger(id).events()).toHaveLength(laterCount);
    expect(f.git(f.checkout, 'show-ref')).toBe(refs); expect(f.git(f.checkout, 'status', '--porcelain')).toBe(status); expect(f.fake.starts).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('settlement-replay-later-work.png'), fullPage: true });
  } finally { await client?.close().catch(() => undefined); await f.close(); }
});

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
    const submitted = page.waitForRequest(request => request.url() === f.base + '/api/conversations/' + id + '/message-command' && request.method() === 'POST');
    await card.getByRole('button', { name: options[0]!.label, exact: true }).click(); await expect(card).toHaveCount(0); await f.app.conversations.wait(id);
    const command = ConversationMessageCommandSchema.parse((await submitted).postDataJSON());
    const answered = await f.app.conversations.view(id); expect(answered.messages.at(-1)).toMatchObject({ text: options[0]!.label, answer: { stretch: 1, option: 0, label: options[0]!.label } }); expect(answered.controls?.question).toBeNull(); expect(answered.handoffs).toEqual(before.handoffs); expect(f.fake.starts).toHaveLength(1);
    const afterCount = f.app.conversations.ledger(id).events().length;
    const repeated = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_message', conversation: id, request: command } })).structuredContent);
    expect(repeated.ok).toBe(true); if (!repeated.ok) throw new Error('The canonical answer-command retry was refused.');
    const repeatedView = ConversationPublicSchema.parse(repeated.data);
    expect(repeatedView.messages).toEqual(answered.messages); expect(repeatedView.controls).toEqual(answered.controls);
    expect(f.app.conversations.ledger(id).events()).toHaveLength(afterCount); expect(f.fake.starts).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('controls-answer.png'), fullPage: true });
  } finally { await client?.close().catch(() => undefined); await f.close(); }
});

test('CONTROLSWRITEPAR1 browser rename and finish commands match MCP receipts and preserve later work', async ({ page, context }, info) => {
  const f = await projectFixture({ control: true }); let client: Client | undefined;
  try {
    const id = 'control_write_parity';
    await f.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Controls parity', message: 'Preserve the fixture history.', clientMessageId: 'control_parity_first' }); await f.app.conversations.wait(id);
    const separator = f.cookie.indexOf('='); await context.addCookies([{ name: f.cookie.slice(0, separator), value: f.cookie.slice(separator + 1), url: f.base, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(f.base + '/conversations/' + id);
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', '..', 'bin', 'jevellan.mjs'), 'mcp'], cwd: f.checkout,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JEVELLAN_HOME: f.homes.root }, stderr: 'ignore' });
    client = new Client({ name: 'control-write-parity-fixture', version: '1' }); await client.connect(transport);
    await page.getByRole('button', { name: 'Controls parity', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename conversation', exact: true }); await expect(rename).toBeVisible();
    await expect(rename.getByLabel('Title', { exact: true })).toHaveAttribute('maxlength', '200'); await rename.getByLabel('Title', { exact: true }).fill('  Browser renamed  ');
    await page.screenshot({ path: info.outputPath('rename-control-editor.png'), fullPage: true });
    const renamedRequest = page.waitForRequest(request => request.url() === f.base + '/api/conversations/' + id + '/control-command' && request.method() === 'POST');
    await rename.getByRole('button', { name: 'Save title', exact: true }).click(); await expect(rename).toHaveCount(0);
    const renameCommand = ConversationControlCommandSchema.parse((await renamedRequest).postDataJSON()), renamed = await f.app.conversations.view(id), renamedCount = f.app.conversations.ledger(id).events().length;
    expect(renamed.conversation.title).toBe('Browser renamed');
    const renameReplay = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_control', conversation: id, request: renameCommand } })).structuredContent);
    expect(renameReplay.ok).toBe(true); if (!renameReplay.ok) throw new Error('The canonical rename replay was refused.');
    expect(ConversationPublicSchema.parse(renameReplay.data).conversation).toEqual(renamed.conversation); expect(f.app.conversations.ledger(id).events()).toHaveLength(renamedCount);
    await page.locator('summary[aria-label="Conversation menu"]').click(); await page.getByRole('button', { name: 'Finished outside Jevellan', exact: true }).click();
    const finish = page.getByRole('dialog', { name: 'Finished outside Jevellan', exact: true }); await expect(finish).toBeVisible(); await expect(finish.locator('textarea')).toHaveAttribute('maxlength', '2000'); await finish.locator('textarea').fill('  Completed the fixture elsewhere.  ');
    await page.screenshot({ path: info.outputPath('finish-control-editor.png'), fullPage: true });
    const finishedRequest = page.waitForRequest(request => request.url() === f.base + '/api/conversations/' + id + '/control-command' && request.method() === 'POST');
    await finish.getByRole('button', { name: 'Mark finished', exact: true }).click(); await expect(finish).toHaveCount(0); await f.app.conversations.wait(id);
    const finishCommand = ConversationControlCommandSchema.parse((await finishedRequest).postDataJSON()), finished = await f.app.conversations.view(id), finishedCount = f.app.conversations.ledger(id).events().length;
    expect(finished.conversation).toMatchObject({ state: 'done', work: null, outcome: { kind: 'finished-elsewhere', reason: 'Completed the fixture elsewhere.' } });
    const finishReplay = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_control', conversation: id, request: finishCommand } })).structuredContent);
    expect(finishReplay.ok).toBe(true); if (!finishReplay.ok) throw new Error('The canonical finish replay was refused.');
    expect(ConversationPublicSchema.parse(finishReplay.data).conversation).toEqual(finished.conversation); expect(f.app.conversations.ledger(id).events()).toHaveLength(finishedCount);
    await f.app.conversations.message(id, { schema: 'conversation-message-v1', clientMessageId: 'preserve_later_control', text: 'Preserve the later fixture request.' }); await f.app.conversations.wait(id);
    const later = await f.app.conversations.view(id), laterCount = f.app.conversations.ledger(id).events().length;
    const oldReplay = OwnerToolResultSchema.parse((await client.callTool({ name: 'jev', arguments: { action: 'conversation_control', conversation: id, request: finishCommand } })).structuredContent);
    expect(oldReplay.ok).toBe(true); if (!oldReplay.ok) throw new Error('The old canonical finish receipt was refused.');
    expect(ConversationPublicSchema.parse(oldReplay.data).conversation).toEqual(later.conversation); expect(later.conversation.work?.request).toBe('Preserve the later fixture request.'); expect(later.conversation.outcome).toBeUndefined(); expect(f.app.conversations.ledger(id).events()).toHaveLength(laterCount); expect(f.fake.starts).toHaveLength(0);
    await expect(page.getByText('Preserve the later fixture request.', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath('control-replay-later-work.png'), fullPage: true });
  } finally { await client?.close().catch(() => undefined); await f.close(); }
});
