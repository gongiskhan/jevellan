import { afterEach, expect, test } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProjectThreadOverrideEditorSchema, ThreadCreatedViewSchema, OWNER_TOOLS, OwnerToolResultSchema, ProjectGoalEditorSchema, ProjectJobEditorSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { reportStep, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close().catch(() => undefined); client = undefined; await f?.close(); f = undefined; });
async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'bin', 'jevellan.mjs'), 'mcp'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, cwd: f!.checkout, stderr: 'ignore' });
  client = new Client({ name: 'contract', version: '1.0.0' }); await client.connect(transport); return client;
}

test('the forwarder lists exactly the twelve tools with their descriptions and forwards calls to the tool route', async () => {
  f = await projectFixture({ control: true });
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const listed = (await mcp.listTools()).tools;
  expect(listed.map(tool => tool.name)).toEqual(['status', 'activity', 'ask_coordinator', 'work', 'goals', 'jobs', 'thread', 'respond', 'override', 'jev', 'config', 'login']);
  for (const tool of OWNER_TOOLS) expect(listed.find(row => row.name === tool.name)?.description).toBe(tool.description);
  expect((listed.find(row => row.name === "work")!.inputSchema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(['list', 'add', 'reorder', 'cancel', 'inspect']);
  expect((listed.find(row => row.name === 'ask_coordinator')!.inputSchema as unknown as { properties: { mode: { enum: string[] } } }).properties.mode.enum).toEqual(['ask', 'tell', 'restart']);
  expect(mcp.getServerCapabilities()?.experimental).toBeUndefined();
  const status = await mcp.callTool({ name: 'status', arguments: {} });
  expect(status.isError).toBeFalsy();
  expect((status.content as Array<{ text: string }>)[0]!.text).toContain('Nothing waiting on you.');
  const refused = await mcp.callTool({ name: 'work', arguments: { action: 'cancel', task: 'T9' } });
  expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: `T9 is not a task or thread of ${f.project.name}.` }] });
  const log = f.app.ownerTools.callerLog();
  expect(log.map(entry => [entry.tool, entry.action, entry.access, entry.ok])).toEqual([['status', 'status', 'read', true], ['work', 'cancel', 'write', false]]);
  expect(log.every(entry => entry.caller.startsWith('session:'))).toBe(true);
});

test('with a role set the forwarder registers zero tools; in the bridge it declares the channel', async () => {
  f = await projectFixture({ control: true });
  const guarded = await connect({ JEVELLAN_HOME: f.homes.root, JEVELLAN_ROLE: 'thread', JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: 'project' });
  expect((await guarded.listTools()).tools).toEqual([]);
  expect(guarded.getServerCapabilities()?.experimental).toBeUndefined();
  await guarded.close(); client = undefined;
  const bridge = await connect({ JEVELLAN_HOME: f.homes.root, JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: f.project.name });
  expect(bridge.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
  expect((await bridge.listTools()).tools).toHaveLength(12);
  await bridge.callTool({ name: 'status', arguments: {} });
  expect(f.app.ownerTools.callerLog().at(-1)?.caller).toBe(`bridge:${f.project.name.replace(/[^A-Za-z0-9._-]/gu, '_')}`);
});

test('a forwarder without a running service says so in one sentence', async () => {
  f = await projectFixture();
  const mcp = await connect({ JEVELLAN_HOME: join(f.root, 'nowhere') });
  const result = await mcp.callTool({ name: 'status', arguments: {} });
  expect(result).toMatchObject({ isError: true, content: [{ text: 'Jevellan is not running on this device (no installation control file).' }] });
});

test('editor request templates survive the official MCP transport and create one retry-safe definition', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const read = await mcp.callTool({ name: 'jobs', arguments: { action: 'editor', kind: 'job' } });
  expect(read.isError).toBeFalsy();
  const result = OwnerToolResultSchema.parse(read.structuredContent); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected the editor model.');
  const view = ProjectJobEditorSchema.parse(result.data);
  expect((read.content as Array<{ text: string }>).some(item => item.text.includes('"schema":"project-job-editor-v1"'))).toBe(true);
  const request = { ...view.request.base, fields: { ...view.defaults, name: 'MCP editor fixture', command: 'true', enabled: false } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const saved = await mcp.callTool({ name: 'jobs', arguments: { action: 'save', request } });
    expect(saved.isError).toBeFalsy();
    expect(OwnerToolResultSchema.parse(saved.structuredContent)).toMatchObject({ ok: true, data: { name: 'MCP editor fixture', enabled: false } });
  }
  expect((await f.app.projectWork.daily.jobs('project')).map(job => job.name)).toEqual(['MCP editor fixture']);
});

test.each(['list', 'night'])('the official MCP transport preserves the shared jobs projection for %s', async action => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const answer = await mcp.callTool({ name: 'jobs', arguments: { action } }); expect(answer.isError).toBeFalsy();
  expect(OwnerToolResultSchema.parse(answer.structuredContent)).toMatchObject({ ok: true, data: { schema: 'project-jobs-view-v1', projectId: 'project' } });
  expect((answer.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"project-jobs-view-v1"'))).toBe(true);
});


test('goal models and retry-safe editor saves reach the official MCP client', async () => {
  f = await projectFixture({ control: true }); const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const read = await mcp.callTool({ name: 'goals', arguments: { action: 'editor' } });
  const result = OwnerToolResultSchema.parse(read.structuredContent); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected the goal editor.');
  const view = ProjectGoalEditorSchema.parse(result.data), request = { ...view.request.base, fields: { ...view.defaults, name: 'MCP goal fixture', motivation: 'Shared goal transport.' } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const saved = await mcp.callTool({ name: 'goals', arguments: { action: 'save', request } });
    expect(saved.isError).toBeFalsy(); expect(OwnerToolResultSchema.parse(saved.structuredContent)).toMatchObject({ ok: true, data: { goal: { name: 'MCP goal fixture', openPrCap: 2 } } });
  }
  expect((await f.app.projectWork.goalList('project')).goals).toHaveLength(1);
  const listed = await mcp.callTool({ name: 'goals', arguments: { action: 'list' } });
  expect(OwnerToolResultSchema.parse(listed.structuredContent)).toMatchObject({ ok: true, data: { schema: 'project-goal-views-v1', projectId: 'project', rows: [{ name: 'MCP goal fixture' }] } });
  expect((listed.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"project-goal-views-v1"'))).toBe(true);
});


test('the official MCP transport preserves the shared thread placement explanation', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'MCP explanation fixture.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'mcp_why', title: 'MCP explanation', task: 'Inspect the simulated fixture.' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle');
  const ui = await (await f.request(`/api/projects/project/threads/${made.threadId}/why-view`)).json(), mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const result = await mcp.callTool({ name: 'jev', arguments: { action: 'why', thread: made.threadId } }); expect(result.isError).toBeFalsy();
  expect(OwnerToolResultSchema.parse(result.structuredContent)).toMatchObject({ ok: true, data: ui });
  expect((result.content as Array<{ text: string }>).some(row => row.text.includes('"schema":"project-thread-why-view-v1"'))).toBe(true);
});


test('the official MCP editor previews and saves a next-turn override through the canonical writer', async () => {
  f = await projectFixture({ control: true }); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'MCP override editor.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'mcp_override_editor', title: 'MCP override editor', task: 'Inspect the simulated fixture.', effort: 'medium' });
  await f.waitFor(() => f!.thread(made.threadId), row => row.state === 'idle');
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root }), read = await mcp.callTool({ name: 'jev', arguments: { action: 'override_editor', thread: made.threadId } });
  const result = OwnerToolResultSchema.parse(read.structuredContent); expect(result.ok).toBe(true); if (!result.ok) throw new Error('Expected the override editor.');
  const editor = ProjectThreadOverrideEditorSchema.parse(result.data); expect(editor.fields.effort).toBe('medium');
  const previewed = await mcp.callTool({ name: 'jev', arguments: { action: 'override_preview', thread: made.threadId, request: { schema: 'thread-override-editor-preview-request-v1', changed: 'effort', fields: { ...editor.fields, effort: 'high' } } } });
  const previewResult = OwnerToolResultSchema.parse(previewed.structuredContent); expect(previewResult.ok).toBe(true); if (!previewResult.ok) throw new Error('Expected the preview.');
  const preview = ProjectThreadOverrideEditorSchema.parse(previewResult.data); expect(preview.apply.enabled).toBe(true);
  const request = { ...editor.request.base, fields: preview.fields };
  for (let attempt = 0; attempt < 2; attempt++) expect(OwnerToolResultSchema.parse((await mcp.callTool({ name: 'jev', arguments: { action: 'override_save', thread: made.threadId, request } })).structuredContent)).toMatchObject({ ok: true, data: { schema: 'thread-override-view-v1' } });
  expect(await f.app.projectHub.recentOverrides('project', 8)).toHaveLength(1);
  expect(f.thread(made.threadId).placement.effortRequested).toBe('high');
});
