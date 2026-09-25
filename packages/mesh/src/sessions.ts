import { opendir, open, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { uptime } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { ExternalSessionsSchema, inside, resolvedPath, type ExternalSession, type ExternalSessions, type Homes, type Project } from '@jevellan/core';

type Runtime = ExternalSession['runtime'];
type Observed = Omit<ExternalSession, 'projectId'> & { key: string };
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const epoch = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const DAY = 86_400_000;
const CursorMetadataSchema = z.strictObject({ schema: z.literal('cursor-metadata-v1'), rows: z.array(z.object({ id: z.string(), cwd: z.unknown(), activity: z.string() })).max(20000) });
export type SessionSensorOptions = {
  homes: Homes; roots?: Partial<Record<Runtime, readonly string[]>>; cursorDatabase?: string | null; now?: () => number;
  scanLimit?: number; readCursor?: (path: string) => Promise<unknown>;
  processStarts?: (pids: number[]) => Promise<ReadonlyMap<number, number>>;
};

export function readCursorMetadata(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cursor-metadata-worker.js', import.meta.url), { workerData: path });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Session metadata read timed out.')); }, 3000);
    worker.once('message', (message: unknown) => { clearTimeout(timer); resolve(message); });
    worker.once('error', () => { clearTimeout(timer); reject(new Error('Session metadata is unavailable.')); });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('Session metadata reader stopped.')); });
  });
}

async function processStarts(pids: number[]): Promise<ReadonlyMap<number, number>> {
  if (!pids.length) return new Map();
  return new Promise(resolve => {
    execFile('/bin/ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, env: { LC_ALL: 'C', TZ: 'UTC' } }, (error, stdout) => {
      const result = new Map<number, number>();
      if (!error) for (const line of stdout.split('\n')) {
        const found = /^(\d+)\s+(.*)$/.exec(line.trim()); const time = found ? Date.parse(found[2]! + ' UTC') : NaN;
        if (found && Number.isFinite(time)) result.set(Number(found[1]), time);
      }
      resolve(result);
    });
  });
}

/** Read-only native metadata. Native identifiers exist only in this scanner's
 * transient deduplication keys; exported documents contain no identifiers,
 * transcript paths, titles, prompts or message bodies. */
export class ExternalSessionSensor {
  readonly #cache = new Map<string, Observed[]>();
  readonly #metadata = new Map<string, { stamp: string; records: JsonRecord[] }>();
  readonly #now: () => number;
  #pending: Promise<ExternalSessions> | undefined;
  constructor(readonly options: SessionSensorOptions) { this.#now = options.now ?? Date.now; }
  read(projects: readonly Project[], deviceId: string): Promise<ExternalSessions> {
    // Only discovery is coalesced. Mapping always uses the caller's current
    // project list, including settings changed while a scan was in flight.
    const pending = this.#pending ??= this.#scan().finally(() => { this.#pending = undefined; });
    return pending.then(snapshot => {
      const paths = projects.flatMap(project => {
        const path = project.paths[deviceId]; if (!path || !isAbsolute(path)) return [];
        try { return [{ id: project.id, path: resolvedPath(path) }]; } catch { return []; }
      }).sort((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id));
      return ExternalSessionsSchema.parse({ ...snapshot, sessions: snapshot.sessions.map(session => {
        const project = paths.find(item => inside(item.path, session.cwd));
        return { ...session, ...(project ? { projectId: project.id } : {}) };
      }) });
    });
  }
  #owned(path: string): boolean { return inside(this.options.homes.at('homes'), resolvedPath(path)); }
  async #scan(): Promise<ExternalSessions> {
    const collected: Observed[] = []; const unavailable = new Set<Runtime>(); const active = new Set<string>();
    const cutoff = this.#now() - 5 * DAY;
    const scan = async (runtime: Runtime, key: string, read: () => Promise<Observed[]>) => {
      active.add(key);
      try { const rows = await read(); this.#cache.set(key, rows); }
      catch { unavailable.add(runtime); }
      collected.push(...(this.#cache.get(key) ?? []).filter(row => Date.parse(row.lastActivityAt) >= cutoff));
    };
    for (const runtime of ['claude', 'codex', 'cursor', 'gemini'] as const) {
      const roots = this.options.roots?.[runtime] ?? [join(this.options.homes.userHome, `.${runtime}`)];
      for (const root of new Set(roots.map(path => resolvedPath(path)))) {
        if (this.#owned(root)) continue;
        await scan(runtime, `${runtime}:${root}`, () => this.#fromHome(runtime, root, cutoff));
      }
    }
    const database = this.options.cursorDatabase === undefined
      ? join(this.options.homes.userHome, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : ['.config']), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      : this.options.cursorDatabase;
    if (database && !this.#owned(database)) await scan('cursor', `cursor-db:${database}`, async () => {
      try { await stat(database); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const document = CursorMetadataSchema.parse(await (this.options.readCursor ?? readCursorMetadata)(database));
      return document.rows.flatMap(row => {
        let values: unknown; try { values = JSON.parse(row.activity); } catch { return []; }
        const times = Array.isArray(values) ? values : [];
        return this.#row('cursor', row.id, row.cwd, epoch(times.find(value => Number.isFinite(epoch(value)))), 'cursor-desktop');
      });
    });
    for (const key of this.#cache.keys()) if (!active.has(key)) this.#cache.delete(key);
    const byIdentity = new Map<string, Observed>(); const now = this.#now();
    for (const row of collected) {
      const time = Date.parse(row.lastActivityAt); if (time < cutoff || time > now) continue;
      const key = `${row.runtime}:${row.key}`; const previous = byIdentity.get(key);
      if (!previous || time > Date.parse(previous.lastActivityAt)) byIdentity.set(key, row);
    }
    return ExternalSessionsSchema.parse({ schema: 'external-sessions-v1', at: new Date(now).toISOString(), unavailable: [...unavailable], sessions: [...byIdentity.values()]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).map(row => ({ runtime: row.runtime, cwd: row.cwd, lastActivityAt: row.lastActivityAt, source: row.source })) });
  }
  #row(runtime: Runtime, key: unknown, cwd: unknown, time: number, source: string): Observed[] {
    if (typeof key !== 'string' || !key || typeof cwd !== 'string' || !isAbsolute(cwd) || !Number.isFinite(time)) return [];
    try { return [{ runtime, key, cwd: resolvedPath(cwd), lastActivityAt: new Date(time).toISOString(), source }]; } catch { return []; }
  }
  async #entries(path: string, budget: { remaining: number }): Promise<{ name: string; directory: boolean }[]> {
    if (this.#owned(path)) return [];
    let directory;
    try { directory = await opendir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const rows = [];
    for await (const entry of directory) {
      if (--budget.remaining < 0) throw new Error('Session scan limit reached.');
      if (entry.isFile() || entry.isDirectory()) rows.push({ name: entry.name, directory: entry.isDirectory() });
    }
    return rows;
  }
  async #head(path: string, json = false): Promise<JsonRecord[]> {
    if (this.#owned(path)) return [];
    const file = await open(path, 'r');
    try {
      const info = await file.stat(); if (!info.isFile()) return [];
      const stamp = `${info.mtimeMs}:${info.size}`; const cached = this.#metadata.get(path); if (cached?.stamp === stamp) return cached.records;
      const buffer = Buffer.alloc(Math.min(info.size, 64 * 1024)); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (json && info.size > buffer.length) throw new Error('Session metadata exceeds its read limit.');
      if (!json && bytesRead < info.size) text = text.slice(0, text.lastIndexOf('\n') + 1);
      if (!text && info.size > buffer.length) throw new Error('Session metadata header exceeds its read limit.');
      const rows = (json ? [text] : text.split('\n').filter(line => line.trim())).map((line, index) => {
        try { return record(JSON.parse(line)); }
        catch { if (json || index === 0) throw new Error('Session metadata is incomplete.'); return {}; }
      });
      // Cache only the metadata needed below, never transcript contents.
      const records = rows.map(row => ({ type: row.type, cwd: row.cwd, sessionId: row.sessionId, pid: row.pid, startedAt: row.startedAt, updatedAt: row.updatedAt, createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, lastUpdated: row.lastUpdated,
        payload: row.type === 'session_meta' ? { id: record(row.payload).id, cwd: record(row.payload).cwd, thread_source: record(row.payload).thread_source, subagent: !!record(record(row.payload).source).subagent } : undefined,
        projects: json ? row.projects : undefined }));
      this.#metadata.set(path, { stamp, records });
      if (this.#metadata.size > 20000) this.#metadata.delete(this.#metadata.keys().next().value!);
      return records;
    } finally { await file.close(); }
  }
  async #fromHome(runtime: Runtime, root: string, cutoff: number): Promise<Observed[]> {
    const budget = { remaining: this.options.scanLimit ?? 20000 }; const rows: Observed[] = [];
    const journal = async (path: string, key: string, fallback?: string) => {
      try {
        const info = await stat(path); if (!info.isFile() || info.mtimeMs < cutoff || this.#owned(path)) return;
        const records = path.endsWith('.txt') ? [] : await this.#head(path);
        if (runtime === 'codex') {
          const first = records[0]; if (first?.type !== 'session_meta') return;
          const meta = record(first.payload); if (meta.thread_source === 'subagent' || meta.subagent) return;
          rows.push(...this.#row(runtime, meta.id, meta.cwd, info.mtimeMs, 'codex-journal'));
        } else rows.push(...this.#row(runtime, key, records.find(row => typeof row.cwd === 'string')?.cwd ?? fallback, info.mtimeMs, `${runtime}-journal`));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
    if (runtime === 'codex') {
      const descend = async (path: string, depth: number): Promise<void> => {
        for (const entry of await this.#entries(path, budget)) {
          if (entry.directory && depth < 3 && /^\d+$/.test(entry.name)) await descend(join(path, entry.name), depth + 1);
          else if (!entry.directory && /^rollout-.*\.jsonl$/.test(entry.name)) await journal(join(path, entry.name), entry.name);
        }
      };
      await descend(join(root, 'sessions'), 0);
    } else if (runtime === 'claude') {
      const registry: JsonRecord[] = [];
      for (const entry of await this.#entries(join(root, 'sessions'), budget)) if (!entry.directory && entry.name.endsWith('.json')) {
        try {
          const row = (await this.#head(join(root, 'sessions', entry.name), true))[0]; if (!row) continue;
          const pid = row.pid; if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
          if (/^\d+\.json$/.test(entry.name) && Number(entry.name.slice(0, -5)) !== pid) continue;
          try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') continue; }
          if (typeof row.startedAt === 'number' && row.startedAt < this.#now() - uptime() * 1000 - 5000) continue;
          registry.push(row);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const starts = await (this.options.processStarts ?? processStarts)(registry.map(row => Number(row.pid)));
      for (const row of registry) {
        const actual = starts.get(Number(row.pid)); if (actual !== undefined && typeof row.startedAt === 'number' && Math.abs(actual - row.startedAt) > 5000) continue;
        rows.push(...this.#row(runtime, row.sessionId, row.cwd, epoch(row.updatedAt ?? row.startedAt), 'claude-registry'));
      }
      for (const project of await this.#entries(join(root, 'projects'), budget)) if (project.directory) {
        for (const entry of await this.#entries(join(root, 'projects', project.name), budget)) if (!entry.directory && entry.name.endsWith('.jsonl')) await journal(join(root, 'projects', project.name, entry.name), entry.name.slice(0, -6));
      }
    } else if (runtime === 'cursor') {
      const chats = new Map<string, string>();
      for (const workspace of await this.#entries(join(root, 'chats'), budget)) if (workspace.directory) {
        for (const chat of await this.#entries(join(root, 'chats', workspace.name), budget)) if (chat.directory) {
          try {
            const row = (await this.#head(join(root, 'chats', workspace.name, chat.name, 'meta.json'), true))[0]; if (!row) continue;
            if (typeof row.cwd === 'string') chats.set(chat.name, row.cwd);
            rows.push(...this.#row(runtime, chat.name, row.cwd, epoch(row.updatedAtMs ?? row.createdAtMs), 'cursor-cli'));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      for (const project of await this.#entries(join(root, 'projects'), budget)) if (project.directory) {
        const directory = join(root, 'projects', project.name, 'agent-transcripts');
        for (const entry of await this.#entries(directory, budget)) {
          if (entry.directory) await journal(join(directory, entry.name, `${entry.name}.jsonl`), entry.name, chats.get(entry.name));
          else if (/\.(jsonl|txt)$/.test(entry.name)) { const key = entry.name.replace(/\.(jsonl|txt)$/, ''); await journal(join(directory, entry.name), key, chats.get(key)); }
        }
      }
    } else {
      let mapping: JsonRecord = {};
      try { mapping = record((await this.#head(join(root, 'projects.json'), true))[0]?.projects); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const [cwd, name] of Object.entries(mapping)) {
        if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') continue;
        for (const entry of await this.#entries(join(root, 'tmp', name, 'chats'), budget)) if (!entry.directory && /^session-.*\.jsonl$/.test(entry.name)) {
          const path = join(root, 'tmp', name, 'chats', entry.name);
          try {
            const header = (await this.#head(path))[0]; const info = await stat(path);
            if (header) rows.push(...this.#row(runtime, header.sessionId, cwd, Math.max(info.mtimeMs, epoch(header.lastUpdated) || 0), 'gemini-journal'));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
    return rows;
  }
}
