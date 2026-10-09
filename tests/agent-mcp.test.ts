import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CursorTranscriptSchema } from '@jevellan/core';
import { AGENT_OPERATIONS, AgentOutputJournalSchema, AgentWatchResultSchema, agentJournalPage, createAgentMcpServer, decodeAgentCursor, emptyAgentJournal, normalizeAgentArguments, outputBlocks, reconcileAgentJournal, watchAgentOutput,
  type AgentApi, type AgentOutputEvent, type AgentSourceEvent, type AgentTarget } from '@jevellan/agent-mcp';
import { agentMcpEnvironment } from '../packages/cli/src/agent-mcp.js';
import { main } from '../packages/cli/src/index.js';

const target: AgentTarget = { kind: 'thread', projectId: 'project_fixture', threadId: 'thread_fixture' };
const transcript = (turns: unknown[]) => CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session: {
  schema: 'cursor-session-v1', id: `codex_${'a'.repeat(32)}`, ownerDeviceId: 'device_fixture', deviceName: 'Fixture', title: 'Test job', cwd: null, project: 'Fixture', state: 'working',
  lastActivityAt: '2026-10-09T12:00:00Z', connected: true, canSteer: false, canSend: false,
}, turns, messages: [], truncated: false, observedAt: '2026-10-09T12:00:00Z' });
const tool = (id: string, name = 'Read', output?: string) => ({ type: 'tool', id, name, input: JSON.stringify({ file: `${id}.ts` }), state: output === undefined ? 'running' : 'completed', ...(output === undefined ? {} : { output }) });
const event = (id: number, kind: AgentOutputEvent['kind'], rest: Partial<AgentOutputEvent> = {}): AgentOutputEvent => ({ schema: 'agent-output-event-v1', id, blockId: `block_${id}`, kind, ...rest });
const api = (events: AgentOutputEvent[] = []): AgentApi => ({
  async call() { throw new Error('Watching must not call a job control.'); }, async isActive() { return true; },
  async events(_target, after, limit) { const page = events.filter(row => row.id > after).slice(0, limit); return { schema: 'agent-event-page-v1', events: page, nextCursor: page.at(-1)?.id ?? after, hasMore: events.length > after + page.length }; },
});

describe('external agent output journals', () => {
  it('keeps native same-tool calls in one area across assistant records, until thinking or a different tool', () => {
    const native = transcript([
      { id: 'record1', role: 'assistant', blocks: [tool('call1', 'Read', 'first')] },
      { id: 'record2', role: 'assistant', blocks: [tool('call2', 'Read', 'second')] },
      { id: 'record3', role: 'assistant', blocks: [{ type: 'thinking', text: 'Check the change.' }, tool('call3', 'Read', 'third'), tool('call4', 'Bash', 'tests passed')] },
    ]);
    const journal = reconcileAgentJournal(emptyAgentJournal(), { transcript: native });
    const grouped = outputBlocks(journal.events);
    expect(grouped.blocks.map(block => [block.type, block.toolName, block.events.length])).toEqual([['tools', 'Read', 2], ['thinking', undefined, 1], ['tools', 'Read', 1], ['tools', 'Bash', 1]]);
    expect(grouped.blocks[0]?.markdown).toContain('first'); expect(grouped.blocks[0]?.markdown).toContain('second');
    expect(JSON.stringify(journal)).not.toContain('record1'); expect(JSON.stringify(journal)).not.toContain('call1"'); expect(JSON.stringify(journal)).not.toContain(native.session.id);
    expect(reconcileAgentJournal(journal, { transcript: native })).toEqual(journal);
  });

  it('persists text deltas and late tool patches once, including after reconstructing the journal', () => {
    const before = transcript([{ id: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }, tool('late1')] }]);
    const first = reconcileAgentJournal(emptyAgentJournal(), { transcript: before });
    const restored = AgentOutputJournalSchema.parse(JSON.parse(JSON.stringify(first)));
    const after = transcript([{ id: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Hello world' }, tool('late1', 'Read', 'completed output')] }]);
    const updated = reconcileAgentJournal(restored, { transcript: after });
    const page = agentJournalPage(updated, first.events.length, 100);
    expect(page.events).toHaveLength(2); expect(page.events[0]).toMatchObject({ kind: 'text', text: ' world', offset: 5 });
    expect(page.events[1]).toMatchObject({ kind: 'tool', replace: true, output: 'completed output', groupId: first.events[1]?.groupId });
    expect(reconcileAgentJournal(updated, { transcript: after })).toEqual(updated);
  });

  it('uses real ordinary-job runtime payloads and updates a tool result in its original area', () => {
    const ledger: AgentSourceEvent[] = [
      { id: 1, turn: 1, type: 'text', data: { type: 'text', delta: 'Working.' } },
      { id: 2, turn: 1, type: 'tool-start', data: { type: 'tool-start', id: 'native-tool-one', name: 'Read', input: { path: 'a.ts' } } },
      { id: 3, turn: 1, type: 'tool-start', data: { type: 'tool-start', id: 'native-tool-two', name: 'Read', input: { path: 'b.ts' } } },
      { id: 4, turn: 1, type: 'thinking', data: { type: 'thinking', delta: 'These files agree.' } },
      { id: 5, turn: 1, type: 'tool-end', data: { type: 'tool-end', id: 'native-tool-one', ok: true, output: 'late output' } },
      { id: 6, turn: 1, type: 'tool-start', data: { type: 'tool-start', id: 'native-tool-three', name: 'Read', input: { path: 'c.ts' } } },
    ];
    const first = reconcileAgentJournal(emptyAgentJournal(), { ledger: ledger.slice(0, 4) });
    const journal = reconcileAgentJournal(AgentOutputJournalSchema.parse(JSON.parse(JSON.stringify(first))), { ledger });
    expect(journal.events.map(row => row.kind)).toEqual(['text', 'tool', 'tool', 'thinking', 'tool', 'tool']);
    expect(journal.events[4]).toMatchObject({ blockId: journal.events[1]?.blockId, groupId: journal.events[1]?.groupId, toolName: 'Read', replace: true, output: 'late output' });
    expect(journal.events[1]?.groupId).toBe(journal.events[2]?.groupId);
    expect(journal.events[5]?.groupId).not.toBe(journal.events[1]?.groupId);
    expect(journal.events[3]?.text).toBe('These files agree.');
  });

  it('does not join tools across user messages and emits explicit replacements for edited text', () => {
    const first = reconcileAgentJournal(emptyAgentJournal(), { transcript: transcript([
      { id: 'a', role: 'assistant', blocks: [tool('t1')] }, { id: 'u', role: 'user', blocks: [{ type: 'text', text: 'Next request' }] },
      { id: 'b', role: 'assistant', blocks: [tool('t2'), { type: 'text', text: 'Initial answer' }] },
    ]) });
    expect(first.events[0]?.groupId).not.toBe(first.events[2]?.groupId);
    const replacement = reconcileAgentJournal(first, { transcript: transcript([{ id: 'b', role: 'assistant', blocks: [tool('t2'), { type: 'text', text: 'Corrected answer' }] }]) });
    expect(replacement.events.at(-1)).toMatchObject({ kind: 'text', text: 'Corrected answer', offset: 0, replace: true });
    expect(() => agentJournalPage(first, 1000, 10)).toThrow('ahead');
  });
});

describe('bounded resumable output watching', () => {
  it('drains pages without gaps or repeats and preserves same-tool grouping across batch boundaries', async () => {
    const provider = api([event(1, 'tool', { toolName: 'Read', input: 'a' }), event(2, 'tool', { toolName: 'Read', input: 'b' }), event(3, 'thinking', { text: 'Think' }), event(4, 'tool', { toolName: 'Read', input: 'c' })]);
    const signal = new AbortController().signal;
    const one = await watchAgentOutput(provider, { target, limit: 1, waitMs: 0 }, signal);
    const two = await watchAgentOutput(provider, { target, cursor: one.cursor, limit: 1, waitMs: 0 }, signal);
    const three = await watchAgentOutput(provider, { target, cursor: two.cursor, limit: 2, waitMs: 0 }, signal);
    expect(one.hasMore).toBe(true); expect(three.hasMore).toBe(false);
    expect([...one.events, ...two.events, ...three.events].map(row => row.id)).toEqual([1, 2, 3, 4]);
    expect(two.blocks[0]).toMatchObject({ id: one.blocks[0]?.id, continuation: true, type: 'tools' });
    expect(three.blocks[1]?.id).not.toBe(one.blocks[0]?.id);
    expect(decodeAgentCursor(three.cursor).after).toBe(4);
    const none = await watchAgentOutput(provider, { target, cursor: three.cursor, limit: 2, waitMs: 0 }, signal);
    expect(none.events).toEqual([]); expect(none.cursor).toBe(three.cursor);
  });
  it('refuses malformed, cross-target and noncontiguous cursors', async () => {
    const signal = new AbortController().signal;
    const first = await watchAgentOutput(api([event(1, 'text', { text: 'A' })]), { target, limit: 1, waitMs: 0 }, signal);
    await expect(watchAgentOutput(api(), { target: { kind: 'project', projectId: target.projectId }, cursor: first.cursor, limit: 1, waitMs: 0 }, signal)).rejects.toThrow('another');
    await expect(watchAgentOutput(api(), { target, cursor: 'invalid', limit: 1, waitMs: 0 }, signal)).rejects.toThrow('invalid');
    await expect(watchAgentOutput(api([event(2, 'text', { text: 'gap' })]), { target, limit: 10, waitMs: 0 }, signal)).rejects.toThrow('history');
  });
  it('streams separate batches with resumable cursors, keeps the aggregate bounded and loses no deltas', async () => {
    const rows = [event(1, 'tool', { toolName: 'Read', input: 'first' })];
    const provider = api(rows); const chunks: Array<{ cursor: string; events: AgentOutputEvent[]; blocks: Array<{ id: string; continuation: boolean }> }> = [];
    setTimeout(() => rows.push(event(2, 'tool', { toolName: 'Read', input: 'second' }), event(3, 'text', { text: 'The next batch.' })), 10);
    const result = await watchAgentOutput(provider, { target, limit: 2, streamMs: 1000 }, new AbortController().signal, async chunk => { chunks.push(chunk); });
    expect(chunks).toHaveLength(2); expect(chunks.map(chunk => decodeAgentCursor(chunk.cursor).after)).toEqual([1, 2]);
    expect(chunks[1]?.blocks[0]).toMatchObject({ id: chunks[0]?.blocks[0]?.id, continuation: true });
    expect(result.events.map(row => row.id)).toEqual([1, 2]); expect(result.hasMore).toBe(true);
    const continued = await watchAgentOutput(provider, { target, cursor: result.cursor }, new AbortController().signal);
    expect(continued.events.map(row => row.id)).toEqual([3]);
  });
  it('can resume from the last delivered streaming cursor after cancellation or revocation', async () => {
    const provider = api([event(1, 'text', { text: 'Received once.' })]); const controller = new AbortController(); let delivered = '';
    await expect(watchAgentOutput(provider, { target, streamMs: 30_000 }, controller.signal, async chunk => { delivered = chunk.cursor; controller.abort(); })).rejects.toThrow();
    expect(decodeAgentCursor(delivered).after).toBe(1);
    const resumed = await watchAgentOutput(provider, { target, cursor: delivered }, new AbortController().signal); expect(resumed.events).toEqual([]);
    let active = true; provider.isActive = async () => active;
    await expect(watchAgentOutput(provider, { target, streamMs: 1000 }, new AbortController().signal, async () => { active = false; })).rejects.toThrow('revoked');
  });
  it('cancels a listener promptly without a job mutation, and checks revocation during waits', async () => {
    const provider = api(); const controller = new AbortController(); let calls = 0;
    provider.events = async (_target, after) => { calls++; return { schema: 'agent-event-page-v1', events: [], nextCursor: after, hasMore: false }; };
    const waiting = watchAgentOutput(provider, { target, limit: 10, waitMs: 30_000 }, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(waiting).rejects.toThrow(); expect(calls).toBe(1);
    let active = true;
    provider.isActive = async () => active;
    provider.events = async (_target, after) => { active = false; return { schema: 'agent-event-page-v1', events: [], nextCursor: after, hasMore: false }; };
    await expect(watchAgentOutput(provider, { target, limit: 10, waitMs: 1000 }, new AbortController().signal)).rejects.toThrow('revoked');
  });
});

describe('external MCP protocol suite', () => {
  it('lists only genuine capabilities, validates caller IDs, supplies resources/prompts and structured organized output', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = api([event(1, 'text', { text: 'Ready.' })]);
    provider.supportedOperations = ['discover', 'thread_start', 'project_read', 'watch'];
    provider.call = async (name, args) => { calls.push({ name, args }); return { schema: 'simulated-owner-result-v1', ok: true }; };
    const server = createAgentMcpServer(provider); const client = new Client({ name: 'external-fixture', version: '1' });
    const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
    try {
      const tools = await client.listTools(); expect(tools.tools.map(row => row.name)).toEqual(['jevellan_discover', 'jevellan_project_read', 'jevellan_thread_start', 'jevellan_watch']);
      const invalid = await client.callTool({ name: 'jevellan_thread_start', arguments: { projectId: 'project_fixture', title: 'Test', task: 'Work' } });
      expect(invalid.isError).toBe(true); expect(calls).toHaveLength(0);
      const started = await client.callTool({ name: 'jevellan_thread_start', arguments: { projectId: 'project_fixture', clientRequestId: 'request_fixture', title: 'Test', task: 'Work', providerId: 'auto', accountId: 'account_fixture', effort: 'high' } });
      expect(started.isError).not.toBe(true); expect(calls[0]?.args).toMatchObject({ providerId: 'auto', accountId: 'account_fixture', effort: 'high' });
      const watched = await client.callTool({ name: 'jevellan_watch', arguments: { target, limit: 1, waitMs: 0 } });
      const result = watched.structuredContent as { data: unknown }; expect(AgentWatchResultSchema.parse(result.data).markdown).toBe('Ready.');
      expect(calls).toHaveLength(1);
      const resources = await client.listResources(); expect(resources.resources.map(row => row.uri)).toContain('jevellan://guide');
      const resource = await client.readResource({ uri: 'jevellan://projects/project_fixture' }); expect(resource.contents[0]).toHaveProperty('mimeType', 'application/json');
      await expect(client.readResource({ uri: 'https://example.test/admin' })).rejects.toThrow();
      expect((await client.listPrompts()).prompts).toHaveLength(2);
      const prompt = await client.getPrompt({ name: 'delegate_project_work', arguments: { projectId: 'project_fixture', task: 'Run the app' } }); expect(prompt.messages).toHaveLength(1);
      expect(AGENT_OPERATIONS.some(row => /daemon|credential|login/u.test(row.name))).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
  it('normalizes provider aliases and auto choices without allowing conflicting providers', () => {
    expect(normalizeAgentArguments({ providerId: 'codex', modelId: 'auto', effort: 'auto', accountId: 'account_fixture', deviceId: 'auto', isolation: 'main', title: 'Auto' })).toEqual({ runtimeId: 'codex', accountId: 'account_fixture', isolation: 'main', title: 'Auto' });
    expect(() => normalizeAgentArguments({ providerId: 'codex', runtimeId: 'claude' })).toThrow('same provider');
  });
  it('uses a separate owner connection environment, keeps tokens off arguments and requires an encrypted remote URL', async () => {
    const token = 'fixture-connection-value-that-is-long-enough';
    expect(agentMcpEnvironment({ JEVELLAN_MCP_URL: 'https://fixture.test/mcp', JEVELLAN_MCP_TOKEN: token }).url.pathname).toBe('/mcp');
    expect(() => agentMcpEnvironment({ JEVELLAN_MCP_URL: 'http://fixture.test/mcp', JEVELLAN_MCP_TOKEN: token })).toThrow('HTTPS');
    expect(() => agentMcpEnvironment({ JEVELLAN_STRETCH_TOKEN: token, JEVELLAN_DAEMON_URL: 'http://localhost:9773' })).toThrow('Settings');
    let served = false; await main(['mcp-server'], { mcpServer: async () => { served = true; } }); expect(served).toBe(true);
    await expect(main(['mcp-server', '--token', token], { mcpServer: async () => undefined })).rejects.toThrow('environment');
  });
});
