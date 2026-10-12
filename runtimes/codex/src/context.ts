import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { RuntimeEvent } from '@jevellan/runtime-contract';

const Record = z.object({ type: z.string(), payload: z.unknown() });
const TokenCount = z.object({ type: z.literal('token_count'), info: z.object({
  last_token_usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional() }), model_context_window: z.number().int().positive().nullish(),
}).nullish() });

/** Native journal context is distinct from the cumulative billed usage in exec's turn.completed. */
export class CodexContextRecords {
  #tokens: number | null = null;
  #window: number | undefined;
  #boundary = false;
  constructor(private readonly emit: (event: RuntimeEvent) => void) {}
  read(line: string, seed = false): void {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const record = Record.safeParse(raw); if (!record.success) return;
    if (record.data.type === 'compacted') {
      if (!seed) this.emit({ type: 'compacted', beforeTokens: this.#tokens, afterTokens: null, ...(this.#window ? { contextWindow: this.#window } : {}) });
      this.#boundary = !seed;
      return;
    }
    if (record.data.type !== 'event_msg') return;
    const counted = TokenCount.safeParse(record.data.payload); if (!counted.success || !counted.data.info) return;
    const usage = counted.data.info.last_token_usage;
    const tokens = usage.total_tokens ?? usage.input_tokens + (usage.output_tokens ?? 0);
    this.#window = counted.data.info.model_context_window ?? this.#window;
    if (!seed) {
      if (!this.#boundary && this.#tokens !== null && tokens < this.#tokens) this.emit({ type: 'compacted', beforeTokens: this.#tokens,
        afterTokens: tokens, ...(this.#window ? { contextWindow: this.#window } : {}) });
      this.emit({ type: 'context', tokens, ...(this.#window ? { contextWindow: this.#window } : {}) });
    }
    this.#tokens = tokens; this.#boundary = false;
  }
}

/** Read only new journal bytes; a resume seeds the last snapshot without replaying historic compactions. */
export class CodexContextMonitor {
  #id: string | undefined;
  #path: string | undefined;
  #offset = 0;
  #partial = '';
  #oversize = false;
  #decoder = new StringDecoder('utf8');
  #resume: boolean;
  #records: CodexContextRecords;
  constructor(private readonly home: string, emit: (event: RuntimeEvent) => void, resume?: string) {
    this.#records = new CodexContextRecords(emit); this.#resume = !!resume;
    if (resume) this.track(resume);
  }
  track(id: string): void {
    if (this.#id === id) return;
    if (!/^[a-zA-Z0-9-]{1,256}$/u.test(id)) return;
    this.#id = id; this.#path = undefined;
    this.#find();
  }
  #find(): void {
    if (!this.#id || this.#path) return;
    let visited = 0;
    const find = (path: string, depth: number): string | undefined => {
      if (depth > 8 || !existsSync(path) || !lstatSync(path).isDirectory()) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (++visited > 20_000) return;
        if (entry.isFile() && entry.name.endsWith(`-${this.#id}.jsonl`)) return join(path, entry.name);
        if (entry.isDirectory()) { const found = find(join(path, entry.name), depth + 1); if (found) return found; }
      }
      return;
    };
    this.#path = find(join(this.home, 'sessions'), 0) ?? find(join(this.home, 'archived_sessions'), 0);
    if (this.#path && this.#resume && this.#confined(this.#path)) {
      const size = lstatSync(this.#path).size;
      const start = Math.max(0, size - 128 * 1024);
      const buffer = Buffer.alloc(size - start); const fd = openSync(this.#path, 'r');
      try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
      for (const line of buffer.toString('utf8').split('\n')) this.#records.read(line, true);
      this.#offset = size; this.#resume = false;
    }
  }
  #confined(file: string): boolean {
    const path = relative(realpathSync(this.home), realpathSync(file));
    return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
  }
  poll(): void {
    try {
      this.#find(); if (!this.#path) return;
      const stat = lstatSync(this.#path); if (!stat.isFile() || !this.#confined(this.#path)) return;
      if (stat.size < this.#offset) { this.#offset = 0; this.#partial = ''; this.#oversize = false; this.#decoder = new StringDecoder('utf8'); }
      const fd = openSync(this.#path, 'r');
      try {
        // Bounded chunks avoid buffering a large resumed transcript or a large tool output.
        for (let count = 0; this.#offset < stat.size && count < 256; count++) {
          const chunk = Buffer.alloc(Math.min(32 * 1024, stat.size - this.#offset));
          const bytes = readSync(fd, chunk, 0, chunk.length, this.#offset); if (!bytes) break;
          this.#offset += bytes;
          const lines = (this.#partial + this.#decoder.write(chunk.subarray(0, bytes))).split('\n');
          this.#partial = lines.pop() ?? '';
          for (const line of lines) {
            if (this.#oversize) { this.#oversize = false; continue; }
            if (line.length <= 1024 * 1024) this.#records.read(line);
          }
          // Context records are small. Drop an oversized incomplete tool-output record.
          if (this.#oversize || this.#partial.length > 1024 * 1024) { this.#partial = ''; this.#oversize = true; }
        }
      } finally { closeSync(fd); }
    } catch { /* A journal may be created or moved while the CLI runs; the next poll retries. */ }
  }
}
