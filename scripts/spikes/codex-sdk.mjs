import { Codex } from '@openai/codex-sdk';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const homeIndex = process.argv.indexOf('--home');
if (homeIndex < 0 || !process.argv[homeIndex + 1]) throw new Error('An explicit isolated --home is required.');
const home = resolve(process.argv[homeIndex + 1]);
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
env.CODEX_HOME = home;
const cwd = await mkdtemp(join(tmpdir(), 'jevellan-codex-spike-'));
const result = { schema: 'transport-spike-v1', runtime: 'codex', transport: 'sdk', evidence: 'live', checks: {}, eventTypes: [], error: null };
try {
  await writeFile(join(cwd, 'fixture.txt'), 'transport-ready\n');
  const codex = new Codex({ codexPathOverride: 'codex', env, config: { features: { multi_agent: false } } });
  const thread = codex.startThread({ workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', modelReasoningEffort: 'low', webSearchMode: 'disabled' });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  try {
    const { events } = await thread.runStreamed('Read fixture.txt with a tool. Reply with exactly its contents. Do not modify files or use other tools.', { signal: abort.signal });
    let text = ''; let sawTool = false; let usage = false;
    for await (const event of events) {
      result.eventTypes.push(event.type);
      if (event.type === 'item.completed' && event.item.type === 'agent_message') text += event.item.text;
      if (event.type === 'item.started' && ['command_execution', 'mcp_tool_call'].includes(event.item.type)) sawTool = true;
      if (event.type === 'turn.completed') usage = event.usage.input_tokens > 0 && event.usage.output_tokens > 0;
      if (event.type === 'error' || event.type === 'turn.failed') throw new Error('runtime-failed');
    }
    result.checks.textAndToolsAndUsage = text.includes('transport-ready') && sawTool && usage;
    const turn = await thread.run('What were the contents you just read? Reply exactly, without using a tool.', { signal: abort.signal });
    result.checks.sameSessionContinuation = turn.finalResponse.includes('transport-ready');
  } finally { clearTimeout(timer); }
} catch (error) {
  result.error = error?.name === 'AbortError' ? 'timeout-or-abort' : 'runtime-or-authentication-failed';
  result.checks.textAndToolsAndUsage ??= false;
} finally {
  await rm(cwd, { recursive: true, force: true });
}
result.eventTypes = [...new Set(result.eventTypes)];
console.log(JSON.stringify(result, null, 2));
if (result.error || Object.values(result.checks).some((value) => value === false)) process.exitCode = 1;
