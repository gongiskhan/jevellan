import { afterEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { join } from 'node:path';
import { ConversationPublicSchema } from '../packages/core/dist/index.js';
import { AgentApiAdapter } from '../apps/daemon/dist/agent-api.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close(); client = undefined; await fixture?.close(); fixture = undefined; });

async function scopedJobAgent(f: ProjectFixture, projectId: string, clientRequestId: string) {
  const issued = await f.app.agentAccess.create({ schema: 'agent-access-create-v1', clientRequestId, label: clientRequestId, projectIds: [projectId] }, f.cookie.slice(f.cookie.indexOf('=') + 1));
  const authorization = `Bearer ${issued.token}`;
  const grant = await f.app.agentAccess.authenticateBearer(authorization);
  if (!grant) throw new Error('The disposable agent connection was not authenticated.');
  return new AgentApiAdapter(f.app, grant, authorization);
}

function pauseConcurrentAccountValidation(f: ProjectFixture) {
  const actual = f.app.accounts.list.bind(f.app.accounts); let calls = 0; let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.app.accounts, 'list').mockImplementation(async () => {
    if (++calls <= 2) { if (calls === 2) release(); await both; }
    return actual();
  });
}

test.each(['project', 'request', 'message', 'choices'] as const)('concurrent scoped job creation rejects a conflicting %s before changing the first work', { timeout: 120_000 }, async conflict => {
  const f = fixture = await projectFixture({ branchPolicy: 'external' });
  const otherCheckout = join(f.root, 'other-project'); f.git(f.root, 'clone', f.origin, otherCheckout);
  await f.app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: { ...f.project, id: 'other_project', name: 'Other project', paths: { [f.app.device.deviceId]: otherCheckout } } });
  const first = { projectId: 'project', conversationId: 'shared_job', clientRequestId: 'create_job', title: 'First title', message: 'Request from the first agent.', effort: 'high' };
  const second = { ...first, ...(conflict === 'project' ? { projectId: 'other_project', clientRequestId: 'create_other', message: 'Request from the other project.' }
    : conflict === 'request' ? { clientRequestId: 'create_other' } : conflict === 'message' ? { message: 'A different request.' } : { effort: 'medium' }) };
  const agents = await Promise.all([scopedJobAgent(f, first.projectId, 'first_connection'), scopedJobAgent(f, second.projectId, 'second_connection')]);
  const scheduling = vi.spyOn(f.app.conversations.options, 'jevAvailable');
  pauseConcurrentAccountValidation(f);
  const results = await Promise.allSettled(agents.map((agent, i) => agent.call('job_start', i === 0 ? first : second, new AbortController().signal)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected'); expect(rejected).toMatchObject({ reason: { status: 409 } });
  const winner = results.findIndex(result => result.status === 'fulfilled'); const request = winner === 0 ? first : second;
  const stored = await f.app.conversations.view(first.conversationId);
  expect(stored.conversation.projectId).toBe(request.projectId);
  expect(stored.messages.map(message => ({ clientMessageId: message.clientMessageId, text: message.text }))).toEqual([{ clientMessageId: request.clientRequestId, text: request.message }]);
  expect(stored.composerOverrides).toHaveLength(1); expect(stored.composerOverrides[0]?.request.value).toBe(request.effort);
  expect(scheduling).toHaveBeenCalledTimes(1);
  if (conflict === 'project') {
    const loser = agents[winner === 0 ? 1 : 0]!;
    await expect(loser.call('job_read', { conversationId: first.conversationId }, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    await expect(loser.call('job_send', { conversationId: first.conversationId, clientMessageId: 'unauthorized_followup', text: 'Do not append this message.' }, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect((await f.app.conversations.view(first.conversationId)).messages).toHaveLength(1);
  }
});

test('concurrent identical scoped job creation keeps one message, initial choice and scheduling attempt', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture({ branchPolicy: 'external' });
  const agents = await Promise.all([scopedJobAgent(f, 'project', 'first_connection'), scopedJobAgent(f, 'project', 'second_connection')]);
  const request = { projectId: 'project', conversationId: 'shared_job', clientRequestId: 'create_job', title: 'Original title', message: 'Explain the project.', effort: 'high' };
  const scheduling = vi.spyOn(f.app.conversations.options, 'jevAvailable');
  pauseConcurrentAccountValidation(f);
  const results = await Promise.all(agents.map(agent => agent.call('job_start', request, new AbortController().signal)));
  const views = results.map(result => ConversationPublicSchema.parse(result));
  expect(views.map(view => view.conversation.work?.id)).toEqual([views[0]!.conversation.work!.id, views[0]!.conversation.work!.id]);
  expect(views.every(view => view.messages.length === 1 && view.composerOverrides.length === 1)).toBe(true);
  const ledger = f.app.conversations.ledger(request.conversationId);
  expect(ledger.events().filter(event => event.type === 'notice' && (ledger.data(event) as { schema?: string }).schema === 'start-composer-choices-v1')).toHaveLength(1);
  expect(scheduling).toHaveBeenCalledTimes(1);
  const repeated = ConversationPublicSchema.parse(await agents[0]!.call('job_start', { ...request, title: 'Retry title' }, new AbortController().signal));
  expect(repeated.conversation.title).toBe(request.title); expect(repeated.conversation.work?.id).toBe(views[0]!.conversation.work!.id);
  expect(repeated.messages).toHaveLength(1); expect(repeated.composerOverrides).toHaveLength(1); expect(scheduling).toHaveBeenCalledTimes(1);
});

test('an external MCP agent starts a guarded project job and reads its native output/report through a resumable watch', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  const before = f.git(f.checkout, 'rev-parse', 'HEAD');
  f.fake.enqueueTurn(async turn => {
    turn.say('Inspected the seed project. Nothing needs changing.');
    const report = { status: 'done', summary: 'Seed project inspected; no changes requested.' };
    await turn.bridge('jevellan_thread_report', report);
    await turn.bridge('jevellan_thread_report', report);
    return { status: 'completed' };
  }, forThread());
  const issued = await f.app.agentAccess.create({ schema: 'agent-access-create-v1', clientRequestId: 'outside_agent', label: 'External integration agent', projectIds: ['project'] }, f.cookie.slice(f.cookie.indexOf('=') + 1));
  client = new Client({ name: 'fixture-external-agent', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}` } } }) as Transport);
  const arguments_ = { projectId: 'project', clientRequestId: 'inspect_seed', title: 'Inspect seed project', task: 'Inspect the project; do not change files.', providerId: 'fake', accountId: 'acc_fixture', modelId: 'fixture', effort: 'high', isolation: 'worktree' };
  const started = await client.callTool({ name: 'jevellan_thread_start', arguments: arguments_ }); expect(started.isError).not.toBe(true);
  const id = (started.structuredContent as { data: { threadId: string } }).data.threadId;
  await f.waitFor(() => f.thread(id).state, state => state === 'done');
  await f.app.projectWork.idle('project');
  const repeated = await client.callTool({ name: 'jevellan_thread_start', arguments: arguments_ }); expect((repeated.structuredContent as { data: { threadId: string } }).data.threadId).toBe(id);
  expect(f.fake.turnStarts.filter(input => input.owner.kind === 'thread')).toHaveLength(1);
  const read = await client.callTool({ name: 'jevellan_thread_read', arguments: { projectId: 'project', threadId: id } }); expect(read.isError).not.toBe(true); expect(JSON.stringify(read)).toContain('Seed project inspected; no changes requested.');
  const watched = await client.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'thread', projectId: 'project', threadId: id }, limit: 200 } }); expect(watched.isError).not.toBe(true);
  const data = (watched.structuredContent as { data: { cursor: string; markdown: string; blocks: Array<{ type: string; toolName?: string; events: unknown[] }> } }).data;
  expect(data.markdown).toContain('Inspected the seed project.');
  expect(data.blocks.some(block => block.type === 'tools' && block.toolName?.includes('jevellan_thread_report') && block.events.length === 2)).toBe(true);
  const empty = await client.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'thread', projectId: 'project', threadId: id }, cursor: data.cursor } }); expect((empty.structuredContent as { data: { events: unknown[] } }).data.events).toEqual([]);
  for (const run of f.fake.runs) if (run.native.sessionId) expect(JSON.stringify([read, watched])).not.toContain(run.native.sessionId);
  expect(JSON.stringify([started, read, watched])).not.toContain(issued.token); expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(before); expect(f.git(f.checkout, 'status', '--porcelain')).toBe('');
});
