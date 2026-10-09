import { mkdirSync, existsSync, appendFileSync, readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { Homes, MemoryEditSchema, MemoryNoteSchema, MemorySearchSchema, MemoryWriteSchema, ProjectSchema, SecretRedactor, inside, resolveProjectPath, resolvedPath, runOwnedCommand, type MemoryNote, type Project } from '@jevellan/core';
import { OwnedMemoryTransport } from './transport.js';

export const BASIC_MEMORY_VERSION = '0.22.1';
const NativeResult = z.object({ result: z.unknown() });
const NativeFailure = z.object({ error: z.string().nullish() });
const NativeReference = z.object({ title: z.string(), permalink: z.string().nullish(), file_path: z.string() });
const NativeNote = NativeReference.extend({ content: z.string(), frontmatter: z.record(z.string(), z.unknown()).nullish() });
type Connection = { client: Client; transport: OwnedMemoryTransport };

/** Stop this caller's wait without cancelling setup or indexing shared by other readers. */
function waitForMemory<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    void pending.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

export function memoryEnvironment(homes: Homes): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homes.ensure('basic-memory', 'home'), LANG: 'en_US.UTF-8',
    BASIC_MEMORY_CONFIG_DIR: homes.ensure('basic-memory'), BASIC_MEMORY_AUTO_UPDATE: 'false', BASIC_MEMORY_FORCE_LOCAL: 'true', BASIC_MEMORY_EXPLICIT_ROUTING: 'true',
    BASIC_MEMORY_SYNC_CHANGES: 'false', BASIC_MEMORY_LOGFIRE_ENABLED: 'false', BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: 'false',
    BASIC_MEMORY_DISABLE_PERMALINKS: 'true', BASIC_MEMORY_ENSURE_FRONTMATTER_ON_SYNC: 'false', PYTHONDONTWRITEBYTECODE: '1' };
}

/** Names, sizes and contents of every file under the memory folder, as last indexed. */
function folderDigest(root: string): string {
  const digest = createHash('sha256');
  const visit = (directory: string, prefix: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name); const name = prefix + entry.name;
      if (entry.isDirectory()) { digest.update(`d\0${name}\0`); visit(file, `${name}/`); }
      else if (entry.isFile()) digest.update(`f\0${name}\0`).update(createHash('sha256').update(readFileSync(file)).digest('hex')).update('\0');
      else digest.update(`o\0${name}\0`);
    }
  };
  visit(root, ''); return digest.digest('hex');
}

export class BasicMemory {
  readonly env: Record<string, string>;
  readonly #connections = new Set<Connection>();
  readonly #projects = new Map<string, Promise<Connection>>();
  #registration: Promise<unknown> = Promise.resolve();
  readonly #synced = new Map<string, string>();
  readonly #writes = new Map<string, number>();
  #version: Promise<void> | undefined;
  #closed = false;
  constructor(readonly homes: Homes, readonly executable = 'basic-memory', readonly redactor = new SecretRedactor()) { this.env = memoryEnvironment(homes); }
  project(project: Project, deviceId: string, assertOwnership: () => void | Promise<void>): BasicMemoryProject {
    return new BasicMemoryProject(this, ProjectSchema.parse(project), deviceId, assertOwnership);
  }
  async #open(project?: string): Promise<Connection> {
    if (this.#closed) throw new Error('Project memory is closed.');
    this.#version ??= (async () => {
      const result = await runOwnedCommand(this.executable, ['--version'], { cwd: this.homes.root, env: this.env, timeoutMs: 30_000, redactor: this.redactor });
      if (result.code !== 0 || !/\b0\.22\.1\b/.test(result.stdout)) throw new Error(`Jevellan requires Basic Memory ${BASIC_MEMORY_VERSION}.`);
    })();
    await this.#version;
    if (this.#closed) throw new Error('Project memory is closed.');
    const transport = new OwnedMemoryTransport(this.executable, ['mcp', ...(project ? ['--project', project] : [])], { cwd: this.homes.root, env: { ...this.env, ...(project ? { BASIC_MEMORY_MCP_PROJECT: project } : {}) } });
    const client = new Client({ name: 'jevellan-memory', version: '1.0.0' }); const connection = { client, transport };
    this.#connections.add(connection);
    try { await client.connect(transport, { timeout: 30_000 }); return connection; }
    catch (error) { await this.#close(connection); throw error; }
  }
  async #close(connection: Connection): Promise<void> {
    await connection.client.close(); await connection.transport.close(); this.#connections.delete(connection);
  }
  async #call(connection: Connection, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await connection.client.callTool({ name, arguments: { ...this.redactor.document(args), output_format: 'json' } }, undefined, { timeout: 30_000, ...(signal ? { signal } : {}) });
    if (response.isError) throw new Error(`Basic Memory could not complete ${name}.`);
    const value = NativeResult.parse(response.structuredContent).result;
    const failure = NativeFailure.safeParse(value);
    if (failure.success && failure.data.error) throw new Error(this.redactor.text(`Basic Memory: ${failure.data.error}`).slice(0, 1000));
    return value;
  }
  async connection(name: string, path: string): Promise<Connection> {
    if (this.#closed) throw new Error('Project memory is closed.');
    const key = `${name}\0${path}`;
    let pending = this.#projects.get(key);
    if (!pending) {
      pending = this.#registration.then(async () => {
        const manager = await this.#open();
        try {
          const created = z.object({ name: z.string(), path: z.string() }).parse(await this.#call(manager, 'create_memory_project', { project_name: name, project_path: path }));
          if (created.name !== name || resolvedPath(created.path) !== path) throw new Error('This memory project is registered at another path.');
        } finally { await this.#close(manager); }
        await this.#syncFiles(name, path);
        return this.#open(name);
      });
      this.#projects.set(key, pending); this.#registration = pending.then(() => undefined, () => undefined);
      void pending.catch(() => { if (this.#projects.get(key) === pending) this.#projects.delete(key); });
    }
    return pending;
  }
  async call(name: string, path: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); const connection = await waitForMemory(this.connection(name, path), signal); signal.throwIfAborted();
    // A provider write changes the index outside sync; the next sync must run even if files later return to the synced state.
    if (!['search_notes', 'read_note'].includes(tool)) { const key = `${name}\0${path}`; this.#synced.delete(key); this.#writes.set(key, (this.#writes.get(key) ?? 0) + 1); }
    return this.#call(connection, tool, { ...args, project: name }, signal);
  }
  async sync(name: string, path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); await waitForMemory(this.connection(name, path), signal); signal?.throwIfAborted();
    // Each provider sync is a full foreground Python run; skip it when no note changed since the last one.
    if (this.#synced.get(`${name}\0${path}`) === folderDigest(path)) return;
    await waitForMemory(this.#syncFiles(name, path), signal); signal?.throwIfAborted();
  }
  async #syncFiles(name: string, path: string): Promise<void> {
    const digest = folderDigest(path); const writes = this.#writes.get(`${name}\0${path}`) ?? 0;
    const candidate = isAbsolute(this.executable) ? this.executable : this.env.PATH!.split(':').map((directory) => join(directory, this.executable)).find((file) => existsSync(file));
    if (!candidate) throw new Error('Basic Memory is not installed.');
    const python = join(dirname(realpathSync(candidate)), 'python');
    if (!existsSync(python)) throw new Error('Basic Memory needs its isolated Python environment for project sync.');
    const result = await runOwnedCommand(python, [fileURLToPath(new URL('../scripts/sync.py', import.meta.url))], {
      cwd: this.homes.root, env: { ...this.env, BASIC_MEMORY_MCP_PROJECT: name }, timeoutMs: 60_000, redactor: this.redactor,
      input: JSON.stringify({ schema: 'memory-sync-request-v1', project: name, path }),
    });
    if (result.code !== 0) throw new Error(`Basic Memory could not synchronize this project: ${this.redactor.text(result.stderr).trim().slice(-2500) || `exit ${result.code}`}`);
    const receipt = z.strictObject({ schema: z.literal('memory-sync-v1'), project: z.string(), total: z.number().int().nonnegative() }).parse(JSON.parse(result.stdout));
    if (receipt.project !== name) throw new Error('Memory sync returned another project.');
    if ((this.#writes.get(`${name}\0${path}`) ?? 0) === writes) this.#synced.set(`${name}\0${path}`, digest);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#registration;
    await Promise.all([...this.#connections].map((connection) => this.#close(connection)));
    this.#projects.clear();
  }
}

export class BasicMemoryProject {
  readonly name: string;
  constructor(readonly manager: BasicMemory, readonly project: Project, readonly deviceId: string, readonly assertOwnership: () => void | Promise<void>) { this.name = `jv-${project.id}`; }
  get path(): string {
    const root = resolveProjectPath(this.project, this.deviceId); const folder = this.project.memory.dir;
    const path = resolvedPath(resolve(root, folder));
    if (!folder || /[\r\n\\]/.test(folder) || isAbsolute(folder) || path === root || !inside(root, path) || path !== resolve(root, folder) || relative(root, path).split('/').some((part) => ['.git', '.claude', '.codex'].includes(part))) throw new Error('Project memory must be a separate local folder inside the checkout.');
    return path;
  }
  #filesAreLocal(path = this.path): void {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (lstatSync(file).isSymbolicLink()) throw new Error('Project memory cannot contain links to other files.');
      if (entry.isDirectory()) this.#filesAreLocal(file);
    }
  }
  #reference(value: string): string {
    if (!value || value.includes('://') || value.includes('\\') || value.split('/').some((part) => part === '..') || isAbsolute(value) || !inside(this.path, resolvedPath(join(this.path, value)))) throw new Error('A memory reference must belong to this project.');
    return value;
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); await this.assertOwnership(); signal?.throwIfAborted(); const path = this.path; this.#filesAreLocal(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (this.project.memory.mode === 'device') {
      const root = resolveProjectPath(this.project, this.deviceId); const folder = relative(root, path);
      const options = { encoding: 'utf8' as const, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
      if (execFileSync('git', ['-C', root, 'ls-files', '--', folder], options).trim()) throw new Error('Device-only memory needs an untracked folder.');
      const gitDir = execFileSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], options).trim();
      const file = join(gitDir, 'info', 'exclude'); const pattern = `/${folder.replace(/[[\]*?!# ]/g, '\\$&')}/`;
      const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!previous.split('\n').includes(pattern)) { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${previous && !previous.endsWith('\n') ? '\n' : ''}${pattern}\n`, { mode: 0o600 }); }
    }
    signal?.throwIfAborted(); await waitForMemory(this.manager.connection(this.name, path), signal); signal?.throwIfAborted();
  }
  async search(query: string, signal: AbortSignal) {
    const path = this.path; this.#filesAreLocal(path);
    if (!existsSync(path)) return MemorySearchSchema.parse({ schema: 'memory-search-v1', notes: [] });
    signal.throwIfAborted(); await this.sync(signal); signal.throwIfAborted();
    const response = z.object({ results: z.array(NativeReference) }).parse(await this.manager.call(this.name, path, 'search_notes', { query, search_type: 'text', page_size: 12, search_all_projects: false }, signal));
    const notes: MemoryNote[] = [];
    for (const result of response.results.slice(0, 12)) notes.push(await this.read(result.permalink ?? result.file_path, signal));
    return MemorySearchSchema.parse({ schema: 'memory-search-v1', notes });
  }
  async read(permalink: string, signal: AbortSignal): Promise<MemoryNote> {
    const path = this.path; this.#filesAreLocal(path); const identifier = this.#reference(permalink);
    if (!existsSync(path)) throw new Error('This project has no memory notes yet.');
    const note = NativeNote.parse(await this.manager.call(this.name, path, 'read_note', { identifier }, signal));
    this.#reference(note.file_path);
    if (note.permalink !== identifier && note.file_path !== identifier) throw new Error('Basic Memory did not resolve that exact note reference.');
    const file = lstatSync(join(path, note.file_path)); if (!file.isFile()) throw new Error('A memory note must be a regular project file.');
    return MemoryNoteSchema.parse(this.manager.redactor.document({ schema: 'memory-note-v1', title: note.title, permalink: note.permalink ?? note.file_path, content: note.content, updatedAt: file.mtime.toISOString(), unresolved: note.frontmatter?.status === 'unresolved' }));
  }
  async findTitle(title: string, signal: AbortSignal): Promise<MemoryNote | null> {
    const path = this.path; this.#filesAreLocal(path);
    if (!existsSync(path)) return null;
    // Title search is paged: a matching title must not be missed behind other hits.
    for (let page = 1; ; page++) {
      const response = z.object({ results: z.array(NativeReference) }).parse(await this.manager.call(this.name, path, 'search_notes', { query: title, search_type: 'title', page, page_size: 100, search_all_projects: false }, signal));
      const match = response.results.find((note) => note.title.normalize('NFC').toLowerCase() === title.normalize('NFC').toLowerCase());
      if (match) return this.read(match.permalink ?? match.file_path, signal);
      if (response.results.length < 100) return null;
    }
  }
  async write(raw: z.infer<typeof MemoryWriteSchema>, signal: AbortSignal): Promise<MemoryNote> {
    const input = MemoryWriteSchema.parse(raw); await this.prepare(signal); signal.throwIfAborted(); await this.assertOwnership();
    const note = NativeReference.parse(await this.manager.call(this.name, this.path, 'write_note', { ...input, directory: '', overwrite: false }, signal));
    return this.read(note.permalink ?? note.file_path, signal);
  }
  async edit(raw: z.infer<typeof MemoryEditSchema>, signal: AbortSignal): Promise<MemoryNote> {
    const input = MemoryEditSchema.parse(raw); await this.prepare(signal); signal.throwIfAborted(); await this.assertOwnership();
    const current = await this.read(input.permalink, signal);
    const note = NativeReference.parse(await this.manager.call(this.name, this.path, 'edit_note', { identifier: this.#reference(current.permalink), operation: input.operation === 'replace' ? 'find_replace' : input.operation, content: input.content, ...(input.find ? { find_text: input.find, expected_replacements: 1 } : {}) }, signal));
    return this.read(note.permalink ?? note.file_path, signal);
  }
  async sync(signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); this.#filesAreLocal(); if (existsSync(this.path)) await this.manager.sync(this.name, this.path, signal); }
}
