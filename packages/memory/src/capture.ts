import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MemoryCaptureCursorSchema, MemoryCaptureSchema, inside, readDocument, writeDocument,
  type Homes, type MemoryCapture, type SecretRedactor } from '@jevellan/core';

const SliceSchema = z.strictObject({ schema: z.literal('memory-capture-slice-v1'), capture: MemoryCaptureSchema, text: z.string().max(300_000) });
export type CapturedSlice = z.infer<typeof SliceSchema>;
const id = (value: string) => createHash('sha256').update(value).digest('hex');
type Source = Omit<MemoryCapture, 'schema' | 'id' | 'fromByte' | 'toByte' | 'at' | 'processedAt' | 'extractionId'>;

/** Incremental native journal capture; only redacted slices enter the hub queue. */
export class ProjectCaptureQueue {
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly #processed = new Map<string, string>();
  constructor(readonly homes: Homes, readonly redactor: SecretRedactor, readonly now: () => number = Date.now) {}
  directory(projectId: string) { return this.homes.ensure('project-memory', projectId, 'captures'); }
  accept(raw: MemoryCapture, text: string): void {
    const capture = MemoryCaptureSchema.parse(raw), file = join(this.directory(capture.projectId), `${capture.id}.json`);
    const slice = SliceSchema.parse({ schema: 'memory-capture-slice-v1', capture, text: this.redactor.text(text) });
    if (existsSync(file)) {
      const prior = readDocument(file, SliceSchema);
      if (prior.capture.sessionId !== capture.sessionId || prior.capture.fromByte !== capture.fromByte || prior.capture.toByte !== capture.toByte || prior.text !== slice.text) throw new Error('A capture id cannot refer to different transcript bytes.');
      return;
    }
    writeDocument(file, SliceSchema, slice);
  }
  async capture(source: Source, accountHome: string, send: (capture: MemoryCapture, text: string) => Promise<void>): Promise<number> {
    const key = id(`${source.projectId}\0${source.runtime}\0${source.sessionId}\0${source.transcriptPath}`);
    const work = (this.#pending.get(key) ?? Promise.resolve()).then(() => this.#capture(source, accountHome, key, send));
    const settled = work.then(() => undefined, () => undefined); this.#pending.set(key, settled);
    void settled.then(() => { if (this.#pending.get(key) === settled) this.#pending.delete(key); }); return work;
  }
  async #capture(source: Source, accountHome: string, key: string, send: (capture: MemoryCapture, text: string) => Promise<void>): Promise<number> {
    const root = realpathSync(accountHome), file = realpathSync(source.transcriptPath);
    if (!inside(root, file) || file !== source.transcriptPath || !lstatSync(file).isFile()) throw new Error('Capture needs a regular journal in this Jevellan account home.');
    const cursorPath = join(this.homes.ensure('project-memory', source.projectId, 'capture-cursors'), `${key}.json`);
    const previous = existsSync(cursorPath) ? readDocument(cursorPath, MemoryCaptureCursorSchema) : undefined;
    let from = previous?.byte ?? 0; const end = statSync(file).size;
    if (end < from) throw new Error('The native transcript shrank. Its previous capture cursor was preserved.');
    if (end === from) return 0;
    let pending = Buffer.alloc(0), batch = '', through = from, captured = 0;
    const flush = async () => {
      if (through === from) return;
      const capture = MemoryCaptureSchema.parse({ ...source, transcriptPath: file, schema: 'memory-capture-v1', id: `capture_${id(`${key}:${from}:${through}`)}`,
        fromByte: from, toByte: through, at: new Date(this.now()).toISOString(), processedAt: null, extractionId: null });
      await send(capture, batch); captured += through - from; from = through; batch = '';
      writeDocument(cursorPath, MemoryCaptureCursorSchema, { schema: 'memory-capture-cursor-v1', sessionId: source.sessionId, transcriptPath: file, byte: from });
    };
    // Redact whole JSONL records before batching: a token cannot leak through a chunk boundary.
    const stream = createReadStream(file, { start: from, end: end - 1, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk as Buffer]); let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        const record = pending.subarray(0, newline + 1); pending = pending.subarray(newline + 1);
        const text = this.redactor.text(record.toString('utf8'));
        if (text.length > 300_000) {
          await flush(); const start = through; through += record.length;
          const fragments: string[] = [];
          for (let offset = 0; offset < text.length;) {
            let end = Math.min(offset + 290_000, text.length);
            if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
            fragments.push(text.slice(offset, end)); offset = end;
          }
          // Every fragment refers to the complete source record. Advance only after all are acknowledged.
          for (const [index, value] of fragments.entries()) await send(MemoryCaptureSchema.parse({ ...source, transcriptPath: file, schema: 'memory-capture-v1',
            id: `capture_${id(`${key}:${start}:${through}:${index}`)}`, fromByte: start, toByte: through, fragment: { index, count: fragments.length },
            at: new Date(this.now()).toISOString(), processedAt: null, extractionId: null }), value);
          captured += through - from; from = through;
          writeDocument(cursorPath, MemoryCaptureCursorSchema, { schema: 'memory-capture-cursor-v1', sessionId: source.sessionId, transcriptPath: file, byte: from });
          continue;
        }
        if (batch.length + text.length > 300_000) await flush();
        batch += text; through += record.length;
      }
      if (pending.length > 8 * 1024 * 1024) { stream.destroy(); throw new Error('A transcript record exceeded 8 MB. Capture will retry without advancing its cursor.'); }
    }
    // A partially written record waits until the provider finishes it.
    await flush(); return captured;
  }
  slices(projectId: string, unprocessed = true): CapturedSlice[] {
    const directory = this.directory(projectId);
    return readdirSync(directory).filter(file => file.endsWith('.json')).flatMap(file => {
      const path = join(directory, file), stat = statSync(path, { bigint: true });
      const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      // Processed transcript text is immutable between file generations. Keep only its validated metadata,
      // never the text; a peer's atomic replacement or in-place change must be read and validated again.
      if (unprocessed && this.#processed.get(path) === signature) return [];
      const slice = readDocument(path, SliceSchema);
      if (slice.capture.processedAt) {
        this.#processed.delete(path); this.#processed.set(path, signature);
        if (this.#processed.size > 8192) this.#processed.delete(this.#processed.keys().next().value!);
      } else this.#processed.delete(path);
      return unprocessed && slice.capture.processedAt ? [] : [slice];
    }).sort((a, b) => b.capture.at.localeCompare(a.capture.at) || b.capture.toByte - a.capture.toByte || (b.capture.fragment?.index ?? 0) - (a.capture.fragment?.index ?? 0));
  }
  extractionInput(projectId: string): { text: string; captures: MemoryCapture[]; bytes: number } {
    const slices = this.slices(projectId), bytes = slices.reduce((sum, slice) => sum + Buffer.byteLength(slice.text), 0);
    const suffix = '\n[Older transcript parts were trimmed to the 300 KB extraction limit.]';
    let text = '', remaining = 300_000 - Buffer.byteLength(suffix), trimmed = false; const captures: MemoryCapture[] = [];
    for (const slice of slices) {
      captures.push(slice.capture);
      const block = `\nSession excerpt (${slice.capture.scope}, ${slice.capture.runtime} ${slice.capture.model}, ${slice.capture.at}${slice.capture.threadId ? `, threadId ${slice.capture.threadId}` : ''}${slice.capture.taskId ? `, taskId ${slice.capture.taskId}` : ''}):\n${slice.text}`;
      const data = Buffer.from(block);
      if (data.length > remaining) {
        // Leave room for the explanation and never split a Unicode code point.
        let end = Math.max(0, remaining);
        while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
        text += data.subarray(0, end).toString('utf8'); remaining -= end; trimmed = true;
      } else { text += block; remaining -= data.length; }
    }
    if (trimmed) text += suffix;
    return { text, captures, bytes };
  }
  processed(projectId: string, captures: MemoryCapture[], extractionId: string): void {
    for (const capture of captures) {
      const file = join(this.directory(projectId), `${capture.id}.json`), slice = readDocument(file, SliceSchema);
      if (!slice.capture.processedAt) writeDocument(file, SliceSchema, { ...slice, capture: { ...slice.capture, processedAt: new Date(this.now()).toISOString(), extractionId } });
    }
  }
  async close(): Promise<void> { await Promise.allSettled([...this.#pending.values()]); this.#processed.clear(); }
}
