import { query, type Query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { nativePreToolUse, SESSION_NOT_FOUND, claudeBridgeToolNames, claudePermissionHook, claudeReadOnlyBridgeTools, classifyRuntimeError, serveWorker, type RunResult, type RuntimeEvent, type StretchInput, type TurnInput, type WorkerSession } from '@jevellan/runtime-contract';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_FLAG_SETTINGS, StableMcpSchema, projectToolNames } from '@jevellan/core';

const Envelope = z.object({ type: z.string(), session_id: z.string().optional() }).passthrough();
const TextDelta = z.object({ type: z.literal('content_block_delta'), delta: z.object({ type: z.literal('text_delta'), text: z.string() }) });
const ThinkingDelta = z.object({ type: z.literal('content_block_delta'), delta: z.object({ type: z.literal('thinking_delta'), thinking: z.string() }) });
const ContentMessage = z.object({ message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }) });
const ToolUse = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() });
const ToolResult = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() });
const ModelUsage = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), cacheReadInputTokens: z.number().nonnegative(), cacheCreationInputTokens: z.number().nonnegative(), costUSD: z.number().nonnegative(), contextWindow: z.number().int().positive().optional(), costBasis: z.enum(['list', 'managed', 'unknown']).optional() });
const Compact = z.object({ type: z.literal('system'), subtype: z.literal('compact_boundary'), compact_metadata: z.object({ pre_tokens: z.number().int().nonnegative(), post_tokens: z.number().int().nonnegative().optional() }) });
const ContextUsage = z.object({ context_usage: z.object({ total_tokens: z.number().int().nonnegative(), raw_max_tokens: z.number().int().positive() }) });
const AssistantUsage = z.object({ message: z.object({ usage: z.object({ input_tokens: z.number().int().nonnegative(), cache_read_input_tokens: z.number().int().nonnegative().optional(), cache_creation_input_tokens: z.number().int().nonnegative().optional() }) }) });
const Result = z.object({ is_error: z.boolean(), subtype: z.string(), result: z.string().optional(), errors: z.array(z.string()).optional(), modelUsage: z.record(z.string(), ModelUsage) });

// One worker's native query state. previous: cumulative model usage already reported by earlier runs.
type Control = { current: Query | undefined; interrupted: boolean; previous: { input: number; output: number; read: number; write: number; cost: number } };
type Launch = Omit<Options, 'abortController'>;

function workerEnvironment(input: Pick<StretchInput | TurnInput, 'account' | 'launch'>) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const stablePath = join(input.account.home, 'jevellan-mcp.json');
  const stable = existsSync(stablePath) ? StableMcpSchema.parse(JSON.parse(readFileSync(stablePath, 'utf8'))).servers : {};
  // The CLI and stdio MCP children inherit the already-filtered environment.
  // Never serialize a bridge token into the SDK's --mcp-config argument.
  return { env, mcpServers: { ...stable, ...Object.fromEntries(Object.entries(input.launch.mcpServers).map(([name, server]) => [name, { command: server.command, args: server.args }])) } };
}

// The CLI's sentence for a resume of a session it no longer has; it names the session id, which never leaves the worker (P8 review R-T1).
const NO_CONVERSATION = /No conversation found with session ID/i;
const missingSession = (failure: NonNullable<RunResult['error']>): NonNullable<RunResult['error']> => NO_CONVERSATION.test(failure.message) ? { kind: 'other', message: SESSION_NOT_FOUND } : failure;

// separate: turns put a blank line between text written before and after a tool call, so the last message has a boundary.
async function execute(control: Control, message: string, timeoutMs: number, launch: Launch, emit: (event: RuntimeEvent) => void, session: (id: string) => void, separate: boolean): Promise<RunResult> {
  control.interrupted = false;
  const controller = new AbortController();
  const timer = setTimeout(() => { control.interrupted = true; void control.current?.interrupt(); }, timeoutMs);
  let succeeded = false; let failure: ReturnType<typeof classifyRuntimeError> | undefined; let rateLimited = false;
  let textEmitted = false; let afterTool = false; let contextTokens: number | undefined;
  const started = new Set<string>(); const ended = new Set<string>();
  try {
    control.current = query({ prompt: message, options: { ...launch, abortController: controller } });
    for await (const raw of control.current) {
      const event = Envelope.parse(raw);
      if (event.session_id) session(event.session_id);
      const compact = Compact.safeParse(event);
      if (compact.success && separate) { contextTokens = compact.data.compact_metadata.post_tokens; emit({ type: 'compacted', beforeTokens: compact.data.compact_metadata.pre_tokens, afterTokens: contextTokens ?? null }); }
      const context = ContextUsage.safeParse(event);
      if (context.success && separate) { contextTokens = context.data.context_usage.total_tokens; emit({ type: 'context', tokens: contextTokens, contextWindow: context.data.context_usage.raw_max_tokens }); }
      else if (event.type === 'assistant' && separate) {
        const usage = AssistantUsage.safeParse(event);
        if (usage.success) { contextTokens = usage.data.message.usage.input_tokens + (usage.data.message.usage.cache_read_input_tokens ?? 0) + (usage.data.message.usage.cache_creation_input_tokens ?? 0); emit({ type: 'context', tokens: contextTokens }); }
      }
      if (event.type === 'stream_event') {
        const delta = TextDelta.safeParse(event.event);
        if (delta.success) { emit({ type: 'text', delta: `${separate && afterTool && textEmitted ? '\n\n' : ''}${delta.data.delta.text}` }); textEmitted = true; afterTool = false; }
        const thinking = ThinkingDelta.safeParse(event.event);
        if (thinking.success) emit({ type: 'thinking', delta: thinking.data.delta.thinking });
      }
      if (event.type === 'assistant' || event.type === 'user') {
        const content = ContentMessage.parse(event).message.content;
        if (Array.isArray(content)) for (const block of content) {
          const tool = ToolUse.safeParse(block);
          if (tool.success && !started.has(tool.data.id)) { emit({ type: 'tool-start', id: tool.data.id, name: tool.data.name, input: tool.data.input }); started.add(tool.data.id); }
          const result = ToolResult.safeParse(block);
          if (result.success && !ended.has(result.data.tool_use_id)) { emit({ type: 'tool-end', id: result.data.tool_use_id, ok: !result.data.is_error, output: typeof result.data.content === 'string' ? result.data.content : JSON.stringify(result.data.content) }); ended.add(result.data.tool_use_id); afterTool = true; }
        }
        if (typeof event.error === 'string') { failure = classifyRuntimeError(event.error); if (event.error === 'rate_limit') rateLimited = true; }
      }
      if (event.type === 'result') {
        const result = Result.parse(event);
        const values = Object.values(result.modelUsage);
        const main = result.modelUsage[launch.model ?? ''] ?? (values.length === 1 ? values[0] : undefined);
        if (separate && main?.contextWindow && contextTokens !== undefined) emit({ type: 'context', tokens: contextTokens, contextWindow: main.contextWindow });
        const totals = values.reduce((sum, usage) => ({ input: sum.input + usage.inputTokens, output: sum.output + usage.outputTokens, read: sum.read + usage.cacheReadInputTokens, write: sum.write + usage.cacheCreationInputTokens, cost: sum.cost + usage.costUSD }), { input: 0, output: 0, read: 0, write: 0, cost: 0 });
        const delta = (key: keyof typeof totals) => totals[key] >= control.previous[key] ? totals[key] - control.previous[key] : totals[key];
        emit({ type: 'usage', inputTokens: delta('input'), outputTokens: delta('output'), cacheReadTokens: delta('read'), cacheWriteTokens: delta('write'), ...(values.length && values.every((usage) => usage.costBasis !== 'unknown') ? { costUsd: delta('cost'), costSource: 'estimated' as const } : {}) });
        control.previous = totals;
        succeeded = !result.is_error && result.subtype === 'success';
        // An error result carries its reason in errors or, for API-level failures such as a model's usage limit, in result.
        if (!succeeded && !control.interrupted) failure = classifyRuntimeError(result.errors?.join('; ') || result.result || 'Claude returned an unsuccessful result.', rateLimited ? 'rate-limit' : undefined);
      }
    }
    if (control.interrupted) return { status: 'interrupted' };
    return succeeded && !failure ? { status: 'completed' } : { status: 'failed', error: missingSession(failure ?? { kind: 'other', message: 'Claude ended without a successful result.' }) };
  } catch (error) { return control.interrupted ? { status: 'interrupted' } : { status: 'failed', error: missingSession(failure ?? classifyRuntimeError(error)) }; }
  finally { clearTimeout(timer); control.current?.close(); control.current = undefined; }
}

const stretchSession = (input: StretchInput, daemonPid: number, executable?: string): WorkerSession => {
  const control: Control = { current: undefined, interrupted: false, previous: { input: 0, output: 0, read: 0, write: 0, cost: 0 } };
  let sessionId: string | undefined; let firstTurn = true;
  const { env, mcpServers } = workerEnvironment(input);
  return {
    async interrupt() { control.interrupted = true; await control.current?.interrupt(); },
    async run(message, timeoutMs, emit, session) {
      const repairing = !firstTurn;
      firstTurn = false;
      if (repairing && !sessionId) return { status: 'failed', error: { kind: 'other', message: 'Claude did not provide a session to continue.' } };
      const permissions = repairing ? 'read-only' : input.permissions;
      const hook = claudePermissionHook({ cwd: input.cwd, action: input.action, daemonPid, permissions, memoryWrite: !repairing && input.memoryWrite });
      return execute(control, message, timeoutMs, {
        cwd: input.cwd, env, model: input.model, effort: input.effort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: [input.launch.nativeSetup?.instructions, input.systemAppend].filter(Boolean).join('\n\n') },
        settingSources: ['user', 'project', 'local'], settings: { ...input.launch.nativeSetup?.settings, ...CLAUDE_FLAG_SETTINGS }, plugins: (input.launch.nativeSetup?.plugins ?? []).map(path => ({ type: 'local' as const, path })), includePartialMessages: true,
        permissionMode: permissions === 'write' ? 'bypassPermissions' : 'dontAsk',
        allowDangerouslySkipPermissions: permissions === 'write',
        // Native Claude builds may omit Glob/Grep in favour of Bash. Read-only
        // stretches need those tools because shell execution is not available.
        ...(permissions === 'read-only' ? {
          tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch'],
          // dontAsk denies MCP calls without an explicit allow rule, even when
          // PreToolUse permits them. Keep this list shared with the hook policy.
          allowedTools: claudeReadOnlyBridgeTools(!repairing && input.memoryWrite),
        } : {}),
        hooks: { PreToolUse: [{ hooks: [async event => { if (!('tool_name' in event)) return {}; const safety = await hook(event); if ('hookSpecificOutput' in safety) return safety; return nativePreToolUse(input.launch.nativeSetup, event, { home: input.account.home, cwd: input.cwd, writable: input.permissions === 'write', env }); }] }] },
        mcpServers, stderr: () => {}, ...(sessionId ? { resume: sessionId } : {}),
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      }, emit, (id) => { sessionId = id; session(id); }, false);
    },
  };
};

// A turn runs once: permissions follow the input on every turn, resumed or not; the prompt goes as is and the append rides the system prompt.
const turnSession = (input: TurnInput, daemonPid: number, executable?: string): WorkerSession => {
  const control: Control = { current: undefined, interrupted: false, previous: { input: 0, output: 0, read: 0, write: 0, cost: 0 } };
  const { env, mcpServers } = workerEnvironment(input);
  if (input.compaction) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(input.compaction.thresholdPercent);
  // The coordinator is the read-only owner; its allow list is its scope's exact tool list, shared with the hook.
  const bridgeTools = input.owner.kind === 'coordinator' ? claudeBridgeToolNames(projectToolNames({ kind: 'coordinator', ...(env.JEVELLAN_PROJECT_MEMORY_MODE === 'hub' ? { memoryMode: 'hub' } : {}) }))
    : input.owner.kind === 'review' ? claudeBridgeToolNames(['jevellan_project_review_report', 'memory_search', 'memory_read'])
    : input.owner.kind === 'memory' ? claudeBridgeToolNames(['memory_search', 'memory_read', 'memory_write', 'memory_edit', 'jevellan_memory_inbox_add', 'jevellan_memory_archive', 'jevellan_memory_dream_report']) : undefined;
  const hook = claudePermissionHook({ cwd: input.cwd, daemonPid, profile: input.safetyProfile, permissions: input.permissions, ...(input.privatePaths ? { privatePaths: input.privatePaths } : {}), ...(input.protectedPaths ? { protectedPaths: input.protectedPaths } : {}), ...(input.readOnlyDirectories ? { readOnlyDirectories: input.readOnlyDirectories } : {}), ...(bridgeTools ? { bridgeTools } : {}) });
  return {
    async interrupt() { control.interrupted = true; await control.current?.interrupt(); },
    run: (message, timeoutMs, emit, session) => execute(control, message, timeoutMs, {
      cwd: input.cwd, env, model: input.model, effort: input.effort,
      ...(input.readOnlyDirectories ? { additionalDirectories: input.readOnlyDirectories } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: [input.launch.nativeSetup?.instructions, input.systemAppend].filter(Boolean).join('\n\n') },
      settingSources: ['user', 'project', 'local'], settings: { ...input.launch.nativeSetup?.settings, ...CLAUDE_FLAG_SETTINGS }, plugins: (input.launch.nativeSetup?.plugins ?? []).map(path => ({ type: 'local' as const, path })), includePartialMessages: true,
      permissionMode: input.permissions === 'write' ? 'bypassPermissions' : 'dontAsk',
      allowDangerouslySkipPermissions: input.permissions === 'write',
      ...(input.permissions === 'read-only' ? { tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch'], allowedTools: bridgeTools ?? [] } : {}),
      hooks: { PreToolUse: [{ hooks: [async event => { if (!('tool_name' in event)) return {}; const safety = await hook(event); if ('hookSpecificOutput' in safety) return safety; return nativePreToolUse(input.launch.nativeSetup, event, { home: input.account.home, cwd: input.cwd, writable: input.permissions === 'write', env }); }] }] },
      mcpServers, stderr: () => {}, ...(input.resume ? { resume: input.resume.sessionId } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    }, emit, session, true),
  };
};

serveWorker(stretchSession, turnSession);
