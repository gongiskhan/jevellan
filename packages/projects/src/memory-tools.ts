import { BridgeResultSchema, BridgeToolSchemas, bridgeTools, stableJson, type BridgeTool, type SecretRedactor } from '@jevellan/core';
import type { BridgeScopeTools } from '@jevellan/conversations';
import type { ProjectMemoryPort } from '@jevellan/memory';
import type { MemoryInboxInput } from '@jevellan/core';

export async function readSessionMemory(memory: ProjectMemoryPort, name: BridgeTool, raw: unknown, redactor: SecretRedactor, signal: AbortSignal): Promise<unknown> {
  if (name !== 'memory_search' && name !== 'memory_read') throw Object.assign(new Error('This session can only read project memory.'), { status: 403 });
  const input = BridgeToolSchemas[name].parse(redactor.document(raw));
  return name === 'memory_search' ? memory.search((input as { query: string }).query, signal) : memory.read((input as { permalink: string }).permalink, signal);
}

export class MemorySessionTools implements BridgeScopeTools {
  #active = true; #pending: Promise<unknown> = Promise.resolve(); #report: string | null = null; #inbox = new Map<string, unknown>();
  readonly abort = new AbortController();
  constructor(readonly kind: 'extraction' | 'dream', readonly memory: ProjectMemoryPort, readonly redactor: SecretRedactor,
    readonly handlers: { inbox?(input: MemoryInboxInput): Promise<unknown>; archive?(input: { note: string; reason: string }): Promise<unknown>;
      report?(summary: string): Promise<unknown> }) {}
  get reported() { return this.#report !== null; }
  get summary() { return this.#report; }
  list() {
    if (!this.#active) throw Object.assign(new Error('This memory session ended.'), { status: 401 });
    return bridgeTools(this.kind === 'extraction' ? ['jevellan_memory_inbox_add'] : ['memory_search', 'memory_read', 'memory_write', 'memory_edit', 'jevellan_memory_archive', 'jevellan_memory_dream_report']);
  }
  capture() { return Promise.resolve(BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { queued: false, reason: 'memory-session' } })); }
  call(name: BridgeTool, raw: unknown) {
    const promise = this.#pending.then(async () => {
      if (!this.list().tools.some(tool => tool.name === name)) throw Object.assign(new Error('This tool is outside the memory session.'), { status: 403 });
      const input = BridgeToolSchemas[name].parse(this.redactor.document(raw)); let result: unknown;
      switch (name) {
        case 'memory_search': result = await this.memory.search((input as { query: string }).query, this.abort.signal); break;
        case 'memory_read': result = await this.memory.read((input as { permalink: string }).permalink, this.abort.signal); break;
        case 'memory_write': result = await this.memory.write(input as Parameters<ProjectMemoryPort['write']>[0], this.abort.signal); break;
        case 'memory_edit': result = await this.memory.edit(input as Parameters<ProjectMemoryPort['edit']>[0], this.abort.signal); break;
        case 'jevellan_memory_archive': result = await this.handlers.archive!(input as { note: string; reason: string }); break;
        case 'jevellan_memory_inbox_add': {
          const key = stableJson(input); if (this.#inbox.has(key)) result = this.#inbox.get(key);
          else { if (this.#inbox.size >= 8) throw new Error('An extraction writes at most eight inbox notes.'); result = await this.handlers.inbox!(input as MemoryInboxInput); this.#inbox.set(key, result); } break;
        }
        case 'jevellan_memory_dream_report': {
          const summary = (input as { summary: string }).summary;
          if (this.#report !== null && this.#report !== summary) throw new Error('This dream already reported a different summary.');
          if (this.#report === null) { result = await this.handlers.report!(summary); this.#report = summary; }
          else result = { schema: 'memory-dream-receipt-v1', accepted: true }; break;
        }
        default: throw new Error('This tool is outside the memory session.');
      }
      return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: this.redactor.document(result) });
    }); this.#pending = promise.then(() => undefined, () => undefined); return promise;
  }
  async close() { this.#active = false; this.abort.abort(); await this.#pending; }
}
