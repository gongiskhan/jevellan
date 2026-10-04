import { z } from 'zod';
import {
  BridgeResultSchema, BridgeToolSchemas, MemoryNoteSchema, MemorySearchSchema, ProjectToolResultSchemas, ThreadReportSchema, bridgeTools, projectToolNames, stableJson,
  type BridgeTool, type BridgeToolsSchema, type MemoryNote, type ProjectToolName, type SecretRedactor, type ThreadReport,
} from '@jevellan/core';
import type { BridgeScopeTools } from '@jevellan/conversations';
import { REPORT_ALREADY_SENT, TOOL_NOT_IN_TURN, TURN_ENDED, toolInputError } from './copy.js';
import type { ProjectLedger } from './ledger.js';

export type ProjectScope = { kind: 'coordinator'; projectId: string; turn: number }
  | { kind: 'thread'; projectId: string; threadId: string; turn: number; isolation: 'worktree' | 'main' };
/** Read-only project memory: the project checkout's notes on the device that runs the turn. */
export type ProjectMemoryReader = {
  search(query: string, signal: AbortSignal): Promise<z.infer<typeof MemorySearchSchema>>;
  read(permalink: string, signal: AbortSignal): Promise<MemoryNote>;
};
/** One coordinator tool line in the coordinator ledger (brief 8.1, 2.6.5). */
export type ToolLine = { summary: string; threadId?: string | undefined; decisionId?: string | undefined; reason?: string | undefined };
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };
export type ProjectToolHandlers = {
  /** The scope's turn is the running turn of its owner. */
  isCurrent(scope: ProjectScope): boolean;
  /** Every tool except the thread report and memory; returns the tool's versioned result document. */
  call(scope: ProjectScope, name: ProjectToolName, input: unknown, signal: AbortSignal): Promise<unknown>;
  /** Resolved on first use, so a project without a checkout here fails the call with its own sentence. */
  memory(scope: ProjectScope): ProjectMemoryReader | Promise<ProjectMemoryReader>;
  /** Coordinator one-liners (phase 2): when given with a ledger, each call after the scope checks is recorded. */
  line?(name: ProjectToolName, input: unknown, outcome: ToolOutcome): ToolLine;
};
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const message = (error: unknown) => error instanceof Error ? error.message : 'The tool request failed.';

/**
 * The tools of one coordinator or thread turn (brief 7, D11). A token lives only while its turn runs: closed scopes and
 * turns that are no longer current answer 401, tools outside the scope list 403. Calls are serialized like stretch tools;
 * arguments are redacted before parsing, and invalid input becomes one field sentence the model can act on.
 */
export class ProjectTools implements BridgeScopeTools {
  #active = true;
  #pending: Promise<unknown> = Promise.resolve();
  readonly #abort = new AbortController();
  #report: ThreadReport | undefined;
  constructor(readonly scope: ProjectScope, private readonly handlers: ProjectToolHandlers, private readonly redactor: SecretRedactor, private readonly ledger?: ProjectLedger) {}
  #check(): void {
    if (!this.#active || !this.handlers.isCurrent(this.scope)) throw failure(TURN_ENDED, 401);
  }
  #names(): BridgeTool[] { return projectToolNames(this.scope); }
  list(): z.infer<typeof BridgeToolsSchema> { this.#check(); return bridgeTools(this.#names()); }
  /** Thread scopes: the report accepted in this turn. */
  get report(): ThreadReport | undefined { return this.#report && structuredClone(this.#report); }
  /** The project memory hook fires in account homes during turns too; project scopes queue nothing. */
  async capture(): Promise<z.infer<typeof BridgeResultSchema>> { return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { queued: false, reason: 'disabled' } }); }
  async close(): Promise<void> { this.#active = false; this.#abort.abort(); await this.#pending; }
  call(name: BridgeTool, args: unknown): Promise<z.infer<typeof BridgeResultSchema>> {
    const result = this.#pending.then(() => this.#call(name, args));
    // Failed tool calls do not prevent a later corrected call or the end of the turn.
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async #call(name: BridgeTool, raw: unknown): Promise<z.infer<typeof BridgeResultSchema>> {
    this.#check();
    if (!this.#names().includes(name)) throw failure(TOOL_NOT_IN_TURN, 403);
    const tool = name as ProjectToolName;
    const args: unknown = this.redactor.document(raw); let input: unknown = args;
    try {
      const parsed = BridgeToolSchemas[tool].safeParse(args);
      if (!parsed.success) { const issue = parsed.error.issues[0]; throw failure(toolInputError(issue?.path ?? [], issue?.message ?? 'Invalid input'), 400); }
      input = parsed.data;
      const result = this.redactor.document(ProjectToolResultSchemas[tool].parse(await this.#handle(tool, input)));
      this.#line(tool, input, { ok: true, result });
      return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result });
    } catch (error) {
      this.#line(tool, input, { ok: false, error: this.redactor.text(message(error)) });
      throw error;
    }
  }
  async #handle(name: ProjectToolName, input: unknown): Promise<unknown> {
    const signal = this.#abort.signal;
    if (name === 'jevellan_thread_report') return this.#accept(input as z.infer<typeof BridgeToolSchemas.jevellan_thread_report>);
    if (name === 'memory_search') return MemorySearchSchema.parse(await (await this.handlers.memory(this.scope)).search((input as { query: string }).query, signal));
    if (name === 'memory_read') return MemoryNoteSchema.parse(await (await this.handlers.memory(this.scope)).read((input as { permalink: string }).permalink, signal));
    return this.handlers.call(this.scope, name, input, signal);
  }
  /**
   * Exactly one report per turn (brief 7.2). An identical retry returns the original receipt with `repeated: true`, because
   * MCP transports retry calls whose reply was lost (D19); a different second report is refused.
   */
  #accept(input: z.infer<typeof BridgeToolSchemas.jevellan_thread_report>): unknown {
    if (this.scope.kind !== 'thread') throw failure(TOOL_NOT_IN_TURN, 403);
    const report = ThreadReportSchema.parse({ ...input, schema: 'thread-report-v1', turn: this.scope.turn, synthesized: false });
    const receipt = (repeated: boolean) => ({ schema: 'thread-report-result-v1', turn: report.turn, status: report.status, accepted: true, repeated });
    if (!this.#report) { this.#report = report; return receipt(false); }
    if (stableJson(this.#report) === stableJson(report)) return receipt(true);
    throw failure(REPORT_ALREADY_SENT, 409);
  }
  #line(name: ProjectToolName, input: unknown, outcome: ToolOutcome): void {
    if (!this.ledger || !this.handlers.line || this.scope.kind !== 'coordinator') return;
    // The action already happened: a chat line that cannot be written must not turn it into an error the model retries.
    try {
      const line = this.handlers.line(name, input, outcome);
      this.ledger.append({ type: 'coordinator-tool', turn: this.scope.turn, data: { schema: 'coordinator-tool-v1', tool: name, ok: outcome.ok, ...line } });
    } catch { /* The tool result stands without its one-liner. */ }
  }
}
