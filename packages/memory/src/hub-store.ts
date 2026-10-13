import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { HubUnavailable, HubMemoryScopeSchema, IdSchema, MemoryDreamStateSchema, MemoryFrontmatterSchema, MemoryImportSchema, MemoryNoteSchema, ProjectMemoryRequestSchema, ProjectMemoryResultSchema, ProjectMemoryViewSchema,
  atomicWrite, inside, newId, readDocument, resolvedPath, stableJson, writeDocument,
  type Homes, type HubMemoryScope, type MemoryFrontmatter, type MemoryNote, type MemoryProvenance, type Project, type ProjectMemoryRequest, type ProjectMemoryResult,
} from '@jevellan/core';
import { BasicMemory, type ProjectMemoryPort } from './basic-memory.js';

export const HUB_MEMORY_OFFLINE = 'Project memory is unavailable: the hub is offline.';
const receiptSchema = z.strictObject({ schema: z.literal('memory-write-receipt-v1'), id: IdSchema, digest: z.string(), note: MemoryNoteSchema.optional() });
const importStateSchema = z.strictObject({ schema: z.literal('memory-import-state-v1'), id: IdSchema, projectId: IdSchema, sourcePath: z.string(), at: z.string(),
  baseCommit: z.string(), commit: z.string().nullable(), files: z.record(z.string(), z.string()), completed: z.boolean() });
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
export function splitMemoryText(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return { meta: {}, body: text };
  const parsed = parseDocument(match[1]!); if (parsed.errors.length) throw new Error('This memory note has invalid frontmatter.');
  const value: unknown = parsed.toJS();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A memory note needs object frontmatter.');
  return { meta: value as Record<string, unknown>, body: text.slice(match[0].length) };
}
export const memoryText = (meta: Record<string, unknown>, body: string): string => `---\n${stringify(meta)}---\n${body}`;
const editable = (scope: HubMemoryScope) => ['owner', 'coordinator', 'thread', 'conversation', 'memory'].includes(scope.kind) && !!scope.provenance;
const noOwnership = () => {};
const seenRequest = (meta: Record<string, unknown>, requestId: string) => meta.jevellanRequestId === requestId || Array.isArray(meta.jevellanRequestIds) && meta.jevellanRequestIds.includes(requestId);
const requestMetadata = (meta: Record<string, unknown>, requestId?: string) => requestId ? { jevellanRequestId: requestId,
  jevellanRequestIds: [...new Set([...(Array.isArray(meta.jevellanRequestIds) ? meta.jevellanRequestIds.filter((id): id is string => typeof id === 'string') : []), ...(typeof meta.jevellanRequestId === 'string' ? [meta.jevellanRequestId] : []), requestId])] } : {};
/** Bounded mesh batches preserve old files; symlinks are never followed. */
export function* memoryImportBatches(source: string, redact: (value: string) => string): Generator<Array<{ path: string; content: string }>> {
  function* files(directory: string, prefix = ''): Generator<{ path: string; content: string }> {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = prefix + entry.name, file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Memory import cannot follow links outside the old notes.');
      if (entry.isDirectory()) { yield* files(file, `${path}/`); continue; }
      if (!entry.isFile()) throw new Error('Memory import needs regular files.');
      const bytes = /\.(?:md|markdown)$/iu.test(path) ? Buffer.from(redact(readFileSync(file, 'utf8'))) : readFileSync(file);
      if (bytes.length > 1_000_000) throw new Error('An imported memory file exceeds 1 MB. Its source was preserved.');
      yield { path, content: bytes.toString('base64') };
    }
  }
  let batch: Array<{ path: string; content: string }> = [], size = 0;
  for (const file of files(source)) {
    const length = Buffer.byteLength(JSON.stringify(file));
    if (batch.length && (size + length > 1_400_000 || batch.length >= 5)) { yield batch; batch = []; size = 0; }
    batch.push(file); size += length;
  }
  if (batch.length) yield batch;
}

/** The existing Basic Memory index, with one hub-owned notes repository and local Git history. */
export class HubMemoryStore {
  readonly #queues = new Map<string, Promise<unknown>>();
  constructor(readonly manager: BasicMemory, readonly deviceId: string, readonly now: () => number = Date.now) {}
  root(projectId: string) { return this.manager.homes.ensure('project-memory', IdSchema.parse(projectId)); }
  notes(projectId: string) { return join(this.root(projectId), 'notes'); }
  at() { return new Date(this.now()).toISOString(); }
  git(root: string, ...args: string[]): string {
    return execFileSync('git', ['--no-optional-locks', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'user.name=Jevellan', '-c', 'user.email=jevellan@localhost', ...args], { encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  ensure(projectId: string): string {
    const path = this.notes(projectId); mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!existsSync(join(path, '.git'))) { this.git(path, 'init', '--quiet'); this.git(path, 'commit', '--allow-empty', '--quiet', '-m', 'owner: Project memory'); }
    if (this.git(path, 'remote').trim()) throw new Error('Hub memory history must have no remote.');
    return path;
  }
  exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.#queues.get(projectId) ?? Promise.resolve()).then(work);
    const settled = pending.then(() => undefined, () => undefined); this.#queues.set(projectId, settled);
    void settled.then(() => { if (this.#queues.get(projectId) === settled) this.#queues.delete(projectId); }); return pending;
  }
  path(root: string, reference: string): string {
    const path = resolvedPath(join(root, reference));
    if (!reference || reference.includes('://') || reference.includes('\\') || reference.startsWith('/') || reference.split('/').some(part => ['..', '.git'].includes(part)) || !inside(root, path) || path !== resolve(root, reference)) throw new Error('A memory reference must belong to this project.');
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('A memory note must be a regular file.');
    return path;
  }
  metadata(provenance: MemoryProvenance, title: string, previous?: Record<string, unknown>): MemoryFrontmatter {
    return MemoryFrontmatterSchema.parse({ ...provenance, title, created: typeof previous?.created === 'string' ? previous.created : this.at(), updated: this.at(),
      status: ['active', 'unresolved', 'archived'].includes(String(previous?.status)) ? previous!.status : 'active' });
  }
  assertEditable(meta: Record<string, unknown>, scope: HubMemoryScope): void {
    if (!editable(scope)) throw new Error('This session can only read project memory.');
    if (meta.source === 'owner' && scope.kind !== 'owner') throw new Error('Owner memory notes cannot be edited or archived by sessions.');
  }
  /** The root can be a dream's private staging folder; its tools still use Basic Memory. */
  project(project: Project, scope: HubMemoryScope = { kind: 'viewer' }, staging?: { id: string; path: string }, requestId?: string, directory = ''): ProjectMemoryPort {
    scope = HubMemoryScopeSchema.parse(scope);
    const root = staging?.path ?? this.notes(project.id);
    const base = this.manager.localProject(project, this.deviceId, noOwnership, { path: root, directory, name: staging ? `jv-hub-${project.id}-${staging.id}` : `jv-hub-${project.id}`,
      server: { name: `jv-hub-${project.id}`, path: this.ensure(project.id) },
      metadata: title => scope.provenance ? { ...this.metadata(scope.provenance, title), ...(requestId ? { jevellanRequestId: requestId } : {}) } : {} });
    const read = async (reference: string, signal: AbortSignal): Promise<MemoryNote> => {
      const indexed = await base.read(reference, signal), file = this.path(root, indexed.permalink), value = splitMemoryText(readFileSync(file, 'utf8'));
      return MemoryNoteSchema.parse(this.manager.redactor.document({ ...indexed, content: memoryText(value.meta, value.body), updatedAt: typeof value.meta.updated === 'string' ? value.meta.updated : indexed.updatedAt,
        unresolved: value.meta.status === 'unresolved' }));
    };
    const prepare = async (signal?: AbortSignal) => { if (!staging) this.ensure(project.id); await base.prepare(signal); };
    const write = (input: Parameters<ProjectMemoryPort['write']>[0], signal: AbortSignal) => this.exclusive(project.id, async () => {
      await prepare(signal); this.assertEditable({}, scope);
      if (input.title === 'Project brief' && input.content.length > 2000) throw new Error('Project brief must fit in 2,000 characters.');
      const previous = await base.findTitle(input.title, signal);
      if (previous) {
        if (!requestId || !seenRequest(splitMemoryText(previous.content).meta, requestId)) throw new Error('That memory title already exists; use memory_edit.');
        if (!staging) this.commit(root, `${scope.provenance!.source}: ${input.title}`);
        await base.sync(signal); return read(previous.permalink, signal);
      }
      const note = await base.write(input, signal), file = this.path(root, note.permalink), value = splitMemoryText(readFileSync(file, 'utf8'));
      atomicWrite(file, memoryText({ ...value.meta, ...this.metadata(scope.provenance!, input.title), ...requestMetadata(value.meta, requestId) }, this.manager.redactor.text(value.body)));
      if (!staging) this.commit(root, `${scope.provenance!.source}: ${input.title}`);
      await base.sync(signal); return read(note.permalink, signal);
    });
    const edit = (input: Parameters<ProjectMemoryPort['edit']>[0], signal: AbortSignal) => this.exclusive(project.id, async () => {
      await prepare(signal); const current = await read(input.permalink, signal), file = this.path(root, current.permalink), before = splitMemoryText(readFileSync(file, 'utf8'));
      this.assertEditable(before.meta, scope);
      if (requestId && seenRequest(before.meta, requestId)) { if (!staging) this.commit(root, `${scope.provenance!.source}: ${current.title}`); await base.sync(signal); return read(current.permalink, signal); }
      const body = input.operation === 'append' ? `${before.body}\n${input.content}` : input.operation === 'prepend' ? `${input.content}\n${before.body}` : (() => {
        if (!input.find || !before.body.includes(input.find) || before.body.indexOf(input.find) !== before.body.lastIndexOf(input.find)) throw new Error('A memory replacement must match exactly once in the note body.');
        return before.body.replace(input.find, () => input.content);
      })();
      if (current.title === 'Project brief' && body.length > 2000) throw new Error('Project brief must fit in 2,000 characters.');
      // The content and receipt marker land atomically; Basic Memory synchronises the same file.
      atomicWrite(file, memoryText({ ...before.meta, ...this.metadata(scope.provenance!, current.title, before.meta), ...requestMetadata(before.meta, requestId) }, this.manager.redactor.text(body)));
      if (!staging) this.commit(root, `${scope.provenance!.source}: ${current.title}`);
      await base.sync(signal); return read(current.permalink, signal);
    });
    return { path: root, assertOwnership: () => this.assertEditable({}, scope), prepare, read, write, edit,
      list: async signal => { signal.throwIfAborted(); return this.list(project.id, staging?.path); },
      search: async (query, signal) => { signal.throwIfAborted();
        // A new shared store has a notes directory, but nothing for the index to search yet.
        if (!this.list(project.id, staging?.path).length) return { schema: 'memory-search-v1', notes: [] };
        await prepare(signal); const result = await base.search(query, signal);
        const notes = await Promise.all(result.notes.map(note => read(note.permalink, signal)));
        return { schema: 'memory-search-v1', notes: notes.filter(note => splitMemoryText(note.content).meta.status !== 'archived') }; },
      findTitle: async (title, signal) => { signal.throwIfAborted();
        if (!this.list(project.id, staging?.path).length) return null;
        await prepare(signal); await base.sync(signal); const found = await base.findTitle(title, signal); return found ? read(found.permalink, signal) : null; },
      sync: async signal => { await prepare(signal); await base.sync(signal); } };
  }
  commit(root: string, message: string): string {
    this.git(root, 'add', '--all');
    if (this.git(root, 'diff', '--cached', '--name-only').trim()) this.git(root, 'commit', '--quiet', '-m', this.manager.redactor.text(message).slice(0, 500));
    return this.git(root, 'rev-parse', 'HEAD').trim();
  }
  list(projectId: string, stagingPath?: string): MemoryNote[] {
    const root = stagingPath ?? this.ensure(projectId), notes: MemoryNote[] = [];
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const ref = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error('Project memory cannot contain links to other files.');
        if (entry.isDirectory()) { visit(join(directory, entry.name), `${ref}/`); continue; }
        const file = this.path(root, ref);
        if (!/\.(?:md|markdown)$/iu.test(entry.name)) continue;
        const value = splitMemoryText(readFileSync(file, 'utf8')); if (value.meta.status === 'archived') continue;
        notes.push(MemoryNoteSchema.parse(this.manager.redactor.document({ schema: 'memory-note-v1', title: String(value.meta.title ?? basename(ref, '.md')),
          permalink: ref, content: memoryText(value.meta, value.body), updatedAt: typeof value.meta.updated === 'string' ? value.meta.updated : lstatSync(file).mtime.toISOString(), unresolved: value.meta.status === 'unresolved' })));
      }
    };
    visit(root); return notes.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.permalink.localeCompare(b.permalink));
  }
  async archive(project: Project, scope: HubMemoryScope, input: { note: string; reason: string }, signal: AbortSignal, staging?: { id: string; path: string }, requestId?: string): Promise<MemoryNote> {
    return this.exclusive(project.id, async () => {
      const port = this.project(project, scope, staging); await port.prepare(signal);
      const root = port.path, file = this.path(root, input.note), value = splitMemoryText(readFileSync(file, 'utf8')); this.assertEditable(value.meta, scope);
      if (requestId && seenRequest(value.meta, requestId)) { this.commit(root, `${scope.provenance!.source}: ${String(value.meta.title)}`); await port.sync(signal); return port.read(input.note, signal); }
      const meta = { ...value.meta, ...this.metadata(scope.provenance!, String(value.meta.title), value.meta), status: 'archived', archiveReason: this.manager.redactor.text(input.reason), ...requestMetadata(value.meta, requestId) };
      atomicWrite(file, memoryText(meta, value.body)); if (!staging) this.commit(root, `${scope.provenance!.source}: ${String(value.meta.title)}`);
      await port.sync(signal); return port.read(input.note, signal);
    });
  }
  async import(project: Project, old: Project): Promise<void> {
    if (old.memory.mode === 'hub') return;
    const source = this.manager.project(old, this.deviceId, noOwnership).path;
    for (const files of memoryImportBatches(source, this.manager.redactor.text.bind(this.manager.redactor))) await this.importBatch(project, { requestId: 'initial_memory_import', sourcePath: source, files, final: false });
    await this.importBatch(project, { requestId: 'initial_memory_import', sourcePath: source, files: [], final: true });
  }
  importBatch(project: Project, input: { requestId: string; sourcePath: string; files: Array<{ path: string; content: string }>; final: boolean }): Promise<void> {
    return this.exclusive(project.id, async () => {
      const receipt = join(this.root(project.id), 'import.json'); if (existsSync(receipt)) return;
      const directory = this.manager.homes.ensure('project-memory', project.id, 'imports', IdSchema.parse(input.requestId)), file = join(directory, 'state.json'), stage = join(directory, 'notes'), root = this.ensure(project.id);
      let state = existsSync(file) ? readDocument(file, importStateSchema) : undefined;
      if (!state) {
        if (this.git(root, 'status', '--porcelain').trim()) throw new Error('Hub memory has an unfinished write; its files were preserved.');
        cpSync(root, stage, { recursive: true }); state = { schema: 'memory-import-state-v1', id: input.requestId, projectId: project.id, sourcePath: input.sourcePath,
          at: this.at(), baseCommit: this.git(root, 'rev-parse', 'HEAD').trim(), commit: null, files: {}, completed: false }; writeDocument(file, importStateSchema, state);
      }
      if (state.sourcePath !== input.sourcePath) throw new Error('This memory import belongs to a different source folder.');
      for (const entry of input.files) {
        const target = this.path(stage, entry.path), bytes = Buffer.from(entry.content, 'base64'), hash = digest(entry.content), prior = state.files[entry.path];
        if (prior) { if (prior !== hash) throw new Error('The old notes changed during import; both copies were preserved.'); continue; }
        let content: string | Buffer = bytes;
        if (/\.(?:md|markdown)$/iu.test(entry.path)) {
          const value = splitMemoryText(this.manager.redactor.text(bytes.toString('utf8'))), source = MemoryFrontmatterSchema.shape.source.safeParse(value.meta.source);
          const created = MemoryFrontmatterSchema.shape.created.safeParse(value.meta.created);
          content = memoryText({ ...value.meta, ...this.metadata({ source: source.success ? source.data : 'owner', runtime: String(value.meta.runtime ?? 'unknown'), model: String(value.meta.model ?? 'unknown') }, String(value.meta.title ?? basename(entry.path, '.md')), { ...value.meta, created: created.success ? created.data : state.at }),
            ...(value.meta.created && !created.success ? { legacyCreated: value.meta.created } : {}), created: created.success ? created.data : state.at, updated: state.at }, value.body);
        }
        if (existsSync(target) && !readFileSync(target).equals(Buffer.from(content))) throw new Error('A hub note conflicts with the imported folder. Both copies were preserved.');
        mkdirSync(resolve(target, '..'), { recursive: true }); atomicWrite(target, content); state.files[entry.path] = hash; writeDocument(file, importStateSchema, state);
      }
      if (!input.final) return;
      state.commit ??= this.commit(stage, 'owner: Import existing project memory'); writeDocument(file, importStateSchema, state);
      const current = this.git(root, 'rev-parse', 'HEAD').trim();
      if (current !== state.commit) {
        if (current !== state.baseCommit || this.git(root, 'status', '--porcelain').trim()) throw new Error('Hub notes changed while memory was imported. Both copies were preserved.');
        this.git(root, 'fetch', '--quiet', '--no-tags', stage, state.commit); this.git(root, 'merge', '--ff-only', '--quiet', state.commit);
      }
      writeDocument(receipt, MemoryImportSchema, { schema: 'memory-import-v1', projectId: project.id, sourcePath: input.sourcePath, at: state.at, files: Object.keys(state.files).length });
      writeDocument(file, importStateSchema, { ...state, completed: true });
    });
  }
  async request(project: Project, raw: ProjectMemoryRequest, signal: AbortSignal, staging?: { id: string; path: string }): Promise<ProjectMemoryResult> {
    const request = ProjectMemoryRequestSchema.parse(raw);
    if (request.projectId !== project.id || project.memory.mode !== 'hub') throw new Error('This request needs the project’s hub memory.');
    const port = this.project(project, request.scope, staging, 'requestId' in request ? request.requestId : undefined);
    switch (request.operation) {
      case 'search': return port.search(request.query, signal);
      case 'read': return port.read(request.permalink, signal);
      case 'find-title': return { schema: 'memory-found-v1', note: await port.findTitle(request.title, signal) };
      case 'sync': await port.sync(signal); return { schema: 'memory-operation-v1', accepted: true };
      case 'view': {
        const all = this.list(project.id, staging?.path), selected: MemoryNote[] = []; let remaining = 800_000;
        for (const note of all) {
          const preview = { ...note, content: note.content.slice(0, 600) }, bytes = Buffer.byteLength(JSON.stringify(preview));
          if (bytes > remaining || selected.length >= 1000) break; selected.push(preview); remaining -= bytes;
        }
        const dream = existsSync(join(this.root(project.id), 'dream.json')) ? readDocument(join(this.root(project.id), 'dream.json'), MemoryDreamStateSchema) : null;
        if (dream && Buffer.byteLength(dream.diff) > 800_000) dream.diff = Buffer.from(dream.diff).subarray(0, 799_900).toString('utf8') + '\n[Diff preview trimmed; the full commit remains in memory history.]';
        return ProjectMemoryViewSchema.parse({ schema: 'project-memory-view-v1', projectId: project.id, truncated: selected.length !== all.length,
          notes: selected.filter(note => !note.permalink.startsWith('inbox/')), inbox: selected.filter(note => note.permalink.startsWith('inbox/')), dream });
      }
      case 'write': case 'edit': case 'archive': {
        return this.exclusive(`request:${project.id}`, async () => {
          const { ownerSession: _ownerSession, ...stableRequest } = request; void _ownerSession;
          const receiptPath = join(this.manager.homes.ensure('project-memory', project.id, 'receipts'), `${request.requestId}.json`), hash = digest(stableRequest);
          if (existsSync(receiptPath)) { const previous = readDocument(receiptPath, receiptSchema); if (previous.digest !== hash) throw new Error('This memory request id was reused with different text.'); if (previous.note) return previous.note; }
          else writeDocument(receiptPath, receiptSchema, { schema: 'memory-write-receipt-v1', id: request.requestId, digest: hash });
          const note = request.operation === 'write' ? await port.write(request.input, signal) : request.operation === 'edit' ? await port.edit(request.input, signal) : await this.archive(project, request.scope, request.input, signal, staging, request.requestId);
          writeDocument(receiptPath, receiptSchema, { schema: 'memory-write-receipt-v1', id: request.requestId, digest: hash, note }); return note;
        });
      }
      case 'capture': throw new Error('Capture is handled by the project transcript queue.');
      case 'import': case 'dream-run': case 'dream-apply': case 'dream-undo': case 'dream-discard': throw new Error('This memory operation is handled by the hub.');
    }
  }
}

/** Member sessions reuse the mesh transport; no local index or mirror of hub notes is opened. */
export function remoteHubMemory(homes: Homes, project: Project, scope: HubMemoryScope, relay: (request: ProjectMemoryRequest) => Promise<ProjectMemoryResult>): ProjectMemoryPort {
  const invoke = async (fields: Omit<ProjectMemoryRequest, 'schema' | 'projectId' | 'scope'>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    try { const value = ProjectMemoryResultSchema.parse(await relay(ProjectMemoryRequestSchema.parse({ schema: 'project-memory-request-v1', projectId: project.id, scope, ...fields }))); signal?.throwIfAborted(); return value; }
    catch (error) { if (signal?.aborted) throw error; if (error instanceof HubUnavailable) throw new Error(HUB_MEMORY_OFFLINE); if (error && typeof error === 'object' && 'status' in error) throw error; throw new Error(HUB_MEMORY_OFFLINE); }
  };
  const call = (fields: Record<string, unknown>, signal?: AbortSignal) => invoke(fields as Omit<ProjectMemoryRequest, 'schema' | 'projectId' | 'scope'>, signal);
  const note = async (fields: Record<string, unknown>, signal: AbortSignal) => MemoryNoteSchema.parse(await call(fields, signal));
  return { path: homes.at('project-memory', project.id, 'notes'), assertOwnership: () => { if (!editable(scope)) throw new Error('This session can only read project memory.'); },
    prepare: async signal => { await call({ operation: 'sync' }, signal); }, sync: async signal => { await call({ operation: 'sync' }, signal); },
    search: async (query, signal) => { const result = await call({ operation: 'search', query }, signal); if (result.schema !== 'memory-search-v1') throw new Error('Invalid memory search result.'); return result; },
    read: (permalink, signal) => note({ operation: 'read', permalink }, signal),
    findTitle: async (title, signal) => { const result = await call({ operation: 'find-title', title }, signal); if (result.schema !== 'memory-found-v1') throw new Error('Invalid title result.'); return result.note; },
    list: async signal => { const result = await call({ operation: 'view' }, signal); if (result.schema !== 'project-memory-view-v1') throw new Error('Invalid memory view.'); return [...result.notes, ...result.inbox].sort((a,b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')); },
    write: (input, signal) => note({ operation: 'write', input, requestId: newId('mwrite') }, signal),
    edit: (input, signal) => note({ operation: 'edit', input, requestId: newId('mwrite') }, signal) };
}
