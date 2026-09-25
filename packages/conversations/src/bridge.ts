import { createHash, randomBytes } from 'node:crypto';
import {
  BridgeRequestSchema, BridgeResultSchema, BridgeToolSchemas, HandoffToolSchema, MemoryEditSchema, MemoryNoteSchema, MemorySearchSchema, MemoryWriteSchema,
  IntegrationStatusSchema, SecretRedactor, bridgeTools, type BridgeTool, type IntegrationRunner, type MemoryNote,
} from '@jevellan/core';
import type { z } from 'zod';
import { ConversationWork } from './work.js';
import { queueMemory } from './memory.js';

/** Bound to one project by the owner; tool arguments cannot select a project. */
export type ProjectMemory = {
  search(query: string, signal: AbortSignal): Promise<z.infer<typeof MemorySearchSchema>>;
  read(permalink: string, signal: AbortSignal): Promise<MemoryNote>;
  write(input: z.infer<typeof MemoryWriteSchema>, signal: AbortSignal): Promise<MemoryNote>;
  edit(input: z.infer<typeof MemoryEditSchema>, signal: AbortSignal): Promise<MemoryNote>;
  assertOwnership(): void | Promise<void>;
};
type Scope = { work: ConversationWork; stretch: number; memoryWrite: boolean; memory: ProjectMemory; memoryCapture: () => boolean; integration?: IntegrationRunner };
const readTools: BridgeTool[] = ['jevellan_finding', 'jevellan_handoff', 'jevellan_conversation_search', 'jevellan_conversation_read', 'memory_search', 'memory_read'];
const failure = (message: string, status = 403) => Object.assign(new Error(message), { status });

export class StretchTools {
  #active = true;
  #repairing = false;
  #pending: Promise<unknown> = Promise.resolve();
  readonly #abort = new AbortController();
  constructor(readonly scope: Scope) { this.#check(); }
  #check(): void {
    if (!this.#active) throw failure('This stretch token has expired.', 401);
    if (!this.scope.work.load().stretches.some((entry) => entry.n === this.scope.stretch && entry.status === 'running')) throw failure('This token belongs to no running stretch.', 401);
  }
  list() {
    this.#check();
    const integration = this.scope.integration && this.scope.work.load().stretches.find((entry) => entry.n === this.scope.stretch)?.action === 'integrate';
    return bridgeTools([...readTools, ...(this.#repairing ? [] : [...(integration ? ['jevellan_integrate'] as BridgeTool[] : []), ...(this.scope.memoryWrite ? ['memory_write', 'memory_edit'] as BridgeTool[] : ['memory_propose'] as BridgeTool[])])]);
  }
  async repair(): Promise<void> { this.#repairing = true; await this.#pending; }
  async close(): Promise<void> { this.#active = false; this.#abort.abort(); await this.#pending; }
  capture(): Promise<z.infer<typeof BridgeResultSchema>> {
    const result = this.#pending.then(() => {
      this.#check();
      const { work, stretch, memoryWrite } = this.scope;
      const step = work.load().stretches.find((entry) => entry.n === stretch)!;
      const reason = !this.scope.memoryCapture() ? 'disabled' : this.#repairing ? 'repair' : step.action === 'reply' && !memoryWrite ? 'answer-only' : undefined;
      if (reason) return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { queued: false, reason } });
      // Match Garrison's metadata-only capture. Never read a provider transcript,
      // accept its project/session identity, or treat a Stop as proof of completion.
      // Stable content coalesces PreCompact, Stop, SessionEnd and their retries.
      const receipt = queueMemory(work, stretch, {
        title: `Step ${stretch} · ${work.ledger.id}`,
        content: `## Structural checkpoint\n\n[Conversation](/conversations/${work.ledger.id})\n\n- Project: ${work.load().conversation.projectId}\n- Step: ${stretch}\n- Action: ${step.action}\n- Runtime: ${step.runtime}\n- Model: ${step.model}\n- Effort: ${step.effortEffective}\n- Device: ${step.deviceId}\n- Started: ${step.startedAt}\n${step.gitBefore ? `- Starting commit: ${step.gitBefore}\n` : ''}\nA lifecycle hook was observed during this step. This is not a completion or verification receipt. Read the conversation for its final handoff and evidence. No transcript, tool input, response, diff or environment values were read.`,
        reason: 'Project memory lifecycle checkpoint.',
      }, 'hook');
      return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: receipt });
    });
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }
  call(name: BridgeTool, args: unknown): Promise<z.infer<typeof BridgeResultSchema>> {
    const result = this.#pending.then(() => this.#call(name, args));
    // Failed tool calls do not prevent a later corrected call or shutdown.
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async #call(name: BridgeTool, raw: unknown): Promise<z.infer<typeof BridgeResultSchema>> {
    this.#check();
    if (!this.list().tools.some((tool) => tool.name === name)) throw failure('This step cannot use that tool.');
    const { work, stretch, memory } = this.scope; const ledger = work.ledger;
    const accepted = ledger.handoffs().some((handoff) => handoff.stretch === stretch);
    if (accepted && ['jevellan_finding', 'jevellan_integrate', 'memory_write', 'memory_edit', 'memory_propose'].includes(name)) throw failure('This step already handed off.');
    const args = ledger.redact(raw); let result: unknown;
    switch (name) {
      case 'jevellan_finding': {
        const finding = BridgeToolSchemas.jevellan_finding.parse(args);
        const event = work.runtimeEvent('finding', finding, stretch); result = { eventId: event.id, pointer: `ledger/${event.id}` }; break;
      }
      case 'jevellan_handoff': {
        const handoff = HandoffToolSchema.parse(args);
        if (handoff.stretch !== stretch) throw failure('This token belongs to another stretch.');
        const content = handoff.result;
        result = ledger.acceptHandoff({ ...handoff, ...(content && 'content' in content ? { result: { type: content.type, ref: ledger.putBlob(content.content).ref } } : {}) }); break;
      }
      case 'jevellan_conversation_search': result = ledger.search(BridgeToolSchemas.jevellan_conversation_search.parse(args).query); break;
      case 'jevellan_conversation_read': result = ledger.read(BridgeToolSchemas.jevellan_conversation_read.parse(args).pointer); break;
      case 'jevellan_integrate': result = IntegrationStatusSchema.parse(await this.scope.integration!(BridgeToolSchemas.jevellan_integrate.parse(args).command)); break;
      case 'memory_search': result = MemorySearchSchema.parse(await memory.search(BridgeToolSchemas.memory_search.parse(args).query, this.#abort.signal)); break;
      case 'memory_read': result = MemoryNoteSchema.parse(await memory.read(BridgeToolSchemas.memory_read.parse(args).permalink, this.#abort.signal)); break;
      case 'memory_write': {
        const input = MemoryWriteSchema.parse(args); await memory.assertOwnership(); this.#check();
        if (this.#repairing) throw failure('Handoff repair cannot write memory.');
        result = MemoryNoteSchema.parse(await memory.write(input, this.#abort.signal)); break;
      }
      case 'memory_edit': {
        const input = MemoryEditSchema.parse(args); await memory.assertOwnership(); this.#check();
        if (this.#repairing) throw failure('Handoff repair cannot edit memory.');
        result = MemoryNoteSchema.parse(await memory.edit(input, this.#abort.signal)); break;
      }
      case 'memory_propose': {
        const input = BridgeToolSchemas.memory_propose.parse(args);
        result = queueMemory(work, stretch, input);
        break;
      }
    }
    return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: ledger.redact(result) });
  }
}

/** Tokens live only in memory. A restart invalidates every outstanding grant. */
export class StretchBridges {
  readonly #scopes = new Map<string, StretchTools>();
  constructor(readonly redactor: SecretRedactor) {}
  #key(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  issue(scope: Scope): { token: string; tools: StretchTools; close(): Promise<void> } {
    const tools = new StretchTools(scope); const token = randomBytes(32).toString('base64url');
    const key = this.#key(token); this.#scopes.set(key, tools); this.redactor.add(token);
    return { token, tools, close: async () => { this.#scopes.delete(key); await tools.close(); } };
  }
  async request(token: string | undefined, raw: unknown) {
    const tools = token && token.length < 256 ? this.#scopes.get(this.#key(token)) : undefined;
    if (!tools) throw failure('Invalid or expired stretch token.', 401);
    const request = BridgeRequestSchema.parse(raw);
    return request.operation === 'list' ? tools.list() : request.operation === 'memory-capture' ? tools.capture() : tools.call(request.name, request.arguments);
  }
  async close(): Promise<void> { const tools = [...this.#scopes.values()]; this.#scopes.clear(); await Promise.all(tools.map((scope) => scope.close())); }
}
