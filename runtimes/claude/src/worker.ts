import { query, type Query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { claudePermissionHook, classifyRuntimeError, serveWorker } from '@jevellan/runtime-contract';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StableMcpSchema } from '@jevellan/core';

const Envelope = z.object({ type: z.string(), session_id: z.string().optional() }).passthrough();
const TextDelta = z.object({ type: z.literal('content_block_delta'), delta: z.object({ type: z.literal('text_delta'), text: z.string() }) });
const ContentMessage = z.object({ message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }) });
const ToolUse = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() });
const ToolResult = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() });
const ModelUsage = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), cacheReadInputTokens: z.number().nonnegative(), cacheCreationInputTokens: z.number().nonnegative(), costUSD: z.number().nonnegative(), costBasis: z.enum(['list', 'managed', 'unknown']).optional() });
const Result = z.object({ is_error: z.boolean(), subtype: z.string(), errors: z.array(z.string()).optional(), modelUsage: z.record(z.string(), ModelUsage) });

serveWorker((input, daemonPid, executable) => {
  let current: Query | undefined; let sessionId: string | undefined; let interrupted = false;
  let previous = { input: 0, output: 0, read: 0, write: 0, cost: 0 };
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const hook = claudePermissionHook({ cwd: input.cwd, action: input.action, daemonPid, permissions: input.permissions, memoryWrite: input.memoryWrite });
  const stablePath = join(input.account.home, 'jevellan-mcp.json');
  const stable = existsSync(stablePath) ? StableMcpSchema.parse(JSON.parse(readFileSync(stablePath, 'utf8'))).servers : {};
  return {
    async interrupt() { interrupted = true; await current?.interrupt(); },
    async run(message, timeoutMs, emit, session) {
      interrupted = false;
      const controller = new AbortController();
      const timer = setTimeout(() => { interrupted = true; void current?.interrupt(); }, timeoutMs);
      let succeeded = false; let failure: ReturnType<typeof classifyRuntimeError> | undefined;
      const started = new Set<string>(); const ended = new Set<string>();
      const options: Options = {
        cwd: input.cwd, env, model: input.model, effort: input.effort, abortController: controller,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
        settingSources: ['user', 'project', 'local'], includePartialMessages: true,
        permissionMode: input.permissions === 'write' ? 'bypassPermissions' : 'dontAsk',
        allowDangerouslySkipPermissions: input.permissions === 'write',
        hooks: { PreToolUse: [{ hooks: [async (event) => 'tool_name' in event ? hook(event) : {}] }] },
        // The CLI and stdio MCP children inherit the already-filtered environment.
        // Never serialize a bridge token into the SDK's --mcp-config argument.
        mcpServers: { ...stable, ...Object.fromEntries(Object.entries(input.launch.mcpServers).map(([name, server]) => [name, { command: server.command, args: server.args }])) },
        stderr: () => {}, ...(sessionId ? { resume: sessionId } : {}),
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      };
      try {
        current = query({ prompt: message, options });
        for await (const raw of current) {
          const event = Envelope.parse(raw);
          if (event.session_id) { sessionId = event.session_id; session(sessionId); }
          if (event.type === 'stream_event') {
            const delta = TextDelta.safeParse(event.event);
            if (delta.success) emit({ type: 'text', delta: delta.data.delta.text });
          }
          if (event.type === 'assistant' || event.type === 'user') {
            const content = ContentMessage.parse(event).message.content;
            if (Array.isArray(content)) for (const block of content) {
              const tool = ToolUse.safeParse(block);
              if (tool.success && !started.has(tool.data.id)) { emit({ type: 'tool-start', id: tool.data.id, name: tool.data.name, input: tool.data.input }); started.add(tool.data.id); }
              const result = ToolResult.safeParse(block);
              if (result.success && !ended.has(result.data.tool_use_id)) { emit({ type: 'tool-end', id: result.data.tool_use_id, ok: !result.data.is_error, output: typeof result.data.content === 'string' ? result.data.content : JSON.stringify(result.data.content) }); ended.add(result.data.tool_use_id); }
            }
            if (typeof event.error === 'string') failure = classifyRuntimeError(event.error);
          }
          if (event.type === 'result') {
            const result = Result.parse(event);
            const values = Object.values(result.modelUsage);
            const totals = values.reduce((sum, usage) => ({ input: sum.input + usage.inputTokens, output: sum.output + usage.outputTokens, read: sum.read + usage.cacheReadInputTokens, write: sum.write + usage.cacheCreationInputTokens, cost: sum.cost + usage.costUSD }), { input: 0, output: 0, read: 0, write: 0, cost: 0 });
            const delta = (key: keyof typeof totals) => totals[key] >= previous[key] ? totals[key] - previous[key] : totals[key];
            emit({ type: 'usage', inputTokens: delta('input'), outputTokens: delta('output'), cacheReadTokens: delta('read'), cacheWriteTokens: delta('write'), ...(values.length && values.every((usage) => usage.costBasis !== 'unknown') ? { costUsd: delta('cost'), costSource: 'estimated' as const } : {}) });
            previous = totals;
            succeeded = !result.is_error && result.subtype === 'success';
            if (!succeeded && !interrupted) failure = classifyRuntimeError(result.errors?.join('; ') ?? 'Claude returned an unsuccessful result.');
          }
        }
        if (interrupted) return { status: 'interrupted' };
        return succeeded && !failure ? { status: 'completed' } : { status: 'failed', error: failure ?? { kind: 'other', message: 'Claude ended without a successful result.' } };
      } catch (error) { return interrupted ? { status: 'interrupted' } : { status: 'failed', error: failure ?? classifyRuntimeError(error) }; }
      finally { clearTimeout(timer); current?.close(); current = undefined; }
    },
  };
});
