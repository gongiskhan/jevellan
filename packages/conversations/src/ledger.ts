import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import {
  BlobDocumentSchema, BlobReferenceSchema, HandoffSchema, Homes, IdSchema, LedgerEventSchema, LedgerLockSchema,
  SecretRedactor, StretchSchema, atomicWrite, readDocument, resolvedPath, stableJson,
  type BlobReference, type DocumentSchema, type Handoff, type LedgerEvent, writeDocument,
} from '@jevellan/core';

export const LEDGER_ROLL_BYTES = 10 * 1024 * 1024;
export const BLOB_SPILL_BYTES = 64 * 1024;
export type LedgerEnvelope = { schema: string; t: string; id: number; type: string; data: unknown };
/** The envelope schema, its literal, the error prefix and the folders created on the first write. */
export type LedgerSpec<E extends LedgerEnvelope> = { schema: DocumentSchema<E>; literal: E['schema']; label: 'Conversation' | 'Project'; folders: readonly string[] };
export type LedgerAppend<E extends LedgerEnvelope> = { type: E['type']; data: unknown; t?: string } & Partial<Omit<E, 'schema' | 't' | 'id' | 'type' | 'data'>>;
export type LedgerOptions = { redactor?: SecretRedactor; rollBytes?: number; now?: () => string };

/**
 * Append-only JSONL segments with content-addressed blobs. The owner daemon is the only writer.
 * Blobs keep the internal conversation-blob-v1 document for every ledger kind.
 */
export class JsonlLedger<E extends LedgerEnvelope> {
  readonly #spec: LedgerSpec<E>;
  readonly #redactor: SecretRedactor;
  readonly #rollBytes: number;
  readonly #now: () => string;
  readonly #listeners = new Set<(event: E) => void>();
  constructor(readonly dir: string, spec: LedgerSpec<E>, options: LedgerOptions = {}) {
    if (!isAbsolute(dir) || resolvedPath(dir) !== dir) throw new Error(`${spec.label} directories cannot alias another location.`);
    this.#spec = spec;
    this.#redactor = options.redactor ?? new SecretRedactor();
    this.#rollBytes = options.rollBytes ?? LEDGER_ROLL_BYTES;
    if (!Number.isSafeInteger(this.#rollBytes) || this.#rollBytes < 1) throw new Error('Invalid ledger roll size.');
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  protected path(...parts: string[]): string {
    const path = join(this.dir, ...parts);
    if (resolvedPath(path) !== path) throw new Error(`${this.#spec.label} files cannot alias another location.`);
    return path;
  }
  #ensure(): void {
    for (const name of this.#spec.folders) mkdirSync(this.path(name), { recursive: true, mode: 0o700 });
  }
  redact<T>(value: T): T { return this.#redactor.document(value); }
  /** Notifications follow durability and run after the append lock is released. */
  subscribe(listener: (event: E) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  segments(): string[] {
    const directory = this.path('ledger');
    if (!existsSync(directory)) return [];
    const names = readdirSync(directory).filter((name) => /^\d{6,}\.jsonl$/.test(name)).sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
    for (let i = 0; i < names.length; i++) {
      if (Number(names[i]!.split('.')[0]) !== i + 1) throw new Error(`${this.#spec.label} ledger segment is missing.`);
    }
    return names.map((name) => this.path('ledger', name));
  }
  events(afterId = 0, limit = Number.MAX_SAFE_INTEGER): E[] {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid ledger range.');
    const result: E[] = []; let expected = 1;
    for (const path of this.segments()) {
      const text = readFileSync(path, 'utf8');
      // An interrupted append has no newline. Preserve that fragment on disk;
      // the next append starts a new segment without reusing an accepted id.
      const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').slice(0, -1);
      for (const line of lines) {
        let event: E;
        try { event = this.#spec.schema.parse(JSON.parse(line)); }
        catch { throw new Error(`${this.#spec.label} ledger contains an invalid record.`); }
        if (event.id !== expected++) throw new Error(`${this.#spec.label} ledger event sequence is broken.`);
        if (event.id > afterId && result.length < limit) result.push(event);
      }
    }
    return result;
  }
  /** A full replay, so a corrupt record anywhere stops the caller (D117). */
  lastId(): number { return this.events().at(-1)?.id ?? 0; }
  putBlob(content: unknown): BlobReference {
    this.#ensure();
    const document = BlobDocumentSchema.parse({ schema: 'conversation-blob-v1', content: this.#redactor.document(content) });
    const bytes = Buffer.from(stableJson(document));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const pointer = BlobReferenceSchema.parse({ schema: 'blob-ref-v1', ref: `blobs/${sha256}`, sha256, bytes: bytes.length });
    const path = this.path('blobs', sha256);
    if (existsSync(path)) this.readBlob(pointer);
    else atomicWrite(path, bytes);
    return pointer;
  }
  readBlob(pointer: BlobReference | string): unknown {
    const ref = typeof pointer === 'string' ? pointer : BlobReferenceSchema.parse(pointer).ref;
    if (!/^blobs\/[a-f0-9]{64}$/.test(ref)) throw new Error(`Invalid ${this.#spec.label.toLowerCase()} blob reference.`);
    const bytes = readFileSync(this.path(ref));
    if (createHash('sha256').update(bytes).digest('hex') !== ref.slice(6) || (typeof pointer !== 'string' && bytes.length !== pointer.bytes)) throw new Error(`${this.#spec.label} blob integrity check failed.`);
    return BlobDocumentSchema.parse(JSON.parse(bytes.toString('utf8'))).content;
  }
  data(event: E): unknown {
    const value = event.data;
    if (value && typeof value === 'object' && 'schema' in value && value.schema === 'blob-ref-v1') return this.readBlob(BlobReferenceSchema.parse(value));
    return value;
  }
  protected exclusive<T>(run: () => T): T {
    this.#ensure();
    const lock = this.path('.append-lock');
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${this.#spec.label} ledger is locked by another writer; recover it at owner startup.`);
      throw error;
    }
    try { writeFileSync(fd, JSON.stringify(LedgerLockSchema.parse({ schema: 'ledger-lock-v1', pid: process.pid }))); fsyncSync(fd); return run(); }
    finally { closeSync(fd); unlinkSync(lock); }
  }
  /** Called only during exclusive owner-daemon startup, before accepting traffic. */
  recoverAbandonedWrite(): void {
    const path = this.path('.append-lock');
    if (!existsSync(path)) return;
    // A crash between exclusive creation and the small lock record write.
    // The caller already owns the daemon home before this startup-only recovery.
    if (lstatSync(path).size === 0) { unlinkSync(path); return; }
    const lock = readDocument(path, LedgerLockSchema);
    try { process.kill(lock.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); return; }
      throw error;
    }
    throw new Error(`${this.#spec.label} ledger writer is still alive.`);
  }
  append(input: LedgerAppend<E>): E { return this.exclusive(() => this.appendLocked(input)); }
  /** Appends while the caller holds exclusive(). */
  protected appendLocked(input: LedgerAppend<E>): E {
    const previous = this.lastId();
    const document = BlobDocumentSchema.parse({ schema: 'conversation-blob-v1', content: this.#redactor.document(input.data) });
    const data = Buffer.byteLength(stableJson(document.content)) > BLOB_SPILL_BYTES ? this.putBlob(document.content) : document.content;
    const event = this.#spec.schema.parse({ ...input, data, schema: this.#spec.literal, id: previous + 1, t: input.t ?? this.#now() });
    const segments = this.segments(); let path = segments.at(-1);
    const bytes = path ? readFileSync(path) : Buffer.alloc(0);
    if (!path || bytes.length >= this.#rollBytes || (bytes.length > 0 && bytes.at(-1) !== 10)) path = this.path('ledger', `${String(segments.length + 1).padStart(6, '0')}.jsonl`);
    const fd = openSync(path, 'a', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    // A reader never sees an acknowledged event whose file was not flushed.
    const directory = openSync(this.path('ledger'), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    queueMicrotask(() => {
      for (const listener of this.#listeners) {
        try { listener(structuredClone(event)); }
        catch { this.#listeners.delete(listener); }
      }
    });
    return event;
  }
  search(query: string): Array<{ pointer: string; snippet: string }> {
    if (!query.trim()) return [];
    const needle = query.toLowerCase(); const matches: Array<{ pointer: string; snippet: string }> = [];
    for (const event of this.events()) {
      const text = stableJson(this.data(event)); const index = text.toLowerCase().indexOf(needle);
      if (index >= 0) matches.push({ pointer: `ledger/${event.id}`, snippet: text.slice(Math.max(0, index - 100), index + needle.length + 200) });
      if (matches.length === 20) break;
    }
    return matches;
  }
  /** Reads `blobs/<sha256>` and `ledger/<id>` pointers. */
  read(pointer: string): unknown {
    if (/^blobs\/[a-f0-9]{64}$/.test(pointer)) return this.readBlob(pointer);
    const ledger = /^ledger\/([1-9]\d*)$/.exec(pointer);
    if (ledger) { const event = this.events(Number(ledger[1]) - 1, 1)[0]; if (event?.id === Number(ledger[1])) return { ...event, data: this.data(event) }; }
    throw new Error(`${this.#spec.label} pointer does not exist.`);
  }
}

const conversationLedger: LedgerSpec<LedgerEvent> = { schema: LedgerEventSchema, literal: 'ledger-event-v1', label: 'Conversation', folders: ['', 'ledger', 'handoffs', 'blobs'] };
function conversationDirectory(homes: Homes, id: string): string {
  IdSchema.parse(id);
  const dir = homes.at('conversations', id);
  if (dir !== join(homes.root, 'conversations', id)) throw new Error('Conversation directories cannot alias another location.');
  return dir;
}

/** The owner daemon is the only writer. Other devices forward writes to it. */
export class ConversationLedger extends JsonlLedger<LedgerEvent> {
  constructor(homes: Homes, readonly id: string, options: LedgerOptions = {}) {
    super(conversationDirectory(homes, id), conversationLedger, options);
  }
  writeProjection<T>(name: string, schema: DocumentSchema<T>, value: unknown): void {
    if (!/^(?:conversation\.json|summary\.json|(?:stretches|decisions)\/\d{4,}\.json|work\/[A-Za-z0-9_-]+\.json)$/.test(name)) throw new Error('Invalid conversation projection path.');
    writeDocument(this.path(name), schema, value);
  }
  handoffs(): Handoff[] {
    return this.events().filter((event) => event.type === 'handoff').map((event) => HandoffSchema.parse(this.data(event)));
  }
  acceptHandoff(raw: unknown): { handoff: Handoff; eventId: number; repeated: boolean } {
    return this.exclusive(() => {
      const handoff = HandoffSchema.parse(this.redact(raw));
      const events = this.events();
      const existing = events.find((event) => event.type === 'handoff' && event.stretch === handoff.stretch);
      if (existing) {
        if (stableJson(this.data(existing)) !== stableJson(handoff)) throw new Error('This step already handed off.');
        this.#materialiseHandoff(handoff);
        return { handoff, eventId: existing.id, repeated: true };
      }
      const last = events.filter((event) => event.type === 'stretch-start' || event.type === 'stretch-end').at(-1);
      if (!last || last.type !== 'stretch-start' || last.stretch !== handoff.stretch) throw new Error('Handoff does not belong to the current stretch.');
      const stretch = StretchSchema.parse(this.data(last));
      if (stretch.action !== handoff.action) throw new Error('Handoff action does not match the stretch.');
      if (handoff.result) this.readBlob(handoff.result.ref);
      const event = this.appendLocked({ type: 'handoff', stretch: handoff.stretch, data: handoff });
      this.#materialiseHandoff(handoff);
      return { handoff, eventId: event.id, repeated: false };
    });
  }
  #materialiseHandoff(handoff: Handoff): void {
    const path = this.path('handoffs', `${String(handoff.stretch).padStart(4, '0')}.json`);
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || stableJson(readDocument(path, HandoffSchema)) !== stableJson(handoff)) throw new Error('Immutable handoff differs from its ledger receipt.');
    } else atomicWrite(path, `${JSON.stringify(handoff, null, 2)}\n`);
  }
  recoverHandoffs(): void { for (const handoff of this.handoffs()) this.#materialiseHandoff(handoff); }
  /** Adds `handoffs/<stretch>` pointers to the ledger and blob pointers. */
  override read(pointer: string): unknown {
    const handoff = /^handoffs\/([1-9]\d*)$/.exec(pointer);
    if (handoff) { const result = this.handoffs().find((entry) => entry.stretch === Number(handoff[1])); if (result) return result; }
    return super.read(pointer);
  }
}
