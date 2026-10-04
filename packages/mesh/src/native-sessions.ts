import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CursorListSchema, CursorSessionSchema, CursorTranscriptSchema, type CursorSession } from '@jevellan/core/cursor';
import { readCursorSlice, type CursorReaderOptions } from './cursor-reader.js';
import { nativeActivity, nativeObject, nativeRecords, parseNativeTranscript, type NativeRuntime } from './native-transcript.js';

type Source = { file: string; session: CursorSession };
type CursorTranscript = z.infer<typeof CursorTranscriptSchema>;
const DAY = 86_400_000;
export const nativeSessionId = (runtime: NativeRuntime, nativeId: string) => `${runtime}_${createHash('sha256').update(nativeId).digest('hex').slice(0, 32)}`;
const displayTitle = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
function entries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
type Entries = (path: string) => ReturnType<typeof entries>;
/** Directory listing with the shared 20,000-entry scan budget. */
const budgeted = (): Entries => {
  let budget = 20000;
  return path => { const rows = entries(path); budget -= rows.length; if (budget < 0) throw new Error('Session discovery limit reached.'); return rows; };
};
/** Visits every candidate journal under a native root: Claude `projects/<dir>/*.jsonl` except `agent-*`, Codex `sessions/<digits>/<digits>/<digits>/rollout-*.jsonl`. */
function walkJournals(root: string, runtime: NativeRuntime, list: Entries, visit: (file: string) => void) {
  if (runtime === 'claude') {
    for (const project of list(join(root, 'projects'))) if (project.isDirectory()) {
      for (const entry of list(join(root, 'projects', project.name))) if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) visit(join(root, 'projects', project.name, entry.name));
    }
    return;
  }
  const walk = (path: string, depth: number) => {
    for (const entry of list(path)) {
      if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) walk(join(path, entry.name), depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) visit(join(path, entry.name));
    }
  };
  walk(join(root, 'sessions'), 0);
}
/** A journal's native identity from its head records; undefined for sidechain and subagent journals and journals without an id. */
function journalIdentity(records: ReturnType<typeof nativeRecords>[number]['value'][], runtime: NativeRuntime) {
  let nativeId: unknown; let cwd: unknown; let meta: Record<string, unknown> = {};
  if (runtime === 'codex') {
    if (records[0]?.type !== 'session_meta') return undefined;
    meta = nativeObject(records[0].payload);
    if (meta.thread_source === 'subagent' || nativeObject(meta.source).subagent) return undefined;
    nativeId = meta.id ?? meta.session_id; cwd = meta.cwd;
  } else {
    const identity = records.find(row => ['user', 'assistant'].includes(row.type) && typeof row.sessionId === 'string');
    if (!identity || identity.isSidechain === true) return undefined;
    nativeId = identity.sessionId; cwd = identity.cwd;
  }
  return typeof nativeId === 'string' && nativeId ? { nativeId, cwd: typeof cwd === 'string' ? cwd : null, meta } : undefined;
}
const HEAD = 256 * 1024;
const headRecords = (file: string) => nativeRecords(readCursorSlice(file, HEAD).raw).map(row => row.value);
function codexTitles(root: string) {
  const titles = new Map<string, string>();
  try {
    for (const { value } of nativeRecords(readCursorSlice(join(root, 'session_index.jsonl'), 1024 * 1024, true).raw)) {
      if (typeof value.id === 'string' && displayTitle(value.thread_name)) titles.set(value.id, displayTitle(value.thread_name));
    }
  } catch { /* Titles are optional; journal identity is authoritative. */ }
  const databases = entries(root).filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name)).sort((a, b) => Number(b.name.match(/\d+/)![0]) - Number(a.name.match(/\d+/)![0]));
  for (const file of databases) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(join(root, file.name), { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200;');
      const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
      if (!columns.has('id') || !columns.has('title')) continue;
      const title = columns.has('name') ? "coalesce(nullif(name, ''), title)" : 'title';
      const rows = database.prepare(`SELECT id, substr(${title}, 1, 200) AS title FROM threads ${columns.has('updated_at') ? 'ORDER BY updated_at DESC' : ''} LIMIT 10000`).all();
      for (const value of rows) { const row = z.object({ id: z.string(), title: z.string().nullable() }).parse(value); if (displayTitle(row.title)) titles.set(row.id, displayTitle(row.title)); }
      break;
    } catch { /* Optional native index migrations/locks do not hide journals. */ }
    finally { database?.close(); }
  }
  return titles;
}
function discover(options: CursorReaderOptions) {
  const sources = new Map<string, Source>(); const unavailable = new Set<string>();
  const now = Date.now(); const cutoff = now - 5 * DAY;
  for (const runtime of ['claude', 'codex'] as const) {
    const label = runtime === 'claude' ? 'Claude Code' : 'Codex';
    const root = join(options.userHome, `.${runtime}`);
    const list = budgeted();
    try {
      const titles = runtime === 'codex' ? codexTitles(root) : new Map<string, string>();
      const journal = (file: string) => {
        try {
          const info = statSync(file); if (!info.isFile() || info.mtimeMs < cutoff || info.mtimeMs > now) return;
          const head = readCursorSlice(file, HEAD); const tail = readCursorSlice(file, 512 * 1024, true);
          const records = nativeRecords(head.raw).map(row => row.value);
          const recent = nativeRecords(tail.raw, tail.offset).map(row => row.value);
          const identity = journalIdentity(records, runtime); if (!identity) return;
          const { nativeId, cwd } = identity; let title = '';
          if (runtime === 'codex') title = titles.get(nativeId) || displayTitle(identity.meta.title ?? identity.meta.thread_name);
          else for (const row of [...records, ...recent]) if (row.type === 'custom-title' || row.type === 'ai-title') title = displayTitle(row.customTitle ?? row.aiTitle) || title;
          if (!title) {
            const first = parseNativeTranscript(head.raw, runtime).find(turn => turn.role === 'user' && !turn.automated)?.blocks.find(block => block.type === 'text');
            if (first?.type === 'text') title = displayTitle(first.text);
          }
          const id = nativeSessionId(runtime, nativeId);
          const session = CursorSessionSchema.parse({ schema: 'cursor-session-v1', id, runtime, ownerDeviceId: options.deviceId,
            deviceName: options.deviceName, title: title || `${label} conversation`, cwd,
            project: cwd !== null ? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? label : label,
            lastActivityAt: new Date(info.mtimeMs).toISOString(), state: nativeActivity(tail.raw, runtime, info.mtimeMs, now),
            connected: true, canSend: false, canSteer: false });
          const old = sources.get(id);
          if (!old || old.session.lastActivityAt < session.lastActivityAt) sources.set(id, { file, session });
        } catch { unavailable.add(`${options.deviceName}: A ${label} transcript could not be read.`); }
      };
      walkJournals(root, runtime, list, journal);
    } catch { unavailable.add(`${options.deviceName}: ${label} sessions are unavailable.`); }
  }
  return { sources: [...sources.values()].sort((a, b) => b.session.lastActivityAt.localeCompare(a.session.lastActivityAt)), unavailable: [...unavailable] };
}
export function nativeList(options: CursorReaderOptions) {
  const { sources, unavailable } = discover(options);
  return CursorListSchema.parse({ schema: 'cursor-list-v1', sessions: sources.map(source => source.session), unavailable, observedAt: new Date().toISOString() });
}
export function nativeTranscript(options: CursorReaderOptions, id: string) {
  const source = discover(options).sources.find(source => source.session.id === id);
  if (!source) throw new Error('This session is no longer available in the last five days.');
  const slice = readCursorSlice(source.file, 8 * 1024 * 1024, true);
  const turns = parseNativeTranscript(slice.raw, source.session.runtime as NativeRuntime, slice.offset);
  return CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session: source.session, turns: turns.slice(-500), messages: [], activity: [], truncated: slice.truncated || turns.length > 500, observedAt: new Date().toISOString() });
}

export type NativeJournal = { nativeId: string; cwd: string | null; file: string; mtimeMs: number };
export type NativeTranscriptAtOptions = { runtime: NativeRuntime; root: string; sessionId: string; deviceId: string; deviceName: string; title: string; project: string; file?: string | undefined };
export const NATIVE_SESSION_UNAVAILABLE = "This thread's session is not available on this device.";
const TRANSCRIPT = 8 * 1024 * 1024; const ACTIVITY = 512 * 1024;
/** Journals under an explicit native root (an account home), newest first: no age cutoff and no titles; agent, sidechain and subagent journals are skipped and the newest file wins for a repeated id. */
export function nativeSessionsAt(options: { runtime: NativeRuntime; root: string }): NativeJournal[] {
  const journals = new Map<string, NativeJournal>();
  walkJournals(options.root, options.runtime, budgeted(), file => {
    try {
      const info = statSync(file); if (!info.isFile()) return;
      const identity = journalIdentity(headRecords(file), options.runtime); const old = identity && journals.get(identity.nativeId);
      if (identity && (!old || old.mtimeMs < info.mtimeMs)) journals.set(identity.nativeId, { nativeId: identity.nativeId, cwd: identity.cwd, file, mtimeMs: info.mtimeMs });
    } catch { /* A journal removed or unreadable during the scan is not listed. */ }
  });
  return [...journals.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}
/** The journal holding one native session under `root`. A `file` hint is used only when it sits in the root's journal layout and holds that session; otherwise the root is scanned (Codex file names carrying the id first) and the newest match wins. The id is compared, never joined into a path. */
function journalAt(runtime: NativeRuntime, root: string, sessionId: string, hint?: string) {
  const name = `${sessionId}.jsonl`;
  const holds = (file: string) => {
    try { const info = statSync(file); return info.isFile() && (runtime === 'claude' || journalIdentity(headRecords(file), runtime)?.nativeId === sessionId) ? info.mtimeMs : undefined; }
    catch { return undefined; }
  };
  const newest = (files: string[]) => { let best: { file: string; at: number } | undefined; for (const file of files) { const at = holds(file); if (at !== undefined && (!best || best.at < at)) best = { file, at }; } return best?.file; };
  if (hint) {
    const file = resolve(hint); const parts = relative(resolve(root), file).split(sep);
    const layout = isAbsolute(hint) && !parts.includes('..') && (runtime === 'claude'
      ? parts.length === 3 && parts[0] === 'projects' && parts[2] === name && !name.startsWith('agent-')
      : parts.length >= 2 && parts.length <= 5 && parts[0] === 'sessions' && parts.slice(1, -1).every(part => /^\d+$/.test(part)) && /^rollout-.*\.jsonl$/.test(parts.at(-1)!));
    if (layout && holds(file) !== undefined) return file;
  }
  const files: string[] = [];
  walkJournals(root, runtime, budgeted(), file => { if (runtime === 'codex' || basename(file) === name) files.push(file); });
  return runtime === 'claude' ? newest(files) : newest(files.filter(file => basename(file).includes(sessionId))) ?? newest(files.filter(file => !basename(file).includes(sessionId)));
}
/** A thread's native transcript from an explicit root: the 8 MiB tail, the last 500 turns, no age cutoff. Synchronous; the daemon reads it through the transcript worker. */
export function nativeTranscriptAt(options: NativeTranscriptAtOptions): CursorTranscript {
  const unavailable = () => Object.assign(new Error(NATIVE_SESSION_UNAVAILABLE), { status: 404 });
  const file = journalAt(options.runtime, options.root, options.sessionId, options.file); if (!file) throw unavailable();
  let read: { modified: number; slice: ReturnType<typeof readCursorSlice> };
  try { read = { modified: statSync(file).mtimeMs, slice: readCursorSlice(file, TRANSCRIPT, true) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw unavailable(); throw error; }
  const { modified, slice } = read; const now = Date.now();
  const turns = parseNativeTranscript(slice.raw, options.runtime, slice.offset);
  const session = CursorSessionSchema.parse({ schema: 'cursor-session-v1', id: nativeSessionId(options.runtime, options.sessionId), runtime: options.runtime,
    ownerDeviceId: options.deviceId, deviceName: options.deviceName, title: options.title, cwd: null, project: options.project,
    lastActivityAt: new Date(modified).toISOString(), state: nativeActivity(slice.raw.slice(-ACTIVITY), options.runtime, modified, now),
    connected: true, canSend: false, canSteer: false });
  return CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session, turns: turns.slice(-500), messages: [], activity: [], truncated: slice.truncated || turns.length > 500, observedAt: new Date(now).toISOString() });
}
