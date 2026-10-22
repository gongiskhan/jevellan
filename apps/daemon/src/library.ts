import {ProjectAttachmentRequestSchema,projectAttachmentMessage,projectAttachmentPolicy} from '@jevellan/core';
import { LIBRARY_FOLDER_ALIAS, LIBRARY_INVALID_PAGE, LIBRARY_FILE_NOT_FOUND, LIBRARY_RELOAD, LIBRARY_CONTENT_TYPE, LIBRARY_THREAD_REQUIRED, LIBRARY_INVALID_FILE, LIBRARY_SHORT_NAME, LIBRARY_INCOMPLETE, LIBRARY_FILE_UNAVAILABLE, LIBRARY_HASH_FAILED } from '@jevellan/projects';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { IdSchema, LIBRARY_FILE_LIMIT, LIBRARY_QUOTA, LibraryAddInputSchema, LibraryListSchema, ProjectLibraryItemSchema, newId, type ProjectLibrary, type ProjectLibraryItem } from '@jevellan/core';
import { openProjectOutput } from '@jevellan/conversations';
import { LIBRARY_FULL, LIBRARY_TOO_LARGE } from '@jevellan/projects';
import type { Application } from './application.js';
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const mimeOf = (name: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv' })[extname(name).toLowerCase()] ?? 'application/octet-stream';
export class ProjectLibraryService implements ProjectLibrary {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(readonly app: Application) {}
  directory(projectId: string) {
    const path = this.app.homes.at('library', IdSchema.parse(projectId));
    if (path !== join(this.app.homes.root, 'library', projectId)) throw failure(LIBRARY_FOLDER_ALIAS, 403);
    if (!existsSync(path)) { mkdirSync(path, { recursive: true, mode: 0o700 }); if (this.app.member) chmodSync(path, 0o500); }
    return path;
  }
  async #project(projectId: string) { if (!await this.app.state.projects.get(IdSchema.parse(projectId))) throw failure('Project not found.', 404); }
  #rows(projectId: string, includeDeleted = false) { return this.app.hub.listByField('project-library', 'projectId', projectId, ProjectLibraryItemSchema).map(row => row.document).filter(row => includeDeleted || !row.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)); }
  async list(projectId: string): Promise<ProjectLibraryItem[]> {
    await this.#project(projectId);
    if (!this.app.member) return this.#rows(projectId);
    const items: ProjectLibraryItem[] = []; let cursor: string | null = null;
    do {
      const response = await this.app.member.libraryFetch(`${projectId}${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`);
      const page = LibraryListSchema.parse(await response.json());
      if (page.items.some(item => item.projectId !== projectId) || page.next && page.next === cursor) throw failure(LIBRARY_INVALID_PAGE, 502);
      items.push(...page.items); cursor = page.next;
    } while (cursor);
    return items;
  }
  async attachmentPolicy(projectId: string) { await this.#project(projectId); return projectAttachmentPolicy(projectId); }
  async attachmentMessage(projectId: string, raw: unknown) {
    const input = ProjectAttachmentRequestSchema.parse(raw), rows = await this.list(projectId), byId = new Map(rows.map(item => [item.id, item]));
    const items = input.itemIds.map(id => { const item = byId.get(id); if (!item) throw failure(LIBRARY_FILE_NOT_FOUND, 404); return item; });
    return projectAttachmentMessage(projectId, input.text, items);
  }
  async page(projectId: string, after?: string) {
    const rows = await this.list(projectId), start = after ? rows.findIndex(item => item.id === after) + 1 : 0;
    if (after && !start) throw failure(LIBRARY_RELOAD, 409);
    const items = rows.slice(start, start + 100);
    return LibraryListSchema.parse({ schema: 'project-library-list-v1', items, next: start + items.length < rows.length ? items.at(-1)!.id : null, bytes: rows.reduce((sum, item) => sum + item.size, 0) });
  }
  async item(projectId: string, itemId: string) { const item = (await this.list(projectId)).find(item => item.id === IdSchema.parse(itemId)); if (!item) throw failure(LIBRARY_FILE_NOT_FOUND, 404); return item; }
  async remove(projectId: string, itemId: string, ownerSession?: string) {
    if (this.app.member) { await this.app.member.libraryFetch(`${projectId}/${IdSchema.parse(itemId)}`, { method: 'DELETE', ownerSession }); return; }
    await this.#project(projectId); const item = this.app.hub.get('project-library', IdSchema.parse(itemId), ProjectLibraryItemSchema)?.document;
    if (!item || item.projectId !== projectId) throw failure(LIBRARY_FILE_NOT_FOUND, 404);
    if (item.deletedAt) { rmSync(join(this.directory(projectId), item.path), { force: true }); return; }
    this.app.hub.put('project-library', item.id, ProjectLibraryItemSchema, { ...item, revision: item.revision + 1, deletedAt: new Date().toISOString() }, item.revision);
    rmSync(join(this.directory(projectId), item.path), { force: true });
  }
  async upload(projectId: string, input: { name: string; mime: string; size: number; source: 'owner' | 'thread' | 'job'; threadId?: string; jobRunId?: string; artifactId?: string; note?: string; ownerSession?: string }, stream: Readable): Promise<ProjectLibraryItem> {
    await this.#project(projectId);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > LIBRARY_FILE_LIMIT) throw failure(LIBRARY_TOO_LARGE, 413);
    if (!input.mime || input.mime.length > 100 || /[\r\n]/u.test(input.mime)) throw failure(LIBRARY_CONTENT_TYPE);
    if (input.source === 'job' && (!input.jobRunId || !input.artifactId)) throw failure('A job artifact needs its run and artifact identity.');
    if (input.source === 'thread' && !input.threadId) throw failure(LIBRARY_THREAD_REQUIRED);
    if (this.app.member) {
      const part = input.source === 'job' ? `jobs/${IdSchema.parse(input.jobRunId)}/${IdSchema.parse(input.artifactId)}` : input.source === 'thread' ? `outputs/${IdSchema.parse(input.threadId)}` : 'uploads';
      const response = await this.app.member.libraryFetch(`${projectId}/${part}/${encodeURIComponent(input.name)}`, { method: 'PUT', body: stream, mime: input.mime, size: input.size, note: input.note, ownerSession: input.ownerSession });
      const item = ProjectLibraryItemSchema.parse(await response.json());
      if (item.projectId !== projectId || item.source !== input.source || item.threadId !== input.threadId || item.jobRunId !== input.jobRunId || item.artifactId !== input.artifactId || item.size !== input.size) throw failure(LIBRARY_INVALID_FILE, 502);
      return item;
    }
    const previous = this.#pending.get(projectId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const occupied = this.#rows(projectId, true), rows = occupied.filter(item => !item.deletedAt);
      const prior = input.source === 'job' ? occupied.find(item => item.jobRunId === input.jobRunId && item.artifactId === input.artifactId) : undefined;
      if (!prior && rows.reduce((sum, row) => sum + row.size, 0) + input.size > LIBRARY_QUOTA) throw failure(LIBRARY_FULL, 413);
      const folder = input.source === 'job' ? `jobs/${IdSchema.parse(input.jobRunId)}` : input.source === 'thread' ? `outputs/${IdSchema.parse(input.threadId)}` : `uploads/${new Date().toISOString().slice(0, 10)}`;
      const directory = join(this.directory(projectId), folder); mkdirSync(directory, { recursive: true, mode: 0o700 });
      let name = input.name.replace(/[^A-Za-z0-9._ -]/gu, '-').slice(0, 200); if (!name || name === '.' || name === '..') name = 'file';
      if (input.source === 'job') name = `${IdSchema.parse(input.artifactId)}-${name}`.slice(0, 200);
      const original = name, extension = extname(name), stem = name.slice(0, name.length - extension.length); let suffix = 1;
      while (!prior && (occupied.some(item => item.path === `${folder}/${name}`) || existsSync(join(directory, name)))) { const tail = ` (${++suffix})${extension}`; name = `${stem.slice(0, 200 - tail.length)}${tail}`; }
      if (original.length > 200 || name.length > 200) throw failure(LIBRARY_SHORT_NAME);
      const temporary = join(directory, `.${newId('upload')}.tmp`), handle = await open(temporary, 'wx', 0o600), hash = createHash('sha256'); let size = 0, promoted = false;
      try {
        for await (const chunk of stream) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > input.size || size > LIBRARY_FILE_LIMIT) throw failure(LIBRARY_TOO_LARGE, 413); hash.update(bytes); await handle.writeFile(bytes); }
        if (size !== input.size) throw failure(LIBRARY_INCOMPLETE);
        await handle.sync(); await handle.close();
        const contentHash = hash.digest('hex');
        if (prior) { if (prior.deletedAt || prior.sha256 !== contentHash || prior.size !== size) throw failure('This job artifact already has different content.', 409); return prior; }
        const item = ProjectLibraryItemSchema.parse({ schema: 'project-library-item-v1', revision: 1, id: newId('file'), projectId, path: `${folder}/${name}`, name, size, mime: input.mime,
          sha256: contentHash, source: input.source, ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.jobRunId ? { jobRunId: input.jobRunId, artifactId: input.artifactId } : {}), ...(input.note ? { note: input.note } : {}), createdAt: new Date().toISOString() });
        renameSync(temporary, join(directory, name)); promoted = true;
        try { this.app.hub.put('project-library', item.id, ProjectLibraryItemSchema, item, 0); } catch (error) { rmSync(join(directory, name), { force: true }); throw error; }
        return item;
      } finally { await handle.close().catch(() => undefined); if (!promoted) rmSync(temporary, { force: true }); }
    });
    this.#pending.set(projectId, pending); try { return await pending; } finally { if (this.#pending.get(projectId) === pending) this.#pending.delete(projectId); }
  }
  async get(projectId: string, itemId: string) {
    const item = await this.item(projectId, itemId), root = this.directory(projectId), path = join(root, item.path);
    if (!this.app.member) return { localPath: path };
    if (existsSync(path)) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); if (hash.digest('hex') === item.sha256) { chmodSync(path, 0o400); for (const directory of [dirname(path), join(root, item.path.split('/')[0]!), root]) chmodSync(directory, 0o500); return { localPath: path }; } }
    const directories = [root, join(root, item.path.split('/')[0]!), dirname(path)];
    const temporary = join(this.app.homes.ensure('tmp', 'library-mirrors', projectId), `.${newId('mirror')}.tmp`), handle = await open(temporary, 'wx', 0o600);
    try {
      const response = await this.app.member.libraryFetch(`${projectId}/${item.id}/content`); if (!response.body) throw failure(LIBRARY_FILE_UNAVAILABLE, 502);
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > item.size) throw failure(LIBRARY_HASH_FAILED, 502); hash.update(chunk); await handle.writeFile(chunk); }
      if (size !== item.size || hash.digest('hex') !== item.sha256) throw failure(LIBRARY_HASH_FAILED, 502);
      await handle.close();
      // Promotion is synchronous: another download cannot leave these parents read-only midway through it.
      try { for (const dir of directories) { if (existsSync(dir)) chmodSync(dir, 0o700); mkdirSync(dir, { recursive: true, mode: 0o700 }); } renameSync(temporary, path); chmodSync(path, 0o400); }
      finally { for (const dir of [...directories].reverse()) if (existsSync(dir)) chmodSync(dir, 0o500); }
      return { localPath: path };
    } finally { await handle.close().catch(() => undefined); rmSync(temporary, { force: true }); }
  }
  async prepare(projectId: string, prompt: string) { if (!prompt.includes('library/')) return; for (const item of await this.list(projectId)) if (prompt.includes(`library/${item.path}`)) await this.get(projectId, item.id); }
  async addJob(projectId: string, jobRunId: string, artifactId: string, cwd: string, raw: unknown) {
    const run = (await this.app.projectHub.jobRun(IdSchema.parse(jobRunId)))?.document;
    if (!run || run.projectId !== projectId || run.deviceId !== this.app.device.deviceId) throw failure('Only the executing device can upload job artifacts.', 403);
    const input = LibraryAddInputSchema.parse(raw), opened = await openProjectOutput(cwd, input.path, LIBRARY_FILE_LIMIT, LIBRARY_TOO_LARGE);
    try { const name = input.name ?? basename(opened.path); return await this.upload(projectId, { source: 'job', jobRunId, artifactId, name, size: opened.size, mime: mimeOf(name) }, opened.handle.createReadStream({ autoClose: false })); }
    finally { await opened.handle.close(); }
  }
  async add(projectId: string, threadId: string, cwd: string, raw: unknown) {
    const input = LibraryAddInputSchema.parse(raw), opened = await openProjectOutput(cwd, input.path, LIBRARY_FILE_LIMIT, LIBRARY_TOO_LARGE);
    try { const name = input.name ?? basename(opened.path); return await this.upload(projectId, { source: 'thread', threadId, name, size: opened.size, mime: mimeOf(name), ...(input.note ? { note: input.note } : {}) }, opened.handle.createReadStream({ autoClose: false })); }
    finally { await opened.handle.close(); }
  }
}
