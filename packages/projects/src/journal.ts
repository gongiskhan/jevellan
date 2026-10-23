import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { setImmediate as yieldRequests } from 'node:timers/promises';
import { CoordinatorEventSchema, CoordinatorHandoffSchema, defaultProjectWorkSettings, IdSchema, JournalConfigSchema, JournalDocumentSchema, JournalRelativePathSchema, JournalThreadSchema, ProjectJournalRecordSchema, ProjectJournalRequestSchema, ProjectJournalResultSchema,
  ProjectJournalStateSchema, ProjectLedgerEventSchema, atomicWrite, parseProjectLedgerData, readDocument, stableJson, writeDocument, type Homes, type Project,
  type CoordinatorHandoff, type ProjectHub, type JournalDocument, type ProjectJournalRecord, type ProjectJournalRequest, type ProjectJournalResult, type ProjectJournalState, type Thread } from '@jevellan/core';
import type { ProjectLedger, ProjectLedgers } from './ledger.js';
import { JOURNAL_RENDERER, journalRecordKey, renderProjectJournal, threadJournalFile, validateJournalDocument } from './journal-render.js';
import { taskOrder } from './tasks.js';
import { CoordinatorReplySchema, CoordinatorTurnStartSchema, CoordinatorTurnEndSchema, CoordinatorTextSchema } from '@jevellan/core';

/** Replies belong to the completed turn that consumed this message, on the same source ledger. */
export function coordinatorReplyFromRecords(projectId: string, clientMessageId: string, records: readonly ProjectJournalRecord[]) {
  const groups = new Map<string, ProjectJournalRecord[]>();
  for (const row of records) if (row.ledgerId === 'coordinator') {
    const group = groups.get(row.deviceId) ?? []; group.push(row); groups.set(row.deviceId, group);
  }
  const replies = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.event.id - b.event.id);
    const ids = new Set(group.flatMap(row => { if (row.event.type !== 'coordinator-event') return []; const parsed = CoordinatorEventSchema.safeParse(row.event.data); return parsed.success && parsed.data.kind === 'user-message' && parsed.data.clientMessageId === clientMessageId ? [parsed.data.id] : []; }));
    for (const row of group) {
      if (row.event.type !== 'coordinator-turn-start') continue;
      const start = CoordinatorTurnStartSchema.parse(row.event.data); if (!start.eventIds.some(id => ids.has(id))) continue;
      const end = group.find(next => next.event.id > row.event.id && next.event.type === 'coordinator-turn-end' && next.event.turn === start.turn && CoordinatorTurnEndSchema.parse(next.event.data).status === 'completed');
      if (!end) continue;
      const reply = group.filter(next => next.event.id > row.event.id && next.event.id < end.event.id && next.event.turn === start.turn && next.event.type === 'coordinator-text').map(next => CoordinatorTextSchema.parse(next.event.data).text).join('');
      replies.push(CoordinatorReplySchema.parse({ schema: 'coordinator-reply-v1', projectId, turn: start.turn, reply, at: end.event.t }));
    }
  }
  return replies.sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
}

const PublishStateSchema = z.strictObject({ schema: z.literal('project-journal-publish-state-v1'), cursors: z.record(z.string(), z.number().int().nonnegative()) });
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const refuse = (text: string, status = 409): Error => Object.assign(new Error(text), { status });
type JournalLedgerIndex = { head: number; revision: number; bytes: number; latest: Map<string, import('@jevellan/core').ProjectLedgerEvent>;
  blobs: Map<string, { event: import('@jevellan/core').ProjectLedgerEvent; generation: string }>;
  records: ProjectJournalRecord[]; documents: Map<string, JournalDocument>; handoffs: CoordinatorHandoff[] };
export type JournalOptions = { homes: Homes; deviceId: string; isHub: boolean; ledgers: ProjectLedgers; hub: ProjectHub;
  projects(): Promise<Project[]>; threads(projectId: string): Thread[]; now(): number;
  dream?(projectId: string): { id: string; report: Record<string, unknown>; windowId?: string } | undefined;
  request?(request: ProjectJournalRequest): Promise<ProjectJournalResult> };

/** The existing ledgers remain authoritative. Only this hub projection writes Markdown; members install verified mirrors. */
export class ProjectJournals {
  readonly #running = new Map<string, Promise<void>>();
  readonly #publications = new Map<string, Promise<number>>();
  readonly #indexes = new Map<ProjectLedger, JournalLedgerIndex>();
  #indexBytes = 0;
  readonly #rendered = new Map<string, { head: number; inputs: string; state: string }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  constructor(readonly o: JournalOptions) {}
  #index(ledger: ProjectLedger): JournalLedgerIndex {
    // lastId validates every segment generation, including corruption outside the requested tail.
    const head = ledger.lastId(), revision = ledger.validationRevision(); let prior = this.#indexes.get(ledger);
    if (prior && head < prior.head) throw refuse('The project journal ledger moved backwards.');
    if (prior && revision !== prior.revision) {
      this.#indexBytes -= prior.bytes; this.#indexes.delete(ledger); this.#rendered.delete(ledger.projectId); prior = undefined;
    }
    const index: JournalLedgerIndex = prior ?? { head: 0, revision, bytes: 0, latest: new Map(), blobs: new Map(), records: [], documents: new Map(), handoffs: [] };
    const before = index.bytes;
    try {
      for (const entry of index.blobs.values()) {
        const generation = ledger.dataGeneration(entry.event)!;
        if (generation !== entry.generation) {
          ledger.data(entry.event);
          if (generation !== ledger.dataGeneration(entry.event)) throw refuse('The project journal blob changed during validation.');
          entry.generation = generation;
        }
      }
      if (head !== index.head) for (const event of ledger.events(index.head)) {
        if (['journal-config', 'journal-thread', 'journal-source', 'journal-document', 'coordinator-handoff'].includes(event.type)) {
          index.latest.set(event.type, event); index.bytes += Buffer.byteLength(JSON.stringify(event));
          const generation = ledger.dataGeneration(event);
          const data = ledger.payload(event);
          if (generation !== ledger.dataGeneration(event)) throw refuse('The project journal blob changed during validation.');
          if (generation !== undefined) { index.blobs.set(JSON.stringify(event.data), { event, generation }); index.bytes += Buffer.byteLength(JSON.stringify(data)); }
          if (event.type === 'journal-source') index.records.push(data as ProjectJournalRecord);
          if (event.type === 'journal-document') { const document = data as JournalDocument; index.documents.set(`${document.collection}:${document.key}`, document); }
          if (event.type === 'coordinator-handoff') index.handoffs.push(data as CoordinatorHandoff);
        }
        index.head = event.id;
      }
    } catch (error) {
      if (prior) { this.#indexBytes -= before; this.#indexes.delete(ledger); }
      throw error;
    }
    this.#indexBytes += index.bytes - (prior ? before : 0);
    this.#indexes.delete(ledger); this.#indexes.set(ledger, index);
    // Bound retained projections by their serialized source size; an evicted projection rebuilds from authoritative ledgers.
    while (this.#indexBytes > 64 * 1024 * 1024 || this.#indexes.size > 128) {
      const oldest = this.#indexes.keys().next().value!; this.#indexBytes -= this.#indexes.get(oldest)!.bytes; this.#indexes.delete(oldest);
    }
    return index;
  }
  path(projectId: string): string {
    const path = this.o.homes.at('project-journal', IdSchema.parse(projectId));
    if (path !== join(this.o.homes.root, 'project-journal', projectId)) throw refuse('The project journal cannot alias another folder.');
    return path;
  }
  readableDirectory(projectId: string): string { const path = this.path(projectId); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; }
  async handoffContext(projectId: string): Promise<{ handoff: CoordinatorHandoff | null; transcripts: string[] }> {
    await this.sync(projectId);
    const files = Object.keys(this.state(projectId).files);
    const handoffs = files.filter(path => path.startsWith('handoffs/') && path.endsWith('.json')).map(path => readDocument(this.#file(projectId, path), CoordinatorHandoffSchema));
    return { handoff: handoffs.sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence).at(-1) ?? null,
      transcripts: files.filter(path => path.startsWith('days/')).sort().map(path => this.#file(projectId, path)) };
  }
  async writeHandoff(request: Extract<ProjectJournalRequest, { operation: 'handoff-write' }>): Promise<CoordinatorHandoff> {
    await this.sync(request.projectId);
    const result = this.o.isHub ? await this.request(request, this.o.deviceId) : await this.o.request?.(request);
    if (!result || result.operation !== 'handoff-write') throw refuse('The handoff authority is unavailable.');
    if (!this.o.isHub) await this.sync(request.projectId);
    return result.handoff;
  }
  async contents(projectId: string, threadId?: string): Promise<{ path: string; text: string }> {
    await this.sync(projectId);
    const state = this.state(projectId);
    const metadata = threadId ? this.o.ledgers.thread(projectId, threadId).events().find(event => event.type === 'journal-thread') : undefined;
    const file = threadId && metadata ? threadJournalFile(this.o.ledgers.thread(projectId, threadId).payload(metadata as typeof metadata & { type: 'journal-thread' })) : 'INDEX.md';
    if (threadId && file === 'INDEX.md') throw refuse('The thread journal is not available for a checkpoint.');
    const path = join(this.path(projectId), file);
    if (!state.files[file] || !existsSync(path)) throw refuse('The project journal is not available for a checkpoint.');
    return { path, text: readFileSync(path, 'utf8') };
  }
  #statePath(projectId: string) { return this.o.homes.at('project-journal-state', `${IdSchema.parse(projectId)}.json`); }
  #publishedPath(projectId: string) { return this.o.homes.at('project-journal-publish', `${IdSchema.parse(projectId)}.json`); }
  state(projectId: string): ProjectJournalState {
    const path = this.#statePath(projectId);
    return existsSync(path) ? readDocument(path, ProjectJournalStateSchema) : { schema: 'project-journal-state-v2', renderer: JOURNAL_RENDERER, files: {}, lastLedgerEventId: null, indexUpdatedAt: '1970-01-01T00:00:00.000Z' };
  }
  start(periodic = true): void {
    if (!periodic || this.#timer || this.#closed) return;
    this.#timer = setInterval(() => { void this.syncAll().catch(() => undefined); }, 10000); this.#timer.unref();
    void this.syncAll().catch(() => undefined);
  }
  async syncAll(): Promise<void> {
    const projects = await this.o.projects(), failures: unknown[] = []; let next = 0;
    // A broken or slow project must not starve the other mirrors. Bound metadata work per sweep.
    await Promise.all(Array.from({ length: Math.min(4, projects.length) }, async () => {
      while (next < projects.length) {
        const project = projects[next++]!;
        // Hub reads resolve in microtasks; a whole sweep otherwise blocks HTTP behind synchronous durable writes.
        await yieldRequests();
        try { await this.sync(project.id); } catch (error) { failures.push(error); }
      }
    }));
    if (failures.length) throw new AggregateError(failures, 'Some project journals could not synchronize.');
  }
  sync(projectId: string, rebuild = false): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const pending = this.#running.get(projectId);
    if (pending) return rebuild ? pending.then(() => this.sync(projectId, true)) : pending;
    const work = this.#sync(projectId, rebuild).finally(() => { this.#running.delete(projectId); });
    this.#running.set(projectId, work); return work;
  }
  async #sync(projectId: string, rebuild: boolean): Promise<void> {
    const project = (await this.o.projects()).find(row => row.id === projectId); if (!project) throw refuse('Project not found.', 404);
    if (this.o.isHub) {
      const ledger = this.o.ledgers.coordinator(projectId), previous = this.#index(ledger).latest.get('journal-config');
      const settings = (await this.o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId);
      const config = JournalConfigSchema.parse({ schema: 'journal-config-v1', name: project.name, timezone: settings.nightlyWindow.timezone });
      if (!previous || stableJson(ledger.payload(previous as typeof previous & { type: 'journal-config' })) !== stableJson(config)) ledger.append({ type: 'journal-config', data: config });
    }
    await this.#captureThreads(projectId);
    if (this.o.isHub) await this.#captureDocuments(projectId, project.memory.mode === 'hub');
    const statePath = this.#publishedPath(projectId), published = existsSync(statePath) ? readDocument(statePath, PublishStateSchema) : PublishStateSchema.parse({ schema: 'project-journal-publish-state-v1', cursors: {} });
    const sources = [this.o.ledgers.coordinator(projectId), ...this.o.threads(projectId).map(thread => this.o.ledgers.thread(projectId, thread.id))];
    for (const ledger of sources) {
      const id = ledger.threadId ?? 'coordinator'; let records: ProjectJournalRecord[] = [], bytes = 0, cursor = published.cursors[id] ?? 0;
      const flush = async () => {
        if (!records.length) return;
        const request: ProjectJournalRequest = { schema: 'project-journal-request-v1', projectId, operation: 'publish', records };
        if (this.o.isHub) await this.#accept(request, this.o.deviceId); else {
          const result = await this.o.request?.(request); if (!result || result.operation !== 'publish') throw refuse('The project journal hub is unavailable.');
        }
        published.cursors[id] = cursor; writeDocument(statePath, PublishStateSchema, published); records = []; bytes = 0;
      };
      for (const event of ledger.events(published.cursors[id] ?? 0)) {
        if (event.type === 'journal-source') { cursor = event.id; continue; }
        const record = ProjectJournalRecordSchema.parse({ schema: 'project-journal-record-v1', deviceId: this.o.deviceId, ledgerId: id, event: { ...event, data: ledger.payload(event) } });
        const size = Buffer.byteLength(JSON.stringify(record));
        if (records.length && (records.length === 100 || bytes + size > 700000)) await flush();
        records.push(record); bytes += size; cursor = event.id;
      }
      await flush();
      if (published.cursors[id] !== cursor) { published.cursors[id] = cursor; writeDocument(statePath, PublishStateSchema, published); }
    }
    if (this.o.isHub) await this.#render(project, rebuild); else await this.#mirror(projectId);
  }
  async #captureThreads(projectId: string): Promise<void> {
    const tasks = await this.#all(projectId, (after) => this.o.hub.tasks(projectId, after));
    for (const thread of this.o.threads(projectId)) {
      const ledger = this.o.ledgers.thread(projectId, thread.id);
      const previous = this.#index(ledger).latest.get('journal-thread');
      const task = tasks.find(row => row.threadId === thread.id);
      const data = JournalThreadSchema.parse({ schema: 'journal-thread-v1', id: thread.id, projectId, title: thread.title,
        task: thread.brief ?? thread.task, taskId: task?.id ?? null, goal: thread.taskContext?.goal?.name ?? null, type: thread.taskContext?.type ?? null,
        runtime: thread.placement.runtime, model: thread.placement.model, effort: thread.placement.effortEffective, deviceId: thread.ownerDeviceId,
        isolation: thread.isolation, branch: thread.branch ?? null, pr: thread.pr?.number ?? null, state: thread.state, createdAt: thread.createdAt, endedAt: thread.endedAt ?? null });
      if (!previous || stableJson(ledger.payload(previous as typeof previous & { type: 'journal-thread' })) !== stableJson(data)) ledger.append({ type: 'journal-thread', data });
    }
  }
  async #all<T>(projectId: string, page: (after?: string) => Promise<{ records: T[]; next: string | null }>): Promise<T[]> {
    IdSchema.parse(projectId); const rows: T[] = []; let after: string | undefined;
    do { const result = await page(after); rows.push(...result.records); after = result.next ?? undefined; } while (after);
    return rows;
  }
  async #captureDocuments(projectId: string, hubMemory: boolean): Promise<void> {
    const ledger = this.o.ledgers.coordinator(projectId), recorded = this.#index(ledger).documents;
    const collections: Array<Array<Omit<JournalDocument, 'schema'>>> = await Promise.all([
      this.#all(projectId, after => this.o.hub.windows(projectId, after)).then(rows => rows.map(document => ({ collection: 'window' as const, key: document.id, document }))),
      this.#all(projectId, after => this.o.hub.tasks(projectId, after)).then(rows => rows.map(document => ({ collection: 'task' as const, key: document.id, document }))),
      this.o.hub.decisions(projectId).then(rows => rows.map(document => ({ collection: 'question' as const, key: document.id, document }))),
      this.#all(projectId, after => this.o.hub.jobRuns(projectId, after)).then(rows => rows.map(document => ({ collection: 'job' as const, key: document.id, document }))),
      this.#all(projectId, after => this.o.hub.mergeDocuments(projectId, after)).then(rows => rows.map(document => ({ collection: 'merge' as const, key: document.id, document }))),
      this.#all(projectId, after => this.o.hub.intakeDocuments(projectId, after)).then(rows => rows.map(document => ({ collection: 'intake' as const, key: document.id, document }))),
      this.o.hub.refill(projectId).then(row => row ? [{ collection: 'refill' as const, key: projectId, document: row.document }] : []),
    ]);
    const dream = hubMemory ? this.o.dream?.(projectId) : undefined;
    if (dream) collections.push([{ collection: 'dream', key: dream.id, document: dream.report, ...(dream.windowId ? { nightlyWindowId: dream.windowId } : {}) }]);
    const history: Array<Omit<JournalDocument, 'schema'>> = [];
    const tasks = collections.flat().filter(row => row.collection === 'task');
    for (const raw of collections.flat()) if (raw.collection === 'merge') {
      const task = tasks.find(row => row.document.threadId === raw.document.threadId);
      if (typeof task?.document.nightlyWindowId === 'string') raw.nightlyWindowId = task.document.nightlyWindowId;
    }
    for (const raw of tasks) if (stableJson(recorded.get(`task:${raw.key}`)?.document) !== stableJson(raw.document)) {
      for (const document of await this.o.hub.taskHistory(raw.key)) history.push({ collection: 'task-history', key: `${raw.key}_${document.sequence}`, document,
        ...(typeof raw.document.nightlyWindowId === 'string' ? { nightlyWindowId: raw.document.nightlyWindowId } : {}) });
    }
    collections.push(history);
    for (const raw of collections.flat()) { const data = JournalDocumentSchema.parse({ schema: 'journal-document-v1', ...raw });
      if (stableJson(recorded.get(`${data.collection}:${data.key}`)) !== stableJson(data)) ledger.append({ type: 'journal-document', data });
    }
  }
  #accept(request: Extract<ProjectJournalRequest, { operation: 'publish' }>, deviceId: string): Promise<number> {
    const prior = this.#publications.get(request.projectId) ?? Promise.resolve(0);
    const work = prior.catch(() => 0).then(() => this.#acceptRecords(request, deviceId));
    this.#publications.set(request.projectId, work);
    const finished = () => { if (this.#publications.get(request.projectId) === work) this.#publications.delete(request.projectId); };
    void work.then(finished, finished);
    return work;
  }
  async #acceptRecords(request: Extract<ProjectJournalRequest, { operation: 'publish' }>, deviceId: string): Promise<number> {
    // Large histories make each durable append expensive. Serve HTTP between records while keeping publication serialized.
    await yieldRequests();
    const ledger = this.o.ledgers.coordinator(request.projectId), previous = new Map(this.#records(request.projectId).map(record => [journalRecordKey(record), record])); let accepted = 0;
    for (const record of request.records) {
      if (record.deviceId !== deviceId || record.event.type === 'journal-source') throw refuse('Journal records must come from their own device.', 403);
      const event = ProjectLedgerEventSchema.parse(record.event); parseProjectLedgerData(event.type, event.data);
      if (event.type === 'journal-document') validateJournalDocument(event.data);
      const key = journalRecordKey(record), prior = previous.get(key);
      if (prior) { if (stableJson(prior) !== stableJson(record)) throw refuse('A journal ledger identity cannot change.'); continue; }
      ledger.append({ type: 'journal-source', data: record }); previous.set(key, record); accepted++;
      await yieldRequests();
    }
    return accepted;
  }
  #records(projectId: string): ProjectJournalRecord[] {
    return this.#index(this.o.ledgers.coordinator(projectId)).records;
  }
  async request(raw: unknown, deviceId: string): Promise<ProjectJournalResult> {
    if (!this.o.isHub) throw refuse('The journal authority is the hub.', 404);
    const input = ProjectJournalRequestSchema.parse(raw), project = (await this.o.projects()).find(row => row.id === input.projectId); if (!project) throw refuse('Project not found.', 404);
    if (input.operation === 'publish') return ProjectJournalResultSchema.parse({ schema: 'project-journal-result-v1', operation: 'publish', accepted: await this.#accept(input, deviceId) });
    if (input.operation === 'handoff-write') {
      if ((await this.o.hub.coordinator(input.projectId))?.document.deviceId !== deviceId) throw refuse('Only the assigned coordinator can write its handoff.', 403);
      await this.sync(input.projectId);
      const ledger = this.o.ledgers.coordinator(input.projectId);
      const handoffs = ledger.events().flatMap(event => event.type === 'coordinator-handoff' ? [ledger.payload(event as typeof event & { type: 'coordinator-handoff' })] : []);
      const prior = handoffs.find(row => row.id === input.id);
      if (prior) {
        if (prior.deviceId !== deviceId || prior.turn !== input.turn || stableJson({ inFlight: prior.inFlight, pendingAsks: prior.pendingAsks, decisions: prior.decisions, ownerMessages: prior.ownerMessages }) !== stableJson(input.input)) throw refuse('A handoff identity cannot change.');
        await this.sync(input.projectId, true);
        return { schema: 'project-journal-result-v1', operation: 'handoff-write', handoff: prior };
      }
      const settings = (await this.o.hub.settings(input.projectId))?.document ?? defaultProjectWorkSettings(input.projectId);
      if ((await this.o.hub.coordinator(input.projectId))?.document.deviceId !== deviceId) throw refuse('Only the assigned coordinator can write its handoff.', 403);
      const owner = new Map<string, string>();
      for (const event of [...ledger.events().filter(event => event.type === 'coordinator-event').map(event => ({ type: event.type, data: ledger.payload(event) })), ...this.#records(input.projectId).filter(row => row.ledgerId === 'coordinator').map(row => row.event)]) {
        if (event.type !== 'coordinator-event') continue;
        const item = CoordinatorEventSchema.parse(event.data); if (item.kind === 'user-message') owner.set(item.id, item.text);
      }
      const covered = new Set(handoffs.flatMap(row => row.ownerMessages.map(message => message.eventId)));
      const listed = new Set(input.input.ownerMessages.map(message => message.eventId));
      if (listed.size !== input.input.ownerMessages.length) throw refuse('Each owner message must be listed once.');
      for (const id of listed) if (!owner.has(id)) throw refuse(`Unknown owner message: ${id}.`);
      const missing = [...owner].filter(([id]) => !covered.has(id) && !listed.has(id));
      if (missing.length) throw refuse(`These owner messages are not accounted for: ${missing.map(([id, text]) => `{${id}: ${text.slice(0, 80)}}`).join(', ')}. Turn each into a thread, a task or a memory note, or mark it answered or declined, then write the handoff again.`);
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: settings.nightlyWindow.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(this.o.now()));
      // No asynchronous work between the last identity check and the durable append.
      const existing = ledger.events().filter(event => event.type === 'coordinator-handoff').map(event => ledger.payload(event as typeof event & { type: 'coordinator-handoff' }));
      const concurrent = existing.find(row => row.id === input.id);
      if (concurrent) return this.request(input, deviceId);
      const handoff = CoordinatorHandoffSchema.parse({ ...input.input, schema: 'coordinator-handoff-v1', id: input.id, projectId: input.projectId, deviceId, turn: input.turn,
        at: new Date(this.o.now()).toISOString(), date, sequence: existing.filter(row => row.date === date).length + 1 });
      ledger.append({ type: 'coordinator-handoff', turn: input.turn, data: handoff });
      await this.sync(input.projectId, true);
      return { schema: 'project-journal-result-v1', operation: 'handoff-write', handoff };
    }
    await this.sync(input.projectId, input.operation === 'rebuild');
    if (input.operation === 'coordinator-reply') return { schema: 'project-journal-result-v1', operation: 'coordinator-reply', reply: coordinatorReplyFromRecords(input.projectId, input.clientMessageId, this.#records(input.projectId)) };
    if (input.operation === 'state' || input.operation === 'rebuild') return ProjectJournalResultSchema.parse({ schema: 'project-journal-result-v1', operation: input.operation, state: this.state(input.projectId) });
    const state = this.state(input.projectId); if (state.files[input.path] !== input.sha256) throw refuse('The journal changed; read its manifest again.');
    const bytes = readFileSync(this.#file(input.projectId, input.path)); if (digest(bytes) !== input.sha256) throw refuse('The journal file does not match its manifest.');
    if (input.offset > bytes.length) throw refuse('The journal offset exceeds this file.', 400);
    return ProjectJournalResultSchema.parse({ schema: 'project-journal-result-v1', operation: 'file', path: input.path, sha256: input.sha256,
      offset: input.offset, totalBytes: bytes.length, base64: bytes.subarray(input.offset, input.offset + 250000).toString('base64') });
  }
  #file(projectId: string, path: string): string {
    JournalRelativePathSchema.parse(path); const root = this.path(projectId), result = this.o.homes.at('project-journal', projectId, path);
    if (result !== join(root, path)) throw refuse('The journal file cannot alias another path.'); return result;
  }
  #write(projectId: string, path: string, text: string | Buffer): void {
    const target = this.#file(projectId, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    atomicWrite(target, text, 0o400);
  }
  async #render(project: Project, requested: boolean): Promise<void> {
    const prior = this.state(project.id), rebuild = requested || prior.renderer !== JOURNAL_RENDERER, ledger = this.o.ledgers.coordinator(project.id), head = ledger.lastId();
    const settings = (await this.o.hub.settings(project.id))?.document ?? defaultProjectWorkSettings(project.id);
    const threads = await this.#all(project.id, after => this.o.hub.threads(project.id, after));
    const questions = (await this.o.hub.decisions(project.id)).filter(question => !question.answer && !question.withdrawnAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const tasks = await this.#all(project.id, after => this.o.hub.tasks(project.id, after));
    const inputs = digest(stableJson({ name: project.name, nightlyWindow: settings.nightlyWindow, threads, questions, tasks })), previous = this.#rendered.get(project.id);
    if (!rebuild && previous?.head === head && previous.inputs === inputs && previous.state === digest(stableJson(prior)) && Object.keys(prior.files).every(path => existsSync(this.#file(project.id, path)))) return;
    const records = this.#records(project.id);
    const headers = new Map<string, ReturnType<typeof JournalThreadSchema.parse>>();
    for (const record of records) if (record.event.type === 'journal-thread') { const data = JournalThreadSchema.parse(record.event.data); if (!headers.has(data.id)) headers.set(data.id, data); }
    const open = threads.filter(thread => !['done', 'stopped', 'failed'].includes(thread.state)).map(thread => `- Thread "${thread.title.replace(/[\r\n]/gu, ' ')}" (${thread.runtime} ${thread.modelLabel}, ${thread.state}${thread.pr ? `, PR #${thread.pr.number} ${thread.pr.checks}` : ''})${headers.has(thread.id) ? ` → ${threadJournalFile(headers.get(thread.id)!)}` : ' (no journal yet)'}`);
    for (const [index, question] of questions.entries()) {
      const source = records.findLast(record => record.event.type === 'journal-document' && JournalDocumentSchema.parse(record.event.data).collection === 'question' && JournalDocumentSchema.parse(record.event.data).key === question.id);
      const path = question.threadId && headers.has(question.threadId) ? threadJournalFile(headers.get(question.threadId)!)
        : source ? `days/${new Intl.DateTimeFormat('en-CA', { timeZone: settings.nightlyWindow.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(source.event.t))}.md` : 'INDEX.md';
      open.push(`- Question ${index + 1}: [${threads.find(thread => thread.id === question.threadId)?.title ?? 'Coordinator'}] ${question.question.replace(/[\r\n]/gu, ' ')} → ${path}${source ? `#e-${journalRecordKey(source)}` : ''}`);
    }
    open.push(`- Queue: ${tasks.filter(task => task.state === 'queued').sort(taskOrder).slice(0, 10).map(task => task.title.replace(/[\r\n]/gu, ' ')).join('; ') || '(none)'}`);
    const windows = new Map<string, Record<string, unknown>>();
    for (const record of records) if (record.event.type === 'journal-document') { const data = JournalDocumentSchema.parse(record.event.data); if (data.collection === 'window') windows.set(data.key, data.document); }
    const activeWindow = [...windows.values()].find(window => window.state === 'open');
    open.push(`- Nightly: ${activeWindow ? `window in progress (${String(activeWindow.date)})` : settings?.nightlyWindow.enabled ? `${settings.nightlyWindow.time} ${settings.nightlyWindow.timezone}` : '(disabled)'}`);
    const index = this.#index(ledger), latest = index.latest.get('journal-source');
    const updatedAt = latest?.t ?? '1970-01-01T00:00:00.000Z';
    const rendered = renderProjectJournal({ name: project.name, timezone: settings.nightlyWindow.timezone, records, open, updatedAt });
    const handoffs = index.handoffs;
    for (const handoff of handoffs) {
      const path = `handoffs/${handoff.date}-${handoff.sequence}`;
      rendered.files[`${path}.json`] = `${JSON.stringify(handoff, null, 2)}\n`;
      rendered.files[`${path}.md`] = `# Coordinator handoff ${handoff.date}-${handoff.sequence}\n\nIn flight:\n${handoff.inFlight}\n\nPending asks:\n${handoff.pendingAsks || '(none)'}\n\nDecisions:\n${handoff.decisions || '(none)'}\n\nOwner messages:\n${handoff.ownerMessages.map(row => `- ${row.eventId}: ${row.outcome}${row.ref ? ` (${row.ref})` : ''}`).join('\n') || '(none)'}\n`;
    }
    if (handoffs.length) rendered.files['INDEX.md'] += `\n## Coordinator handoffs\n${handoffs.map(row => `- ${row.date}-${row.sequence} → handoffs/${row.date}-${row.sequence}.md`).join('\n')}\n`;
    const state: ProjectJournalState = { schema: 'project-journal-state-v2', renderer: JOURNAL_RENDERER, lastLedgerEventId: records.at(-1) ? journalRecordKey(records.at(-1)!) : null, files: {}, indexUpdatedAt: new Date(this.o.now()).toISOString() };
    let indexDeferred = false;
    for (const [path, text] of Object.entries(rendered.files)) {
      if (path === 'INDEX.md' && !rebuild && this.o.now() - Date.parse(prior.indexUpdatedAt) < 10000) { if (prior.files[path]) state.files[path] = prior.files[path]; state.indexUpdatedAt = prior.indexUpdatedAt; indexDeferred = prior.files[path] !== digest(text) || !existsSync(this.#file(project.id, path)); continue; }
      const hash = digest(text); state.files[path] = hash;
      if (path === 'INDEX.md' && prior.files[path] === hash && existsSync(this.#file(project.id, path))) state.indexUpdatedAt = prior.indexUpdatedAt;
      if (prior.files[path] !== hash || !existsSync(this.#file(project.id, path))) {
        if (!rebuild && path !== 'INDEX.md' && existsSync(this.#file(project.id, path)) && !text.startsWith(readFileSync(this.#file(project.id, path), 'utf8'))) throw refuse('A journal projection cannot replace earlier entries.');
        this.#write(project.id, path, text);
      }
    }
    if (stableJson(state) !== stableJson(prior)) writeDocument(this.#statePath(project.id), ProjectJournalStateSchema, state);
    if (!indexDeferred) this.#rendered.set(project.id, { head, inputs, state: digest(stableJson(state)) }); else this.#rendered.delete(project.id);
  }
  async #mirror(projectId: string): Promise<void> {
    const response = await this.o.request?.({ schema: 'project-journal-request-v1', projectId, operation: 'state' });
    if (!response || response.operation !== 'state') throw refuse('The project journal hub is unavailable.');
    const next = response.state, before = this.state(projectId);
    for (const [path, hash] of Object.entries(next.files)) {
      if (before.files[path] === hash && existsSync(this.#file(projectId, path))) continue;
      const chunks: Buffer[] = []; let offset = 0, total = 1;
      while (offset < total) {
        const result = await this.o.request?.({ schema: 'project-journal-request-v1', projectId, operation: 'file', path, sha256: hash, offset });
        if (!result || result.operation !== 'file' || result.offset !== offset || result.path !== path || result.sha256 !== hash) throw refuse('The journal mirror received a different file.');
        const bytes = Buffer.from(result.base64, 'base64'); total = result.totalBytes;
        if (bytes.length === 0 && offset !== total) throw refuse('The journal mirror stopped before its file ended.'); chunks.push(bytes); offset += bytes.length;
      }
      const bytes = Buffer.concat(chunks); if (bytes.length !== total || digest(bytes) !== hash) throw refuse('The journal mirror failed its hash check.'); this.#write(projectId, path, bytes);
    }
    if (stableJson(next) !== stableJson(before)) writeDocument(this.#statePath(projectId), ProjectJournalStateSchema, next);
  }
  async close(): Promise<void> { this.#closed = true; if (this.#timer) clearInterval(this.#timer); await Promise.allSettled([...this.#running.values(), ...this.#publications.values()]); this.#indexes.clear(); this.#indexBytes = 0; this.#rendered.clear(); }
}
