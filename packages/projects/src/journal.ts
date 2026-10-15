import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { defaultProjectWorkSettings, IdSchema, JournalConfigSchema, JournalDocumentSchema, JournalRelativePathSchema, JournalThreadSchema, ProjectJournalRecordSchema, ProjectJournalRequestSchema, ProjectJournalResultSchema,
  ProjectJournalStateSchema, ProjectLedgerEventSchema, atomicWrite, parseProjectLedgerData, readDocument, stableJson, writeDocument, type Homes, type Project,
  type ProjectHub, type JournalDocument, type ProjectJournalRecord, type ProjectJournalRequest, type ProjectJournalResult, type ProjectJournalState, type Thread } from '@jevellan/core';
import type { ProjectLedgers } from './ledger.js';
import { journalRecordKey, renderProjectJournal, threadJournalFile, validateJournalDocument } from './journal-render.js';
import { taskOrder } from './tasks.js';

const PublishStateSchema = z.strictObject({ schema: z.literal('project-journal-publish-state-v1'), cursors: z.record(z.string(), z.number().int().nonnegative()) });
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const refuse = (text: string, status = 409): Error => Object.assign(new Error(text), { status });
export type JournalOptions = { homes: Homes; deviceId: string; isHub: boolean; ledgers: ProjectLedgers; hub: ProjectHub;
  projects(): Promise<Project[]>; threads(projectId: string): Thread[]; now(): number;
  dream?(projectId: string): { id: string; report: Record<string, unknown>; windowId?: string } | undefined;
  request?(request: ProjectJournalRequest): Promise<ProjectJournalResult> };

/** The existing ledgers remain authoritative. Only this hub projection writes Markdown; members install verified mirrors. */
export class ProjectJournals {
  readonly #running = new Map<string, Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  constructor(readonly o: JournalOptions) {}
  path(projectId: string): string {
    const path = this.o.homes.at('project-journal', IdSchema.parse(projectId));
    if (path !== join(this.o.homes.root, 'project-journal', projectId)) throw refuse('The project journal cannot alias another folder.');
    return path;
  }
  readableDirectory(projectId: string): string { const path = this.path(projectId); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; }
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
    return existsSync(path) ? readDocument(path, ProjectJournalStateSchema) : { schema: 'project-journal-state-v1', files: {}, lastLedgerEventId: null, indexUpdatedAt: '1970-01-01T00:00:00.000Z' };
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
      const ledger = this.o.ledgers.coordinator(projectId), previous = ledger.events().findLast(event => event.type === 'journal-config');
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
        if (this.o.isHub) this.#accept(request, this.o.deviceId); else {
          const result = await this.o.request?.(request); if (!result || result.operation !== 'publish') throw refuse('The project journal hub is unavailable.');
        }
        published.cursors[id] = cursor; writeDocument(statePath, PublishStateSchema, published); records = []; bytes = 0;
      };
      for (const event of ledger.events()) {
        if (event.id <= (published.cursors[id] ?? 0)) continue;
        if (event.type === 'journal-source') { cursor = event.id; continue; }
        const record = ProjectJournalRecordSchema.parse({ schema: 'project-journal-record-v1', deviceId: this.o.deviceId, ledgerId: id, event: { ...event, data: ledger.payload(event) } });
        const size = Buffer.byteLength(JSON.stringify(record));
        if (records.length && (records.length === 100 || bytes + size > 700000)) await flush();
        records.push(record); bytes += size; cursor = event.id;
      }
      await flush(); published.cursors[id] = cursor; writeDocument(statePath, PublishStateSchema, published);
    }
    if (this.o.isHub) await this.#render(project, rebuild); else await this.#mirror(projectId);
  }
  async #captureThreads(projectId: string): Promise<void> {
    const tasks = await this.#all(projectId, (after) => this.o.hub.tasks(projectId, after));
    for (const thread of this.o.threads(projectId)) {
      const ledger = this.o.ledgers.thread(projectId, thread.id);
      const previous = ledger.events().findLast(event => event.type === 'journal-thread');
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
    const ledger = this.o.ledgers.coordinator(projectId), recorded = new Map<string, JournalDocument>();
    for (const event of ledger.events()) if (event.type === 'journal-document') { const data = ledger.payload(event as typeof event & { type: 'journal-document' }); recorded.set(`${data.collection}:${data.key}`, data); }
    const collections: Array<Array<Omit<JournalDocument, 'schema'>>> = await Promise.all([
      this.#all(projectId, after => this.o.hub.windows(projectId, after)).then(rows => rows.map(document => ({ collection: 'window' as const, key: document.id, document }))),
      this.#all(projectId, after => this.o.hub.tasks(projectId, after)).then(rows => rows.map(document => ({ collection: 'task' as const, key: document.id, document }))),
      this.o.hub.decisions(projectId).then(rows => rows.map(document => ({ collection: 'question' as const, key: document.id, document }))),
      this.#all(projectId, after => this.o.hub.jobRuns(projectId, after)).then(rows => rows.map(document => ({ collection: 'job' as const, key: document.id, document }))),
      this.#all(projectId, after => this.o.hub.mergeDocuments(projectId, after)).then(rows => rows.map(document => ({ collection: 'merge' as const, key: document.id, document }))),
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
  #accept(request: Extract<ProjectJournalRequest, { operation: 'publish' }>, deviceId: string): number {
    const ledger = this.o.ledgers.coordinator(request.projectId), previous = new Map(this.#records(request.projectId).map(record => [journalRecordKey(record), record])); let accepted = 0;
    for (const record of request.records) {
      if (record.deviceId !== deviceId || record.event.type === 'journal-source') throw refuse('Journal records must come from their own device.', 403);
      const event = ProjectLedgerEventSchema.parse(record.event); parseProjectLedgerData(event.type, event.data);
      if (event.type === 'journal-document') validateJournalDocument(event.data);
      const key = journalRecordKey(record), prior = previous.get(key);
      if (prior) { if (stableJson(prior) !== stableJson(record)) throw refuse('A journal ledger identity cannot change.'); continue; }
      ledger.append({ type: 'journal-source', data: record }); previous.set(key, record); accepted++;
    }
    return accepted;
  }
  #records(projectId: string): ProjectJournalRecord[] {
    const ledger = this.o.ledgers.coordinator(projectId);
    return ledger.events().flatMap(event => event.type === 'journal-source' ? [ledger.payload(event as typeof event & { type: 'journal-source' })] : []);
  }
  async request(raw: unknown, deviceId: string): Promise<ProjectJournalResult> {
    if (!this.o.isHub) throw refuse('The journal authority is the hub.', 404);
    const input = ProjectJournalRequestSchema.parse(raw), project = (await this.o.projects()).find(row => row.id === input.projectId); if (!project) throw refuse('Project not found.', 404);
    if (input.operation === 'publish') return ProjectJournalResultSchema.parse({ schema: 'project-journal-result-v1', operation: 'publish', accepted: this.#accept(input, deviceId) });
    await this.sync(input.projectId, input.operation === 'rebuild');
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
  async #render(project: Project, rebuild: boolean): Promise<void> {
    const records = this.#records(project.id), prior = this.state(project.id), settings = (await this.o.hub.settings(project.id))?.document ?? defaultProjectWorkSettings(project.id);
    const threads = await this.#all(project.id, after => this.o.hub.threads(project.id, after));
    const headers = new Map<string, ReturnType<typeof JournalThreadSchema.parse>>();
    for (const record of records) if (record.event.type === 'journal-thread') { const data = JournalThreadSchema.parse(record.event.data); if (!headers.has(data.id)) headers.set(data.id, data); }
    const open = threads.filter(thread => !['done', 'stopped', 'failed'].includes(thread.state)).map(thread => `- Thread "${thread.title.replace(/[\r\n]/gu, ' ')}" (${thread.runtime} ${thread.modelLabel}, ${thread.state}${thread.pr ? `, PR #${thread.pr.number} ${thread.pr.checks}` : ''})${headers.has(thread.id) ? ` → ${threadJournalFile(headers.get(thread.id)!)}` : ' (no journal yet)'}`);
    const questions = (await this.o.hub.decisions(project.id)).filter(question => !question.answer && !question.withdrawnAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const [index, question] of questions.entries()) {
      const source = records.findLast(record => record.event.type === 'journal-document' && JournalDocumentSchema.parse(record.event.data).collection === 'question' && JournalDocumentSchema.parse(record.event.data).key === question.id);
      const path = question.threadId && headers.has(question.threadId) ? threadJournalFile(headers.get(question.threadId)!)
        : source ? `days/${new Intl.DateTimeFormat('en-CA', { timeZone: settings.nightlyWindow.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(source.event.t))}.md` : 'INDEX.md';
      open.push(`- Question ${index + 1}: [${threads.find(thread => thread.id === question.threadId)?.title ?? 'Coordinator'}] ${question.question.replace(/[\r\n]/gu, ' ')} → ${path}${source ? `#e-${journalRecordKey(source)}` : ''}`);
    }
    const tasks = await this.#all(project.id, after => this.o.hub.tasks(project.id, after)); open.push(`- Queue: ${tasks.filter(task => task.state === 'queued').sort(taskOrder).slice(0, 10).map(task => task.title.replace(/[\r\n]/gu, ' ')).join('; ') || '(none)'}`);
    const windows = new Map<string, Record<string, unknown>>();
    for (const record of records) if (record.event.type === 'journal-document') { const data = JournalDocumentSchema.parse(record.event.data); if (data.collection === 'window') windows.set(data.key, data.document); }
    const activeWindow = [...windows.values()].find(window => window.state === 'open');
    open.push(`- Nightly: ${activeWindow ? `window in progress (${String(activeWindow.date)})` : settings?.nightlyWindow.enabled ? `${settings.nightlyWindow.time} ${settings.nightlyWindow.timezone}` : '(disabled)'}`);
    const latest = this.o.ledgers.coordinator(project.id).events().findLast(event => event.type === 'journal-source');
    const updatedAt = latest?.t ?? '1970-01-01T00:00:00.000Z';
    const rendered = renderProjectJournal({ name: project.name, timezone: settings.nightlyWindow.timezone, records, open, updatedAt });
    const state: ProjectJournalState = { schema: 'project-journal-state-v1', lastLedgerEventId: records.at(-1) ? journalRecordKey(records.at(-1)!) : null, files: {}, indexUpdatedAt: new Date(this.o.now()).toISOString() };
    for (const [path, text] of Object.entries(rendered.files)) {
      if (path === 'INDEX.md' && !rebuild && this.o.now() - Date.parse(prior.indexUpdatedAt) < 10000) { if (prior.files[path]) state.files[path] = prior.files[path]; state.indexUpdatedAt = prior.indexUpdatedAt; continue; }
      const hash = digest(text); state.files[path] = hash;
      if (prior.files[path] !== hash || !existsSync(this.#file(project.id, path))) {
        if (!rebuild && path !== 'INDEX.md' && existsSync(this.#file(project.id, path)) && !text.startsWith(readFileSync(this.#file(project.id, path), 'utf8'))) throw refuse('A journal projection cannot replace earlier entries.');
        this.#write(project.id, path, text);
      }
    }
    writeDocument(this.#statePath(project.id), ProjectJournalStateSchema, state);
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
    writeDocument(this.#statePath(projectId), ProjectJournalStateSchema, next);
  }
  async close(): Promise<void> { this.#closed = true; if (this.#timer) clearInterval(this.#timer); await Promise.allSettled(this.#running.values()); }
}
