import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type FakeNativeTool = { id: string; name: string; input: unknown; output: string; failed?: boolean };
export type FakeNativeRow = { role: 'user' | 'assistant'; text?: string; tools?: FakeNativeTool[] };
export type FakeNativeSession = { format: 'claude' | 'codex'; home: string; sessionId: string; cwd: string; rows: FakeNativeRow[]; append: boolean };

const firstLine = (file: string) => {
  const descriptor = openSync(file, 'r'); const buffer = Buffer.alloc(64 * 1024);
  try { return buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, 0)).toString('utf8').split('\n')[0] ?? ''; }
  finally { closeSync(descriptor); }
};
const entries = (path: string) => { try { return readdirSync(path, { withFileTypes: true }); } catch { return []; } };

/** The journal holding a native session in an account home: Claude `projects/<any>/<id>.jsonl`, or the Codex rollout whose `session_meta` id matches. */
export function fakeNativeSessionFile(format: 'claude' | 'codex', home: string, sessionId: string): string | undefined {
  if (format === 'claude') {
    for (const project of entries(join(home, 'projects'))) if (project.isDirectory() && entries(join(home, 'projects', project.name)).some((entry) => entry.isFile() && entry.name === `${sessionId}.jsonl`)) return join(home, 'projects', project.name, `${sessionId}.jsonl`);
    return undefined;
  }
  const walk = (path: string, depth: number): string | undefined => {
    for (const entry of entries(path)) {
      if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) { const found = walk(join(path, entry.name), depth + 1); if (found) return found; }
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { const meta = JSON.parse(firstLine(join(path, entry.name))) as { type?: unknown; payload?: { id?: unknown } }; if (meta.type === 'session_meta' && meta.payload?.id === sessionId) return join(path, entry.name); }
        catch { /* Not a readable rollout. */ }
      }
    }
    return undefined;
  };
  return walk(join(home, 'sessions'), 0);
}

/** Writes the minimal native journal rows the transcript reader parses; resumed sessions append to the journal found on disk. Returns the file. */
export function writeFakeNativeSession(session: FakeNativeSession): string {
  const { format, home, sessionId, cwd } = session;
  const now = new Date(); const timestamp = now.toISOString(); const lines: unknown[] = [];
  let file = session.append ? fakeNativeSessionFile(format, home, sessionId) : undefined;
  if (format === 'claude') {
    file ??= join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
    const row = (role: 'user' | 'assistant', content: unknown, extra: object = {}) => ({ type: role, sessionId, cwd, timestamp, message: { role, content, ...extra } });
    for (const entry of session.rows) {
      for (const tool of entry.tools ?? []) lines.push(row('assistant', [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }]), row('user', [{ type: 'tool_result', tool_use_id: tool.id, content: tool.output, is_error: tool.failed === true }]));
      if (entry.text) lines.push(entry.role === 'user' ? row('user', entry.text) : row('assistant', [{ type: 'text', text: entry.text }], { stop_reason: 'end_turn' }));
    }
  } else {
    if (!file) {
      const pad = (value: number) => String(value).padStart(2, '0');
      const [year, month, day] = [String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())];
      file = join(home, 'sessions', year, month, day, `rollout-${year}-${month}-${day}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${sessionId}.jsonl`);
      lines.push({ type: 'session_meta', timestamp, payload: { id: sessionId, cwd, timestamp } });
    }
    for (const entry of session.rows) {
      for (const tool of entry.tools ?? []) lines.push({ type: 'response_item', timestamp, payload: { type: 'function_call', call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.input ?? {}) } },
        { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: tool.id, output: tool.output, ...(tool.failed ? { is_error: true } : {}) } });
      if (entry.text) lines.push(entry.role === 'user' ? { type: 'event_msg', timestamp, payload: { type: 'user_message', message: entry.text } }
        : { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: entry.text }] } });
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return file;
}
