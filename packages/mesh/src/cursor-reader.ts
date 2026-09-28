import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  CursorHookStateSchema, CursorMessageSchema, CursorSessionSchema, CursorListSchema, CursorTranscriptSchema,
  readDocument, type CursorSession, type CursorMessage,
} from '@jevellan/core/cursor';
import { cursorSessionId, cursorUserText, parseCursorTranscript } from './cursor-transcript.js';
import { cursorActivity, cursorDisplayValue } from './cursor-activity.js';

export type CursorReaderOptions = { home: string; userHome: string; deviceId: string; deviceName: string; projectPaths: string[] };
type Source = { nativeId: string; file?: string; database?: string; session: CursorSession };
const DAY = 86_400_000;
const LIMIT = 8 * 1024 * 1024;
function entries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function readCursorSlice(file: string, maxBytes: number, tail = false) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size; const start = tail ? Math.max(0, size - maxBytes) : 0;
    const buffer = Buffer.alloc(Math.min(size, maxBytes)); const count = readSync(fd, buffer, 0, buffer.length, start);
    let raw = buffer.subarray(0, count).toString('utf8'); let offset = start;
    if (start > 0) { const cut = raw.indexOf('\n') + 1; offset += Buffer.byteLength(raw.slice(0, cut)); raw = raw.slice(cut); }
    if (file.endsWith('.jsonl')) raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
    return { raw, offset, truncated: size > maxBytes };
  } finally { closeSync(fd); }
}
export function cursorStatePath(home: string, id: string) { return join(home, 'cursor', id, 'state.json'); }
export function cursorHookState(home: string, id: string) {
  const file = cursorStatePath(home, id);
  return existsSync(file) ? readDocument(file, CursorHookStateSchema) : null;
}
export function cursorMessages(home: string, id: string): CursorMessage[] {
  return entries(join(home, 'cursor', id, 'messages')).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => readDocument(join(home, 'cursor', id, 'messages', entry.name), CursorMessageSchema))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function holdAlive(hold: z.infer<typeof CursorHookStateSchema>['hold']) {
  if (!hold || Date.parse(hold.until) < Date.now()) return false;
  try { process.kill(hold.pid, 0); return true; } catch { return false; }
}
function withHooks(options: CursorReaderOptions, source: Source): Source {
  const hook = cursorHookState(options.home, source.session.id);
  if (!hook) return source;
  const hookNewer = Date.parse(hook.at) >= Date.parse(source.session.lastActivityAt);
  const recent = Date.now() - Date.parse(hook.at) < 10 * 60_000;
  const held = holdAlive(hook.hold);
  const session = { ...source.session,
    state: held ? 'idle' as const : recent && (hookNewer || source.session.state === 'unknown') ? hook.state : source.session.state,
    lastActivityAt: hookNewer ? hook.at : source.session.lastActivityAt,
    canSend: held || recent && hook.state === 'working',
    canSteer: !held && recent && hook.state === 'working' && (hookNewer || source.session.state !== 'idle'),
  };
  // A journal completion newer than the hook must stop the spinner and steering.
  if (!hookNewer && source.session.state === 'idle' && !held) { session.canSteer = false; session.canSend = false; }
  return { ...source, session: CursorSessionSchema.parse(session) };
}
export function cursorDatabasePath(userHome: string, platform: NodeJS.Platform = process.platform) {
  return join(userHome, ...(platform === 'darwin' ? ['Library', 'Application Support'] : platform === 'win32' ? ['AppData', 'Roaming'] : ['.config']), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}
const MetadataRow = z.object({ id: z.string(), metadata: z.string(), toolStatus: z.string().nullable().optional() });
function discover(options: CursorReaderOptions): { sources: Source[]; unavailable: string[]; excludedSessionIds: string[] } {
  const sources = new Map<string, Source>(); const unavailable: string[] = [];
  const subagents = new Set<string>();
  const cutoff = Date.now() - 5 * DAY;
  const base = (nativeId: string, title: string, cwd: string | null, at: number, state: CursorSession['state']): Source => ({
    nativeId,
    session: CursorSessionSchema.parse({ schema: 'cursor-session-v1', id: cursorSessionId(nativeId),
      ownerDeviceId: options.deviceId, deviceName: options.deviceName, title: cursorUserText(title).replace(/\s+/g, ' ').slice(0, 120) || 'Cursor conversation',
      cwd, project: cwd ? basename(cwd) : 'Cursor', lastActivityAt: new Date(at).toISOString(), state,
      connected: true, canSteer: false, canSend: false }),
  });
  const databaseFile = cursorDatabasePath(options.userHome);
  if (existsSync(databaseFile)) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databaseFile, { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200;');
      // Newer desktop versions index children separately. Read all headers,
      // including old parents and children whose exported journals are recent.
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='composerHeaders'").get()) {
        for (const value of database.prepare('SELECT composerId FROM composerHeaders WHERE isSubagent = 1').all()) {
          subagents.add(z.object({ composerId: z.string() }).parse(value).composerId);
        }
      }
      const rows = database.prepare(`SELECT substr(c.key, 14) AS id,
        json_extract(c.value, '$.name', '$.cwd', '$.lastUpdatedAt', '$.updatedAt', '$.createdAt', '$.status', '$.conversationCheckpointLastUpdatedAt', '$.workspaceIdentifier.uri.fsPath', '$.isSubagent', '$.subagentInfo', '$.subagentComposerIds') AS metadata,
        CASE WHEN json_valid(b.value) THEN json_extract(b.value, '$.toolFormerData.status') END AS toolStatus
        FROM cursorDiskKV c LEFT JOIN cursorDiskKV b
          ON b.key = 'bubbleId:' || substr(c.key, 14) || ':' || json_extract(c.value, '$.fullConversationHeadersOnly[#-1].bubbleId')
        WHERE c.key >= 'composerData:' AND c.key < 'composerData;' AND json_valid(c.value) LIMIT 20001`).all();
      if (rows.length > 20000) throw new Error('Cursor metadata limit reached.');
      for (const value of rows) {
        const row = MetadataRow.parse(value);
        const [title, savedCwd, updated, changed, created, status, checkpoint, workspacePath, isSubagent, subagentInfo, childIds] = z.array(z.unknown()).parse(JSON.parse(row.metadata));
        if (isSubagent === true || isSubagent === 1 || (subagentInfo !== null && typeof subagentInfo === 'object' && !Array.isArray(subagentInfo))) subagents.add(row.id);
        if (Array.isArray(childIds)) for (const id of childIds) if (typeof id === 'string') subagents.add(id);
        const cwd = typeof savedCwd === 'string' && isAbsolute(savedCwd) ? savedCwd : workspacePath;
        const timestamp = Math.max(...[updated, changed, created, checkpoint].map(value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN).filter(value => Number.isFinite(value) && value <= Date.now()));
        if (!timestamp || timestamp < cutoff || timestamp > Date.now()) continue;
        sources.set(row.id, { ...base(row.id, typeof title === 'string' ? title : '', typeof cwd === 'string' && isAbsolute(cwd) ? cwd : null, timestamp, status === 'completed' ? 'idle' : status === 'generating' || row.toolStatus === 'loading' || row.toolStatus === 'running' ? 'working' : 'unknown'), database: databaseFile });
      }
    } catch { unavailable.push(`${options.deviceName}: Cursor’s saved chat database is unavailable.`); }
    finally { database?.close(); }
  }
  const cursorHome = join(options.userHome, '.cursor');
  const cli = new Set<string>();
  for (const workspace of entries(join(cursorHome, 'chats'))) if (workspace.isDirectory())
    for (const chat of entries(join(cursorHome, 'chats', workspace.name))) if (chat.isDirectory()) cli.add(chat.name);
  const paths = new Set(options.projectPaths);
  for (const root of ['Projects', 'dev']) for (const dir of entries(join(options.userHome, root))) if (dir.isDirectory()) paths.add(join(options.userHome, root, dir.name));
  for (const project of entries(join(cursorHome, 'projects'))) if (project.isDirectory()) {
    const matches = [...paths].filter(path => path.replace(/[/.]/g, '-').replace(/^-+/, '') === project.name.replace(/^-+/, ''));
    const cwd = matches.length === 1 ? matches[0]! : null;
    const root = join(cursorHome, 'projects', project.name, 'agent-transcripts');
    for (const entry of entries(root)) {
      if (!entry.isDirectory() && !(entry.isFile() && /\.(jsonl|txt)$/.test(entry.name))) continue;
      const nativeId = entry.isDirectory() ? entry.name : entry.name.replace(/\.(jsonl|txt)$/, '');
      if (cli.has(nativeId) || subagents.has(nativeId)) continue;
      const file = entry.isDirectory() ? join(root, nativeId, `${nativeId}.jsonl`) : join(root, entry.name);
      try {
        const info = statSync(file); if (!info.isFile() || info.mtimeMs < cutoff || info.mtimeMs > Date.now()) continue;
        const old = sources.get(nativeId);
        // The desktop database retains tool results that exported journals omit.
        // Keep that canonical source even when an export receives a newer mtime.
        if (old?.database) continue;
        const format = file.endsWith('.jsonl') ? 'jsonl' : 'text';
        const head = parseCursorTranscript(readCursorSlice(file, 64 * 1024).raw, format);
        const tail = parseCursorTranscript(readCursorSlice(file, 64 * 1024, true).raw, format);
        const first = head.turns.find(turn => turn.role === 'user')?.blocks.find(block => block.type === 'text');
        const title = old?.session.title !== 'Cursor conversation' ? old?.session.title : undefined;
        const fallback = first?.type === 'text' ? first.text.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        const state = tail.completed ? 'idle' : tail.active && Date.now() - info.mtimeMs < 120_000 ? 'working' : 'unknown';
        sources.set(nativeId, { ...base(nativeId, title || fallback, old?.session.cwd ?? cwd, info.mtimeMs, state), file });
      } catch { unavailable.push(`${options.deviceName}: A Cursor transcript could not be read.`); }
    }
  }
  for (const entry of entries(join(options.home, 'cursor'))) if (entry.isDirectory() && /^cursor_[a-f0-9]{32}$/.test(entry.name)) {
    const hook = cursorHookState(options.home, entry.name);
    if (hook && !subagents.has(hook.nativeId) && Date.parse(hook.at) >= cutoff && !sources.has(hook.nativeId)) sources.set(hook.nativeId, base(hook.nativeId, hook.title, hook.cwd, Date.parse(hook.at), hook.state));
  }
  return { sources: [...sources.values()].filter(source => !subagents.has(source.nativeId)).map(source => withHooks(options, source)).sort((a, b) => b.session.lastActivityAt.localeCompare(a.session.lastActivityAt)), unavailable: [...new Set(unavailable)], excludedSessionIds: [...subagents].map(cursorSessionId) };
}
export function cursorList(options: CursorReaderOptions) {
  const { sources, unavailable, excludedSessionIds } = discover(options);
  return CursorListSchema.parse({ schema: 'cursor-list-v1', sessions: sources.map(row => row.session), unavailable, excludedSessionIds, observedAt: new Date().toISOString() });
}
export function cursorSource(options: CursorReaderOptions, id: string) {
  const source = discover(options).sources.find(row => row.session.id === id);
  if (!source) throw new Error('This Cursor session is no longer available in the last five days.');
  return source;
}
export function cursorTranscript(options: CursorReaderOptions, id: string) {
  const source = cursorSource(options, id);
  let turns: z.infer<typeof CursorTranscriptSchema>['turns'] = []; let truncated = false;
  if (source.file) {
    const slice = readCursorSlice(source.file, LIMIT, true); truncated = slice.truncated;
    turns = parseCursorTranscript(slice.raw, source.file.endsWith('.jsonl') ? 'jsonl' : 'text', slice.offset).turns;
  } else if (source.database) {
    const database = new DatabaseSync(source.database, { readOnly: true });
    try {
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200;');
      const rows = database.prepare(`SELECT json_extract(b.value,
        '$.bubbleId', '$.type', '$.text', '$.thinking.text', '$.toolFormerData.name',
        '$.toolFormerData.toolCallId', '$.toolFormerData.status', '$.toolFormerData.params',
        '$.toolFormerData.rawArgs', '$.toolFormerData.result') AS display
        FROM cursorDiskKV c, json_each(c.value, '$.fullConversationHeadersOnly') h
        JOIN cursorDiskKV b ON b.key = ? || json_extract(h.value, '$.bubbleId')
        WHERE c.key = ? AND json_valid(c.value) AND json_valid(b.value)
        ORDER BY CAST(h.key AS INTEGER) DESC LIMIT 501`).all(`bubbleId:${source.nativeId}:`, `composerData:${source.nativeId}`);
      truncated = rows.length > 500;
      turns = rows.slice(0, 500).reverse().flatMap(value => {
        // Extract display fields together: repeatedly parsing large native bubbles
        // for each individual field makes long desktop conversations time out.
        const [id, role, text, thinking, toolName, toolId, toolStatus, params, rawArgs, toolOutput] = z.array(z.unknown()).parse(JSON.parse(String(value.display)));
        const row = { id, role, text, thinking, toolName, toolId, toolStatus, toolInput: params ?? rawArgs, toolOutput };
        const blocks: z.infer<typeof CursorTranscriptSchema>['turns'][number]['blocks'] = [];
        if (typeof row.thinking === 'string' && row.thinking) blocks.push({ type: 'thinking', text: cursorDisplayValue(row.thinking) });
        if (typeof row.text === 'string' && row.text) blocks.push({ type: 'text', text: row.role === 1 ? cursorUserText(cursorDisplayValue(row.text)) : cursorDisplayValue(row.text) });
        if (typeof row.toolName === 'string' && row.toolName) blocks.push({ type: 'tool',
          id: typeof row.toolId === 'string' ? row.toolId : `bubble:${row.id}`, name: row.toolName,
          input: cursorDisplayValue(row.toolInput ?? ''),
          ...(row.toolOutput !== null ? { output: cursorDisplayValue(row.toolOutput) } : {}),
          state: row.toolStatus === 'completed' ? 'completed' : row.toolStatus === 'error' || row.toolStatus === 'failed' ? 'failed' : row.toolStatus === 'loading' || row.toolStatus === 'running' ? 'running' : 'unknown',
        });
        return blocks.length ? [{ id: `bubble:${row.id}`, role: row.role === 1 ? 'user' as const : 'assistant' as const, blocks }] : [];
      });
    } finally { database.close(); }
  }
  return CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session: source.session, turns,
    activity: cursorActivity(options.home, id)?.turns ?? [],
    messages: cursorMessages(options.home, id), truncated, observedAt: new Date().toISOString() });
}
