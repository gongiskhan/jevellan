import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConversationStartRequestSchema, ConversationStartResultSchema, OwnerToolResultSchema } from '../../packages/core/dist/index.js';
import { projectFixture } from '../helpers/project-fixture.js';
import { expect, test } from './fixtures.js';

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
    expect(f.app.conversations.ledger(id).events()).toHaveLength(events);
    expect((await f.app.conversations.list()).conversations).toHaveLength(1); expect(f.fake.starts).toHaveLength(0);
    await expect(page.locator('.manual-picker')).toBeVisible();
    await page.screenshot({ path: info.outputPath('canonical-creation-parity.png'), fullPage: true });
  } finally { await client?.close(); await f.close(); }
});
