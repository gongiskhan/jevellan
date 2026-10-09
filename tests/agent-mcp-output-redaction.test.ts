import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CursorTranscriptSchema, Homes, ProjectSchema, SecretRedactor } from '@jevellan/core';
import { AgentOutputJournalSchema, AgentWatchResultSchema, agentJournalPage, emptyAgentJournal, outputBlocks, reconcileAgentJournal, watchAgentOutput,
  type AgentApi, type AgentOutputEvent, type AgentSourceEvent, type AgentTarget } from '@jevellan/agent-mcp';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

const credential = ['fixture-credential-value-', 'composed-across-two-events'].join('');
const lead = credential.slice(0, 24);
const tail = credential.slice(24);
const target: AgentTarget = { kind: 'project', projectId: 'project_fixture' };
const redactor = () => { const result = new SecretRedactor(); result.add(credential); return result; };
const row = (id: number, delta: string, type = 'text'): AgentSourceEvent => ({ id, turn: 1, type, data: { type, delta } });
const native = (text: string, thinking: string, input: string, output?: string) => CursorTranscriptSchema.parse({
  schema: 'cursor-transcript-v1', session: { schema: 'cursor-session-v1', id: `codex_${'b'.repeat(32)}`, ownerDeviceId: 'device_fixture', deviceName: 'Fixture', title: 'Output fixture', cwd: null,
    project: 'Fixture', state: 'working', lastActivityAt: '2026-10-09T12:00:00Z', connected: true, canSteer: false, canSend: false },
  turns: [{ id: 'native-record', role: 'assistant', blocks: [{ type: 'text', text }, { type: 'thinking', text: thinking },
    { type: 'tool', id: 'native-call', name: 'Read', input, ...(output === undefined ? {} : { output }), state: output === undefined ? 'running' : 'completed' }] }],
  messages: [], truncated: false, observedAt: '2026-10-09T12:00:00Z',
});
const exposed = (events: readonly AgentOutputEvent[]) => events.map(event => event.text ?? '').join('');
function safe(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(credential);
  expect(JSON.stringify(value)).not.toContain(lead);
}

describe('credential-safe external output', () => {
  it('withholds unresolved registered credentials before storing or paging while safe Unicode streams immediately', () => {
    const filter = redactor(); const prefix = 'Safe 😀 '; const ledger = [row(1, prefix + lead)];
    const first = reconcileAgentJournal(emptyAgentJournal(), { ledger, redactor: filter });
    safe(first); expect(first.events).toHaveLength(1); expect(first.events[0]?.text).toBe(prefix);
    const restored = AgentOutputJournalSchema.parse(JSON.parse(JSON.stringify(first)));
    ledger.push(row(2, tail + ' complete.'));
    const second = reconcileAgentJournal(restored, { ledger, redactor: filter });
    safe(second); expect(exposed(second.events)).toBe(prefix + '[redacted] complete.');
    expect(second.events[1]).toMatchObject({ text: '[redacted] complete.', offset: prefix.length, blockId: first.events[0]?.blockId, groupId: first.events[0]?.groupId });
    const one = agentJournalPage(second, 0, 1); const two = agentJournalPage(second, one.nextCursor, 1);
    safe(one); safe(two); expect(exposed([...one.events, ...two.events])).not.toContain(credential);
    expect(outputBlocks(second.events).blocks[0]?.markdown).toBe(prefix + '[redacted] complete.');
    expect(reconcileAgentJournal(second, { ledger, redactor: filter })).toEqual(second);
  });

  it('protects thinking and cumulative native text, tool input and late output patches before exposing their prefixes', () => {
    const filter = redactor(); const firstInput = { transcript: native('Answer ' + lead, 'Thinking ' + lead, 'Input ' + lead, 'Output ' + lead), redactor: filter };
    const first = reconcileAgentJournal(emptyAgentJournal(), firstInput); safe(first);
    expect(first.events.map(event => event.kind)).toEqual(['text', 'thinking', 'tool']);
    expect(first.events[0]?.text).toBe('Answer '); expect(first.events[1]?.text).toBe('Thinking ');
    expect(first.events[2]).toMatchObject({ input: 'Input ', output: 'Output ' });
    const secondInput = { transcript: native('Answer ' + credential, 'Thinking ' + credential, 'Input ' + credential, 'Output ' + credential), redactor: filter };
    const second = reconcileAgentJournal(AgentOutputJournalSchema.parse(JSON.parse(JSON.stringify(first))), secondInput); safe(second);
    expect(second.events.slice(3).map(event => event.kind)).toEqual(['text', 'thinking', 'tool']);
    expect(second.events[3]).toMatchObject({ text: '[redacted]', offset: 7, blockId: first.events[0]?.blockId });
    expect(second.events[4]).toMatchObject({ text: '[redacted]', offset: 9, blockId: first.events[1]?.blockId });
    expect(second.events[5]).toMatchObject({ input: 'Input [redacted]', output: 'Output [redacted]', replace: true, groupId: first.events[2]?.groupId });
  });

  it('protects progress before cancellation and resolves a held prefix after reconnecting from its durable cursor', async () => {
    const filter = redactor(); const ledger = [row(1, 'Received 😀 ' + lead, 'thinking')]; let stored = emptyAgentJournal();
    const provider: AgentApi = { async call() { throw new Error('Watching cannot mutate work.'); }, async isActive() { return true; },
      async events(_target, after, limit) { stored = reconcileAgentJournal(stored, { ledger, redactor: filter }); return agentJournalPage(stored, after, limit); } };
    const controller = new AbortController(); let cursor = ''; const delivered: unknown[] = [];
    await expect(watchAgentOutput(provider, { target, streamMs: 30_000 }, controller.signal, async chunk => {
      safe(chunk); delivered.push(chunk); cursor = chunk.cursor; controller.abort();
    })).rejects.toThrow();
    safe(stored); stored = AgentOutputJournalSchema.parse(JSON.parse(JSON.stringify(stored)));
    ledger.push(row(2, tail + ' Done.', 'thinking'));
    const resumed = await watchAgentOutput(provider, { target, cursor, limit: 1 }, new AbortController().signal, async chunk => { safe(chunk); delivered.push(chunk); });
    safe(resumed); safe(delivered); expect(resumed.events[0]?.text).toBe('[redacted] Done.');
    expect(resumed.blocks[0]).toMatchObject({ type: 'thinking', continuation: true });
    expect(exposed(stored.events)).toBe('Received 😀 [redacted] Done.');
  });

  it('keeps same-tool grouping, replaces edited text and holds incomplete UTF-16 pairs until the next snapshot', () => {
    const filter = redactor();
    const first = reconcileAgentJournal(emptyAgentJournal(), { transcript: native('Safe \uD83D', '', 'Safe input'), redactor: filter });
    expect(first.events[0]?.text).toBe('Safe ');
    const second = reconcileAgentJournal(first, { transcript: native('Safe 😀 done.', '', 'Safe input'), redactor: filter });
    expect(second.events.at(-1)).toMatchObject({ text: '😀 done.', offset: 5 });
    const edited = reconcileAgentJournal(second, { transcript: native('Corrected answer.', '', 'Safe input'), redactor: filter });
    expect(edited.events.at(-1)).toMatchObject({ text: 'Corrected answer.', offset: 0, replace: true });
    expect(outputBlocks(edited.events).blocks[0]?.markdown).toBe('Corrected answer.');
    const tools: AgentSourceEvent[] = [
      { id: 1, type: 'tool-start', turn: 1, data: { id: 'first', name: 'Read', input: 'Input ' + lead } },
      { id: 2, type: 'tool-start', turn: 1, data: { id: 'second', name: 'Read', input: 'Safe input' } },
      row(3, 'Break the tool group.', 'thinking'),
      { id: 4, type: 'tool-end', turn: 1, data: { id: 'first', output: 'Output ' + lead, ok: true } },
    ];
    const toolJournal = reconcileAgentJournal(emptyAgentJournal(), { ledger: tools, redactor: filter }); safe(toolJournal);
    expect(toolJournal.events[0]?.groupId).toBe(toolJournal.events[1]?.groupId);
    expect(toolJournal.events[3]).toMatchObject({ groupId: toolJournal.events[0]?.groupId, blockId: toolJournal.events[0]?.blockId, replace: true, output: 'Output ' });
    expect(outputBlocks(toolJournal.events).blocks.map(block => block.type)).toEqual(['tools', 'thinking']);
  });

  it('holds every split of pattern credentials, masks complete values and does not cut through overlapping registered secrets', () => {
    const filter = new SecretRedactor();
    for (const token of ['sk-' + 'A'.repeat(32), 'ghp_' + 'B'.repeat(32), 'github_pat_' + 'C'.repeat(32),
      'jva_fixture.' + 'D'.repeat(43), 'eyJ' + 'E'.repeat(16) + '.' + 'F'.repeat(16) + '.' + 'G'.repeat(16), 'Bearer ' + 'H'.repeat(32)]) {
      for (let split = 1; split < token.length; split++) {
        const first = filter.streamText('Safe ' + token.slice(0, split)); const complete = filter.streamText('Safe ' + token);
        expect(first + complete).not.toContain(token);
        expect(complete).toContain('[redacted]');
      }
    }
    filter.add('ababa'); expect(filter.streamText('Safe ababa')).toBe('Safe [redacted]');
    expect(filter.streamText('Safe ab')).toBe('Safe '); expect(filter.streamText('Safe abroad.')).toBe('Safe abroad.');
  });

  it('protects quoted and escaped JSON values in cumulative tool snapshots and keeps safe formatting', () => {
    const filter = redactor(); const input = JSON.stringify({ credential: lead, [lead]: 'Safe key value.', safe: '😀 done.' }, null, 2);
    const first = reconcileAgentJournal(emptyAgentJournal(), { transcript: native('Answer.', 'Check.', input, input), redactor: filter }); safe(first);
    const before = first.events.find(event => event.kind === 'tool');
    expect(JSON.parse(before!.input!)).toEqual({ credential: '', '': 'Safe key value.', safe: '😀 done.' });
    expect(before?.input).toContain('\n  "safe": "😀 done."');
    const complete = JSON.stringify({ credential, [credential]: 'Safe key value.', safe: '😀 done.' }, null, 2);
    const second = reconcileAgentJournal(first, { transcript: native('Answer.', 'Check.', complete, complete), redactor: filter }); safe(second);
    const patch = second.events.at(-1); expect(patch).toMatchObject({ kind: 'tool', replace: true, blockId: before?.blockId });
    expect(JSON.parse(patch!.output!)).toEqual({ credential: '[redacted]', '[redacted]': 'Safe key value.', safe: '😀 done.' });
    const escaped = lead.split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    expect(filter.streamToolText(`{"credential":"${escaped}"}`)).toBe('{"credential":""}');
    expect(filter.streamToolText(`{"credential":"${escaped.slice(0, -2)}`)).toBe('{"credential":');
  });
});

it('actual HTTP progress, canceled reconnects and daemon restarts publish only safe journals and pointer payloads', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-agent-output-')); mkdirSync(join(root, 'user')); mkdirSync(join(root, 'project'));
  execFileSync('git', ['init', '-b', 'main', join(root, 'project')], { stdio: 'ignore' });
  const homes = new Homes(join(root, 'data'), join(root, 'user'));
  let app!: Application; let server!: Server; let base = ''; let external: Client | undefined;
  const start = async () => {
    app = new Application({ homes, timers: false, runtimes: () => new Map() }); await app.started;
    server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const shutdown = async () => { await external?.close(); external = undefined; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); };
  const connect = async (token: string) => {
    external = new Client({ name: 'safe-output-fixture', version: '1' });
    await external.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as Transport);
    return external;
  };
  try {
    await start();
    app.hub.put('projects', target.projectId, ProjectSchema, { schema: 'project-v1', id: target.projectId, name: 'Output fixture', paths: { [app.device.deviceId]: join(root, 'project') },
      branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
    app.hub.vault.put('fixture-output', credential);
    const issued = await app.agentAccess.create({ schema: 'agent-access-create-v1', clientRequestId: 'fixture_connection', label: 'Output fixture', projectIds: [target.projectId] }, 'fixture_owner');
    const connected = await connect(issued.token!); let ledger = app.projectWork.coordinatorLedger(target.projectId);
    ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'First 😀 ' + lead } });
    const controller = new AbortController(); let cursor = ''; const progress: unknown[] = [];
    await expect(connected.callTool({ name: 'jevellan_watch', arguments: { target, streamMs: 30_000 } }, undefined, { signal: controller.signal,
      onprogress: message => {
        safe(message); const meta = (message as { _meta?: Record<string, unknown> })._meta;
        const chunk = AgentWatchResultSchema.parse(meta?.['jevellan/output']); progress.push(chunk); cursor = chunk.cursor; controller.abort();
      } })).rejects.toThrow();
    expect(progress).toHaveLength(1); expect(cursor).not.toBe('');
    const journalFile = app.homes.at('agent-output', readdirSync(app.homes.at('agent-output'))[0]!); safe(JSON.parse(readFileSync(journalFile, 'utf8')));
    // Restart restores the redaction registry directly from encrypted envelopes, before any new launch.
    await shutdown(); await start();
    const restarted = await connect(issued.token!); ledger = app.projectWork.coordinatorLedger(target.projectId);
    ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: tail + ' Done.' } });
    const resumed = await restarted.callTool({ name: 'jevellan_watch', arguments: { target, cursor, limit: 1 } }); safe(resumed); expect(resumed.isError).not.toBe(true);
    const result = AgentWatchResultSchema.parse((resumed.structuredContent as { data: unknown }).data);
    expect(result.events[0]).toMatchObject({ text: '[redacted] Done.', offset: 'First 😀 '.length });
    const empty = await restarted.callTool({ name: 'jevellan_watch', arguments: { target, cursor: result.cursor } });
    expect(AgentWatchResultSchema.parse((empty.structuredContent as { data: unknown }).data).events).toEqual([]);
    safe(progress); safe(JSON.parse(readFileSync(journalFile, 'utf8')));
    await app.conversations.create({ schema: 'start-conversation-v1', id: 'job_fixture', projectId: target.projectId, title: 'Pointer fixture', message: 'Keep ' + lead, clientMessageId: 'initial_message' });
    const job = await restarted.callTool({ name: 'jevellan_job_read', arguments: { conversationId: 'job_fixture' } }); safe(job); expect(job.isError).not.toBe(true);
    const source = app.conversations.ledger('job_fixture'); const first = source.append({ type: 'text', data: { type: 'text', delta: lead } });
    const second = source.append({ type: 'text', data: { type: 'text', delta: tail } });
    const blob = source.putBlob([{ type: 'text', delta: lead }, { type: 'text', delta: tail },
      { type: 'tool-start', input: { value: lead, id: lead } }, { type: 'tool-end', output: { value: tail, id: tail } }]); const received: unknown[] = [];
    const opaque = [lead, tail].map(fragment => source.putBlob({ value: fragment, id: fragment, customId: fragment,
      nested: { value: fragment }, array: [fragment], [fragment]: 'Safe value.' }));
    for (const pointer of [`ledger/${first.id}`, `ledger/${second.id}`, blob.ref, ...opaque.map(entry => entry.ref)]) {
      const read = await restarted.callTool({ name: 'jevellan_job_read_pointer', arguments: { conversationId: 'job_fixture', pointer } });
      expect(read.isError).not.toBe(true); safe(read); received.push((read.structuredContent as { data: unknown }).data);
    }
    safe(received); expect(JSON.stringify(received)).not.toContain(credential);
    const legacy = { ...JSON.parse(readFileSync(journalFile, 'utf8')) as Record<string, unknown>, schema: 'agent-output-journal-v1' };
    writeFileSync(journalFile, JSON.stringify(legacy));
    const refused = await restarted.callTool({ name: 'jevellan_watch', arguments: { target, cursor: result.cursor } }); expect(refused.isError).toBe(true); expect(JSON.stringify(refused)).toContain('upgraded');
    const reset = await restarted.callTool({ name: 'jevellan_watch', arguments: { target } }); expect(reset.isError).not.toBe(true); safe(reset);
    expect(AgentOutputJournalSchema.parse(JSON.parse(readFileSync(journalFile, 'utf8'))).schema).toBe('agent-output-journal-v2');
  } finally { if (app) await shutdown(); await rm(root, { recursive: true, force: true }); }
});
