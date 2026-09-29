import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeList, nativeSessionId, nativeTranscript } from '../packages/mesh/dist/native-sessions.js';
import { nativeActivity, parseNativeTranscript } from '../packages/mesh/dist/native-transcript.js';

// Adapted from the read-only reference's shells-listers and talk-transcript-formats
// cases. Synthetic homes only; execution deferred at the user's request.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const claude = (type: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type, sessionId: 'parent-fixture', cwd: '/project', message: { content }, ...extra });
const codex = (type: string, payload: Record<string, unknown>) => ({ type, payload });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-native-')); roots.push(root);
  const options = { home: join(root, 'isolated'), userHome: join(root, 'user'), deviceId: 'fixture-device', deviceName: 'Fixture', projectPaths: [] };
  const file = (relative: string, content: string, age = 1000) => { const path = join(options.userHome, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); const at = new Date(Date.now() - age); utimesSync(path, at, at); return path; };
  return { options, file };
}
test('Claude keeps Markdown, readable thinking and paired tool outputs without tool-result user turns', () => {
  const turns = parseNativeTranscript(jsonl(claude('user', '## Request\n\n- Keep tables'), claude('assistant', [{ type: 'thinking', thinking: 'Inspecting' }, { type: 'tool_use', id: 'call-fixture', name: 'Read', input: { path: 'file.ts' } }]), claude('user', [{ type: 'tool_result', tool_use_id: 'call-fixture', content: [{ type: 'text', text: 'file contents' }] }])), 'claude');
  expect(turns).toHaveLength(2);
  expect(turns[0]!.blocks[0]).toMatchObject({ type: 'text', text: '## Request\n\n- Keep tables' });
  expect(turns[1]!.blocks).toMatchObject([{ type: 'thinking', text: 'Inspecting' }, { type: 'tool', name: 'Read', output: 'file contents', state: 'completed' }]);
});
test('Codex skips developer scaffolding and encrypted reasoning, joins both tool formats and tolerates torn lines', () => {
  const rows = [codex('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Scaffolding' }] }),
    codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] }),
    codex('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checking' }], encrypted_content: 'not-displayable' }),
    codex('response_item', { type: 'custom_tool_call', call_id: 'a', name: 'exec', input: 'read logs' }),
    codex('response_item', { type: 'custom_tool_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'Logs' }] }),
    codex('response_item', { type: 'function_call', call_id: 'b', name: 'wait', arguments: '{"id":"fixture"}' }),
    codex('response_item', { type: 'function_call_output', call_id: 'b', output: 'Finished' })];
  const turns = parseNativeTranscript(jsonl(...rows) + '{torn', 'codex');
  expect(turns).toHaveLength(4);
  expect(turns[2]!.blocks[0]).toMatchObject({ name: 'exec', output: 'Logs', state: 'completed' });
  expect(turns[3]!.blocks[0]).toMatchObject({ name: 'wait', output: 'Finished', state: 'completed' });
  expect(JSON.stringify(turns)).not.toMatch(/Scaffolding|not-displayable/);
});
test('Codex user events replace duplicate response items and omit ambient browser context', () => {
  const turns = parseNativeTranscript(jsonl(codex('event_msg', { type: 'user_message', message: '<in-app-browser-context source="ambient-ui-state">Browser context</in-app-browser-context>\n\n## My request:\nOne request' }), codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'One request' }] })), 'codex');
  expect(turns).toHaveLength(1); expect(turns[0]!.blocks[0]).toMatchObject({ text: 'One request' });
});
test('five-day discovery excludes subagents and leaves native journals untouched', () => {
  const { options, file } = fixture();
  const path = file('.claude/projects/project/parent.jsonl', jsonl(claude('user', 'Parent request'), { type: 'ai-title', aiTitle: 'Named work' }));
  const before = readFileSync(path);
  file('.claude/projects/project/child.jsonl', jsonl(claude('user', 'Child', { isSidechain: true, sessionId: 'child-fixture' })));
  file('.claude/projects/project/agent-child.jsonl', jsonl(claude('user', 'Child')));
  file('.claude/projects/project/old.jsonl', jsonl(claude('user', 'Old', { sessionId: 'old-fixture' })), 6 * 86_400_000);
  file('.codex/sessions/2026/09/29/rollout-child.jsonl', jsonl(codex('session_meta', { id: 'codex-child', cwd: '/project', source: { subagent: {} } })));
  const list = nativeList(options);
  expect(list.unavailable).toEqual([]);
  expect(list.sessions).toMatchObject([{ runtime: 'claude', title: 'Named work', canSend: false, canSteer: false }]);
  expect(nativeTranscript(options, list.sessions[0]!.id).turns[0]!.blocks[0]).toMatchObject({ text: 'Parent request' });
  expect(readFileSync(path)).toEqual(before);
});
test('Codex titles prefer saved native names, then the session index', () => {
  const { options, file } = fixture();
  file('.codex/sessions/2026/09/29/rollout-parent.jsonl', jsonl(codex('session_meta', { id: 'codex-parent', cwd: '/project' })));
  file('.codex/session_index.jsonl', jsonl({ id: 'codex-parent', thread_name: 'Indexed title' }));
  expect(nativeList(options).sessions[0]!.title).toBe('Indexed title');
  const db = new DatabaseSync(join(options.userHome, '.codex/state_1.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, title TEXT, name TEXT)'); db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('codex-parent', 'Generated title', 'Renamed work'); db.close();
  expect(nativeList(options).sessions[0]).toMatchObject({ id: nativeSessionId('codex', 'codex-parent'), title: 'Renamed work' });
});
test('quiet native turns keep working until completion, and stale unfinished turns become unknown', () => {
  const now = Date.now(); const quiet = now - 45_000;
  const work = jsonl(claude('assistant', [{ type: 'tool_use', name: 'TaskOutput' }], { timestamp: new Date(quiet).toISOString() }));
  expect(nativeActivity(work, 'claude', quiet, now)).toBe('working');
  expect(nativeActivity(work + jsonl({ type: 'system', subtype: 'turn_duration' }), 'claude', quiet, now)).toBe('idle');
  expect(nativeActivity(work, 'claude', now - 7 * 3_600_000, now)).toBe('unknown');
  expect(nativeActivity(jsonl(codex('event_msg', { type: 'task_started' }), codex('event_msg', { type: 'task_complete' })), 'codex', quiet, now)).toBe('idle');
  expect(nativeActivity(jsonl(claude('user', '<command-name>/clear</command-name>')), 'claude', quiet, now)).toBe('idle');
});
test('Claude null-stop text gets a short grace period while explicit completion settles immediately', () => {
  const now = Date.now(); const text = jsonl(claude('assistant', [{ type: 'text', text: 'Done' }], { timestamp: new Date(now).toISOString() }));
  expect(nativeActivity(text, 'claude', now, now + 1000)).toBe('working');
  expect(nativeActivity(text, 'claude', now, now + 6000)).toBe('idle');
});

test('existing SSH hosts remain explicit and no forwarding option is introduced', async () => {
  const { cursorSshArguments } = await import('../packages/mesh/dist/cursor-service.js');
  const args = cursorSshArguments({ id: 'cursor_remote_fixture', name: 'Fixture', host: 'fixture-host', port: 22, user: 'fixture', nodePath: '/tools/node', helperPath: '/isolated/reader.mjs', home: '/isolated' });
  expect(args).toContain('fixture@fixture-host');
  expect(args).not.toContain('-L'); expect(args).not.toContain('-R');
});
