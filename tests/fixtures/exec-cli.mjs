#!/usr/bin/env node
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
send({ type: 'thread.started', thread_id: 'fixture-thread' });
send({ type: 'turn.started' });
send({ type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'fixture read', aggregated_output: '', exit_code: null, status: 'in_progress' } });
if (prompt.includes('WAIT_FOR_INTERRUPT')) await new Promise((resolve) => setTimeout(resolve, 30_000));
send({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'fixture read', aggregated_output: 'fixture', exit_code: 0, status: 'completed' } });
send({ type: 'item.started', item: { id: 'mcp', type: 'mcp_tool_call', server: 'jevellan', tool: 'memory_read', arguments: {}, result: null, error: null, status: 'in_progress' } });
send({ type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', server: 'jevellan', tool: 'memory_read', arguments: {}, result: { content: [{ type: 'text', text: 'fixture memory' }] }, error: null, status: 'completed' } });
send({ type: 'item.completed', item: { id: 'text', type: 'agent_message', text: process.argv.includes('resume') ? 'remembered-fixture' : 'fixture-answer' } });
send({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 3, cached_input_tokens: 2 } });
