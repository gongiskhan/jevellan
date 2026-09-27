import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import { serveWorker, classifyRuntimeError, type RuntimeEvent } from '@jevellan/runtime-contract';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { projectTrustOverride, projectInstructions } from './configuration.js';

const ItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent_message'), id: z.string(), text: z.string() }),
  z.object({ type: z.literal('command_execution'), id: z.string(), command: z.string(), aggregated_output: z.string(), exit_code: z.number().int().nullish(), status: z.enum(['in_progress', 'completed', 'failed']) }),
  z.object({ type: z.literal('mcp_tool_call'), id: z.string(), server: z.string(), tool: z.string(), arguments: z.unknown(), result: z.unknown().optional(), error: z.object({ message: z.string() }).nullish(), status: z.enum(['in_progress', 'completed', 'failed']) }),
  z.object({ type: z.literal('file_change'), id: z.string(), changes: z.array(z.object({ path: z.string(), kind: z.enum(['add', 'delete', 'update']) })), status: z.enum(['in_progress', 'completed', 'failed']) }),
]);
const EventSchema = z.object({ type: z.string(), thread_id: z.string().optional(), item: z.unknown().optional(), message: z.string().optional(), error: z.object({ message: z.string() }).optional(), usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), cached_input_tokens: z.number().int().nonnegative().optional(), cache_write_input_tokens: z.number().int().nonnegative().optional() }).optional() });

serveWorker((input, daemonPid, executable) => {
  const cwd = realpathSync(input.cwd);
  const instructions = projectInstructions(cwd); let firstTurn = true; let textEmitted = false;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const mcp = Object.fromEntries(Object.entries(input.launch.mcpServers).map(([name, server]) => [name, { command: server.command, args: server.args, env_vars: ['JEVELLAN_STRETCH_TOKEN', 'JEVELLAN_DAEMON_URL'], default_tools_approval_mode: 'approve' }]));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const safety = [process.execPath, fileURLToPath(new URL('./safety-hook.js', import.meta.url)), JSON.stringify({ cwd: input.cwd, action: input.action, daemonPid })].map(quote).join(' ');
  // SDK object flattening treats dots in project paths as configuration levels.
  // Keep the path inside a TOML value so the native CLI receives one exact key.
  const runtime = new Codex({ codexPathOverride: fileURLToPath(new URL('../bin/launch.mjs', import.meta.url)), env,
    configOverrides: [projectTrustOverride(cwd)],
    config: { jevellan_executable: executable ?? 'codex', features: { multi_agent: false, hooks: true }, mcp_servers: mcp, hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: safety, timeout: 10 }] }] } },
  });
  const options: ThreadOptions = { workingDirectory: cwd, model: input.model, modelReasoningEffort: input.effort, sandboxMode: input.permissions === 'read-only' ? 'read-only' : 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: input.permissions === 'write', ...(input.inputCopy ? { skipGitRepoCheck: true } : {}) };
  let thread = runtime.startThread(options);
  let controller = new AbortController();
  return {
    async interrupt() { controller.abort(); },
    async run(message, timeoutMs, emit, session) {
      controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const textById = new Map<string, string>(); const started = new Set<string>(); const ended = new Set<string>();
      let failure: ReturnType<typeof classifyRuntimeError> | undefined; let completed = false;
      try {
        if (!firstTurn) {
          if (!thread.id) throw new Error('Codex did not provide a session to continue.');
          thread = runtime.resumeThread(thread.id, { ...options, sandboxMode: 'read-only', networkAccessEnabled: false });
        }
        const prompt = firstTurn && instructions ? `# Project instructions: AGENTS.md\n${instructions}\n\n# Current stretch\n${message}` : message;
        firstTurn = false;
        const { events } = await thread.runStreamed(prompt, { signal: controller.signal });
        for await (const raw of events) {
          const event = EventSchema.parse(raw);
          if (event.type === 'thread.started' && event.thread_id) session(event.thread_id);
          if (event.type === 'turn.completed' && event.usage) {
            completed = true;
            emit({ type: 'usage', inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens,
              ...(event.usage.cached_input_tokens === undefined ? {} : { cacheReadTokens: event.usage.cached_input_tokens }),
              ...(event.usage.cache_write_input_tokens === undefined ? {} : { cacheWriteTokens: event.usage.cache_write_input_tokens }) });
          }
          if (event.type === 'error' || event.type === 'turn.failed') { failure = classifyRuntimeError(event.error?.message ?? event.message); emit({ type: 'error', ...failure }); }
          if (!event.item) continue;
          const known = ItemSchema.safeParse(event.item);
          if (!known.success) {
            const kind = z.object({ type: z.string() }).parse(event.item).type;
            if (['agent_message', 'command_execution', 'mcp_tool_call', 'file_change'].includes(kind)) {
              const fields = known.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
              throw new Error(`Codex returned a malformed ${kind} item (${fields}).`);
            }
            continue;
          }
          const item = known.data;
          if (item.type === 'agent_message') {
            const previous = textById.get(item.id) ?? '';
            if (!item.text.startsWith(previous)) throw new Error('Codex rewrote an already streamed message.');
            // Separate agent messages would otherwise run together in the stretch's text ("…README.What would…").
            if (item.text.length > previous.length) { emit({ type: 'text', delta: `${previous === '' && textEmitted ? '\n\n' : ''}${item.text.slice(previous.length)}` }); textEmitted = true; }
            textById.set(item.id, item.text); continue;
          }
          if (!started.has(item.id)) {
            let tool: Extract<RuntimeEvent, { type: 'tool-start' }>;
            if (item.type === 'command_execution') tool = { type: 'tool-start', id: item.id, name: 'Shell', input: { command: item.command } };
            else if (item.type === 'mcp_tool_call') tool = { type: 'tool-start', id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments };
            else tool = { type: 'tool-start', id: item.id, name: 'Edit', input: item.changes };
            emit(tool); started.add(item.id);
          }
          if (event.type === 'item.completed' && !ended.has(item.id)) {
            const output = item.type === 'command_execution' ? item.aggregated_output : item.type === 'mcp_tool_call' ? JSON.stringify(item.result ?? item.error ?? null) : JSON.stringify(item.changes);
            emit({ type: 'tool-end', id: item.id, ok: item.status === 'completed' && (item.type !== 'command_execution' || item.exit_code === 0), output }); ended.add(item.id);
          }
        }
        if (controller.signal.aborted) return { status: 'interrupted' };
        return failure ? { status: 'failed', error: failure } : completed ? { status: 'completed' } : { status: 'failed', error: { kind: 'other', message: 'Codex ended without a turn result.' } };
      } catch (error) { return controller.signal.aborted ? { status: 'interrupted' } : { status: 'failed', error: classifyRuntimeError(error) }; }
      finally { clearTimeout(timer); }
    },
  };
});
