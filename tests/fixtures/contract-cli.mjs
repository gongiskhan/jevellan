import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';

// A protocol peer for the real SDKs. It never invokes a provider or executes a
// requested tool command. Only the adapter's hook and fixture MCP are executed.
const args = process.argv.slice(2);
const codex = args[0] === 'exec';
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const session = '22222222-2222-4222-8222-222222222222';
const callbackReplies = new Map();
let initialize; let finishWaiting;
const configuration = codex ? parse(args.flatMap((arg, i) => arg === '--config' ? [args[i + 1]] : []).join('\n')) : {};
function flag(name) { const at = args.indexOf(name); return at < 0 ? args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) : args[at + 1]; }
function result(text = 'fixture-answer') {
  if (codex) {
    send({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } });
    send({ type: 'turn.completed', usage: { input_tokens: 13, output_tokens: 7, cached_input_tokens: 2 } });
  } else {
    send({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: text, modelUsage: { fixture: { inputTokens: 13, outputTokens: 7, cacheReadInputTokens: 2, cacheCreationInputTokens: 0, costUSD: 0, costBasis: 'unknown' } } });
  }
}
function toolStart(name, input) {
  if (codex) send({ type: 'item.started', item: name === 'memory_read' ? { id: 'tool', type: 'mcp_tool_call', server: 'jevellan', tool: name, arguments: input, result: null, error: null, status: 'in_progress' } : { id: 'tool', type: 'command_execution', command: JSON.stringify(input), aggregated_output: '', exit_code: null, status: 'in_progress' } });
  else send({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 'tool', name: name === 'memory_read' ? 'mcp__jevellan__memory_read' : name, input }] } });
}
function toolEnd(name, text) {
  if (codex) send({ type: 'item.completed', item: name === 'memory_read' ? { id: 'tool', type: 'mcp_tool_call', server: 'jevellan', tool: name, arguments: {}, result: { content: [{ type: 'text', text }] }, error: null, status: 'completed' } : { id: 'tool', type: 'command_execution', command: 'fixture read', aggregated_output: text, exit_code: 0, status: 'completed' } });
  else send({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: text, is_error: false }] } });
}
async function memory() {
  const server = codex ? configuration.mcp_servers?.jevellan : JSON.parse(flag('--mcp-config') ?? '{}').mcpServers?.jevellan;
  if (!server) throw new Error('No per-launch bridge was configured.');
  const child = spawn(server.command, server.args, { env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture MCP timed out.')), 5000);
      child.on('error', reject);
      lines.on('line', (line) => {
        const response = JSON.parse(line);
        if (response.id === 2) { clearTimeout(timer); resolve(response.result.content[0].text); }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_read', arguments: {} } })}\n`);
    });
  } finally { lines.close(); child.stdin.end(); child.kill(); }
}
async function hook(tool_name, tool_input) {
  const input = { hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: process.cwd(), session_id: session, transcript_path: '', permission_mode: 'bypassPermissions' };
  if (codex) {
    if (!args.includes('--dangerously-bypass-hook-trust')) throw new Error('The configured hook was not enabled for this invocation.');
    const command = configuration.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    if (!command) throw new Error('No per-launch Safety hook.');
    const child = spawn('/bin/sh', ['-c', command], { env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
    const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Hook failed.'))); });
    child.stdin.end(JSON.stringify(input)); return completion;
  }
  const id = `callback-${callbackReplies.size}-${Date.now()}`;
  const callback_id = initialize.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
  if (!callback_id) throw new Error('No registered SDK permission hook.');
  const response = new Promise((resolve) => { callbackReplies.set(id, resolve); });
  send({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id, input, tool_use_id: 'tool' } });
  return response;
}
async function lifecycle(event) {
  if (!codex && !flag('--setting-sources')?.split(',').includes('user')) throw new Error('The account settings source was not enabled.');
  const file = join(process.env[codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], codex ? 'hooks.json' : 'settings.json');
  const groups = JSON.parse(readFileSync(file, 'utf8')).hooks?.[event];
  if (!groups?.length) throw new Error('No account lifecycle hook.');
  const replies = [];
  for (const group of groups) for (const entry of group.hooks) {
    const child = spawn('/bin/sh', ['-c', entry.command], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
    const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => code === 0 && !errors ? resolve(JSON.parse(output)) : reject(new Error('Account hook failed.'))); });
    child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: process.cwd(), session_id: session, transcript_path: '/must-not-read', last_assistant_message: 'PRIVATE PAYLOAD' }));
    replies.push(await completion);
  }
  return replies;
}
async function turn(prompt) {
  if (codex) { send({ type: 'thread.started', thread_id: session }); send({ type: 'turn.started' }); }
  else send({ type: 'system', subtype: 'init', session_id: session });
  const directive = prompt.split('\n').find((line) => line.startsWith('CONTRACT:'));
  const test = directive ? JSON.parse(directive.slice('CONTRACT:'.length)) : { mode: 'events' };
  if (test.mode === 'memory-hooks') {
    const captures = [];
    for (const event of ['PreCompact', 'Stop', 'SessionEnd']) captures.push(await lifecycle(event));
    result(JSON.stringify({ captures, safety: await hook('Bash', { command: 'git push' }) })); return;
  }
  if (test.mode === 'waiting') {
    const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    toolStart('Read', { descendant: child.pid });
    await new Promise((resolve) => { finishWaiting = resolve; }); return;
  }
  if (test.mode === 'isolation') {
    toolStart('memory_read', {}); const text = await memory(); toolEnd('memory_read', text); result(text); return;
  }
  // permissions also echoes what a turn must carry: the resumed session, effort, writable directories and the received prompt.
  if (['read-only', 'permissions'].includes(test.mode) && codex) {
    result(JSON.stringify({ sandbox: flag('--sandbox'), network: configuration.sandbox_workspace_write?.network_access, approval: configuration.approval_policy, cwd: flag('--cd'), projectTrust: configuration.projects?.[flag('--cd')]?.trust_level,
      ...(test.mode === 'permissions' ? { resume: args.includes('resume') ? args[args.indexOf('resume') + 1] : null, effort: configuration.model_reasoning_effort, addDirs: args.flatMap((arg, i) => arg === '--add-dir' ? [args[i + 1]] : []), prompt } : {}) })); return;
  }
  if (['safety', 'read-only', 'permissions'].includes(test.mode)) {
    const replies = [];
    for (const request of test.requests) replies.push(await hook(request.tool, request.input));
    result(JSON.stringify(test.mode === 'permissions' ? { replies, permissionMode: flag('--permission-mode'), bypassAllowed: args.includes('--allow-dangerously-skip-permissions'),
      resume: flag('--resume') ?? null, model: flag('--model') ?? null, effort: flag('--effort') ?? null, allowedTools: flag('--allowedTools') ?? null, append: initialize?.appendSystemPrompt ?? null, prompt } : replies)); return;
  }
  toolStart('Read', { path: 'fixture' }); toolEnd('Read', 'fixture');
  result(args.includes('resume') || args.some((arg) => arg.startsWith('--resume=')) ? 'remembered-fixture' : 'fixture-answer');
}
if (codex) {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  await turn(input);
} else {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type === 'control_response') {
      const response = message.response;
      callbackReplies.get(response.request_id)?.(response.response); callbackReplies.delete(response.request_id); return;
    }
    if (message.type === 'control_request') {
      if (message.request.subtype === 'initialize') initialize = message.request;
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models: [], account: {} } } });
      if (message.request.subtype === 'interrupt') { finishWaiting?.(); result('interrupted'); }
    }
    if (message.type === 'user') void turn(typeof message.message.content === 'string' ? message.message.content : message.message.content.map((item) => item.text ?? '').join('\n'));
  });
}
