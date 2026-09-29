import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CursorListSchema, CursorSessionSchema, CursorTranscriptSchema, type CursorSession } from '@jevellan/core/cursor';
import { readCursorSlice, type CursorReaderOptions } from './cursor-reader.js';
import { nativeActivity, nativeObject, nativeRecords, parseNativeTranscript, type NativeRuntime } from './native-transcript.js';

type Source = { file: string; session: CursorSession };
const DAY = 86_400_000;
export const nativeSessionId = (runtime: NativeRuntime, nativeId: string) => `${runtime}_${createHash('sha256').update(nativeId).digest('hex').slice(0, 32)}`;
const displayTitle = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
function entries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
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
    let budget = 20000;
    try {
      const titles = runtime === 'codex' ? codexTitles(root) : new Map<string, string>();
      const journal = (file: string) => {
        try {
          const info = statSync(file); if (!info.isFile() || info.mtimeMs < cutoff || info.mtimeMs > now) return;
          const head = readCursorSlice(file, 256 * 1024); const tail = readCursorSlice(file, 512 * 1024, true);
          const records = nativeRecords(head.raw).map(row => row.value);
          const recent = nativeRecords(tail.raw, tail.offset).map(row => row.value);
          let nativeId: unknown; let cwd: unknown; let title = '';
          if (runtime === 'codex') {
            if (records[0]?.type !== 'session_meta') return;
            const meta = nativeObject(records[0].payload);
            if (meta.thread_source === 'subagent' || nativeObject(meta.source).subagent) return;
            nativeId = meta.id ?? meta.session_id; cwd = meta.cwd;
            title = typeof nativeId === 'string' ? titles.get(nativeId) ?? '' : '';
            title ||= displayTitle(meta.title ?? meta.thread_name);
          } else {
            const identity = records.find(row => ['user', 'assistant'].includes(row.type) && typeof row.sessionId === 'string');
            if (!identity || identity.isSidechain === true) return;
            nativeId = identity.sessionId; cwd = identity.cwd;
            for (const row of [...records, ...recent]) if (row.type === 'custom-title' || row.type === 'ai-title') title = displayTitle(row.customTitle ?? row.aiTitle) || title;
          }
          if (typeof nativeId !== 'string' || !nativeId) return;
          if (!title) {
            const first = parseNativeTranscript(head.raw, runtime).find(turn => turn.role === 'user' && !turn.automated)?.blocks.find(block => block.type === 'text');
            if (first?.type === 'text') title = displayTitle(first.text);
          }
          const id = nativeSessionId(runtime, nativeId);
          const session = CursorSessionSchema.parse({ schema: 'cursor-session-v1', id, runtime, ownerDeviceId: options.deviceId,
            deviceName: options.deviceName, title: title || `${label} conversation`, cwd: typeof cwd === 'string' ? cwd : null,
            project: typeof cwd === 'string' ? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? label : label,
            lastActivityAt: new Date(info.mtimeMs).toISOString(), state: nativeActivity(tail.raw, runtime, info.mtimeMs, now),
            connected: true, canSend: false, canSteer: false });
          const old = sources.get(id);
          if (!old || old.session.lastActivityAt < session.lastActivityAt) sources.set(id, { file, session });
        } catch { unavailable.add(`${options.deviceName}: A ${label} transcript could not be read.`); }
      };
      const list = (path: string) => { const rows = entries(path); budget -= rows.length; if (budget < 0) throw new Error('Session discovery limit reached.'); return rows; };
      if (runtime === 'claude') {
        for (const project of list(join(root, 'projects'))) if (project.isDirectory()) {
          for (const entry of list(join(root, 'projects', project.name))) if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) journal(join(root, 'projects', project.name, entry.name));
        }
      } else {
        const walk = (path: string, depth: number) => {
          for (const entry of list(path)) {
            if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) walk(join(path, entry.name), depth + 1);
            else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) journal(join(path, entry.name));
          }
        };
        walk(join(root, 'sessions'), 0);
      }
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
