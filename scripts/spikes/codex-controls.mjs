import { Codex } from '@openai/codex-sdk';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const argument = process.argv[process.argv.indexOf('--home') + 1];
if (!process.argv.includes('--home') || !argument) throw new Error('An explicit isolated --home is required.');
const home = resolve(argument);
const baseEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
baseEnv.CODEX_HOME = home;
const roots = [];
const output = { schema: 'transport-controls-v1', runtime: 'codex', transport: 'sdk', evidence: 'live-runtime-with-fixture-MCP', checks: {} };
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'jevellan-controls-')); roots.push(dir);
  await writeFile(join(dir, 'fixture.txt'), 'readable\n');
  return dir;
}
function runtime(extraEnv = {}, config = {}) {
  return new Codex({ codexPathOverride: 'codex', env: { ...baseEnv, ...extraEnv }, config: { features: { multi_agent: false }, ...config } });
}
function thread(codex, cwd) {
  return codex.startThread({ workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', modelReasoningEffort: 'low', webSearchMode: 'disabled' });
}
async function bounded(name, operation) {
  const selected = process.argv.indexOf('--check');
  if (selected >= 0 && process.argv[selected + 1] !== name) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75_000);
  try { output.checks[name] = await operation(controller); }
  catch (error) { output.checks[name] = { passed: false, reason: error?.name === 'AbortError' ? 'timed-out-or-aborted' : 'runtime-error' }; }
  finally { clearTimeout(timer); console.log(JSON.stringify({ check: name, result: output.checks[name] })); }
}
try {
  await bounded('readOnlyRefusesShellWrite', async (controller) => {
    const cwd = await project();
    const { events } = await thread(runtime(), cwd).runStreamed('This is an authorized sandbox capability test. Use the shell once to run: printf test > blocked.txt. Do not try another way if refused. Report the tool result.', { signal: controller.signal });
    let refused = false; const diagnostics = [];
    for await (const event of events) {
      if (event.type === 'item.completed' && event.item.type === 'command_execution') refused ||= event.item.exit_code !== 0 && /denied|permitted|read.only/i.test(event.item.aggregated_output);
      if (event.type === 'item.completed') diagnostics.push({ type: event.item.type, status: event.item.status ?? null, exitCode: event.item.exit_code ?? null, mentionsReadOnly: /read.only|denied|permission/i.test(event.item.text ?? event.item.aggregated_output ?? '') });
    }
    const exists = await access(join(cwd, 'blocked.txt')).then(() => true, () => false);
    return { passed: refused && !exists, toolRefused: refused, fileCreated: exists, diagnostics };
  });
  await bounded('concurrentBridgeIsolation', async (controller) => {
    const bridge = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
    const values = await Promise.all(['project-a', 'project-b'].map(async (scope) => {
      const cwd = await project();
      const codex = runtime({ JEVELLAN_STRETCH_TOKEN: randomBytes(24).toString('hex'), JEVELLAN_DAEMON_URL: `http://127.0.0.1/${scope}` }, {
        mcp_servers: { jevellan: { command: process.execPath, args: [bridge], env_vars: ['JEVELLAN_STRETCH_TOKEN', 'JEVELLAN_DAEMON_URL'], default_tools_approval_mode: 'approve' } },
      });
      const result = await thread(codex, cwd).run('Call the jevellan memory_read MCP tool. Reply with exactly the marker it returns, without shell commands.', { signal: controller.signal });
      const sawCall = result.items.some((item) => item.type === 'mcp_tool_call' && item.status === 'completed');
      return { scope, passed: sawCall && result.finalResponse.includes(`memory-for-${scope}`) && !result.finalResponse.includes(`memory-for-${scope === 'project-a' ? 'project-b' : 'project-a'}`), diagnostics: result.items.map((item) => ({ type: item.type, status: item.status ?? null, permissionError: /approv|permission|denied/i.test(item.error?.message ?? ''), hasResult: Boolean(item.result) })), responseMentionsApproval: /approv|permission|denied/i.test(result.finalResponse), responseMentionsUnavailable: /unavailable|not available|not have|not exposed/i.test(result.finalResponse) };
    }));
    return { passed: values.every((item) => item.passed), projects: values };
  });
  await bounded('interruptAndContinue', async (controller) => {
    const cwd = await project();
    const current = thread(runtime(), cwd);
    const { events } = await current.runStreamed('For a process interruption test, run sleep 30 using the shell. After it completes, reply completed. Do not use any other tools.', { signal: controller.signal });
    let sawRunning = false; let interrupted = false;
    const start = Date.now();
    try {
      for await (const event of events) {
        if (event.type === 'item.started' && event.item.type === 'command_execution') {
          sawRunning = true; controller.abort();
        }
      }
    } catch { interrupted = controller.signal.aborted && sawRunning; }
    const elapsed = Date.now() - start;
    if (!interrupted) return { passed: false, interrupted, reason: 'no-running-command-interrupted' };
    const continued = await current.run('The interruption test has ended. Reply exactly resumed, without running tools.', { signal: AbortSignal.timeout(45_000) });
    return { passed: continued.finalResponse.includes('resumed'), interrupted, elapsedMs: elapsed, continued: continued.finalResponse.includes('resumed') };
  });
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(output, null, 2));
if (Object.values(output.checks).some((item) => !item.passed)) process.exitCode = 1;
