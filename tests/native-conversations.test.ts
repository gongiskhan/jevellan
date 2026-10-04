import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NATIVE_SESSION_UNAVAILABLE, nativeList, nativeSessionId, nativeSessionsAt, nativeTranscript, nativeTranscriptAt } from '../packages/mesh/dist/native-sessions.js';
import { nativeActivity, parseNativeTranscript } from '../packages/mesh/dist/native-transcript.js';
import { NATIVE_TRANSCRIPT_TIMEOUT, NATIVE_TRANSCRIPT_UNREADABLE, listNativeSessions, readNativeTranscript } from '../packages/mesh/dist/native-transcript-reader.js';
import { nativeFormat, writeFakeNativeSession } from '../packages/runtime-contract/dist/index.js';

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

// Explicit roots (brief 6.4): an account home holds `projects/` and `sessions/` directly.
const DAY_MS = 86_400_000;
function account() {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-native-root-')); roots.push(root);
  const file = (relative: string, content: string, age = 1000) => { const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); const at = new Date(Date.now() - age); utimesSync(path, at, at); return path; };
  return { root, file };
}
const at = (root: string, runtime: 'claude' | 'codex', sessionId: string, extra: { file?: string } = {}) => ({ runtime, root, sessionId, deviceId: 'fixture-device', deviceName: 'Fixture', title: 'Fix the fixture', project: 'Fixture project', ...extra });
type Read = ReturnType<typeof nativeTranscriptAt>;
const texts = (transcript: Read) => transcript.turns.map(turn => `${turn.role}:${turn.blocks.map(block => block.type === 'tool' ? `${block.name}:${block.state}` : block.text).join('|')}`);
const failure = (run: () => unknown) => { try { run(); } catch (error) { return error as Error & { status?: number }; } throw new Error('Expected a failure.'); };
const large = (file: (relative: string, content: string) => string) => {
  const block = 'x'.repeat(30_000);
  return file('projects/-large/large.jsonl', jsonl(claude('user', 'Opening request', { sessionId: 'large' }),
    ...Array.from({ length: 320 }, () => claude('assistant', [{ type: 'text', text: block }], { sessionId: 'large' })), claude('user', 'Latest request', { sessionId: 'large' })));
};

test('nativeTranscriptAt reads Claude and Codex journals under an explicit root with no five-day cutoff', () => {
  const { root, file } = account(); const month = 30 * DAY_MS;
  const done = { content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn' };
  file('projects/-older/thread-session.jsonl', jsonl(claude('user', 'Stale copy', { sessionId: 'thread-session' })), 40 * DAY_MS);
  const claudeFile = file('projects/-worktree/thread-session.jsonl', jsonl(claude('user', '<system-reminder>hidden</system-reminder>Fix the fixture', { sessionId: 'thread-session', cwd: '/worktree' }), claude('assistant', null, { sessionId: 'thread-session', message: done })), month);
  const codexFile = file('sessions/2026/09/01/rollout-parent.jsonl', jsonl(codex('session_meta', { id: 'codex-thread', cwd: '/worktree' }),
    codex('event_msg', { type: 'user_message', message: 'Codex task' }), codex('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex done.' }] })), month);
  file('sessions/2026/09/02/rollout-2026-09-02-codex-thread.jsonl', jsonl(codex('session_meta', { id: 'codex-thread-copy', cwd: '/worktree' }), codex('event_msg', { type: 'user_message', message: 'Other session' })));
  file('sessions/2026/09/03/rollout-legacy.jsonl', jsonl(codex('session_meta', { session_id: 'codex-legacy', cwd: '/worktree' }), codex('event_msg', { type: 'user_message', message: 'Legacy task' })), month);
  const before = [readFileSync(claudeFile), readFileSync(codexFile)];
  const read = nativeTranscriptAt(at(root, 'claude', 'thread-session'));
  expect(read.session).toEqual({ schema: 'cursor-session-v1', id: nativeSessionId('claude', 'thread-session'), runtime: 'claude', ownerDeviceId: 'fixture-device', deviceName: 'Fixture',
    title: 'Fix the fixture', cwd: null, project: 'Fixture project', state: 'idle', lastActivityAt: new Date(statSync(claudeFile).mtimeMs).toISOString(), connected: true, canSteer: false, canSend: false });
  expect(texts(read)).toEqual(['user:Fix the fixture', 'assistant:Fixed.']);
  expect(read).toMatchObject({ schema: 'cursor-transcript-v1', messages: [], activity: [], truncated: false });
  const codexRead = nativeTranscriptAt(at(root, 'codex', 'codex-thread'));
  expect(codexRead.session).toMatchObject({ id: nativeSessionId('codex', 'codex-thread'), runtime: 'codex', cwd: null, lastActivityAt: new Date(statSync(codexFile).mtimeMs).toISOString() });
  expect(texts(codexRead)).toEqual(['user:Codex task', 'assistant:Codex done.']);
  expect(texts(nativeTranscriptAt(at(root, 'codex', 'codex-legacy')))).toEqual(['user:Legacy task']);
  expect([readFileSync(claudeFile), readFileSync(codexFile)]).toEqual(before);
});

test('nativeSessionsAt lists native id, cwd, file and mtime newest first and skips agent, sidechain and subagent journals', () => {
  const { root, file } = account();
  file('projects/-a/one.jsonl', jsonl(claude('user', 'One', { sessionId: 'one', cwd: '/a' })), 40 * DAY_MS);
  const one = file('projects/-b/one.jsonl', jsonl(claude('user', 'One again', { sessionId: 'one', cwd: '/b' })), 3000);
  const two = file('projects/-a/two.jsonl', jsonl(claude('user', 'Two', { sessionId: 'two', cwd: '/a' })), 1000);
  file('projects/-a/agent-three.jsonl', jsonl(claude('user', 'Agent', { sessionId: 'three' })));
  file('projects/-a/side.jsonl', jsonl(claude('user', 'Side', { sessionId: 'side', isSidechain: true })));
  const mtime = (path: string) => statSync(path).mtimeMs;
  expect(nativeSessionsAt({ runtime: 'claude', root })).toEqual([{ nativeId: 'two', cwd: '/a', file: two, mtimeMs: mtime(two) }, { nativeId: 'one', cwd: '/b', file: one, mtimeMs: mtime(one) }]);
  const old = file('sessions/2026/01/02/rollout-a.jsonl', jsonl(codex('session_meta', { id: 'codex-a', cwd: '/a' })), 90 * DAY_MS);
  file('sessions/2026/01/02/rollout-b.jsonl', jsonl(codex('session_meta', { id: 'codex-b', cwd: '/a', thread_source: 'subagent' })));
  file('sessions/2026/01/02/rollout-c.jsonl', jsonl(codex('session_meta', { id: 'codex-c', cwd: '/a', source: { subagent: { parent: 'codex-a' } } })));
  file('sessions/2026/01/02/rollout-d.jsonl', jsonl(codex('event_msg', { type: 'user_message', message: 'No meta' })));
  file('sessions/archive/rollout-e.jsonl', jsonl(codex('session_meta', { id: 'codex-e', cwd: '/a' })));
  expect(nativeSessionsAt({ runtime: 'codex', root })).toEqual([{ nativeId: 'codex-a', cwd: '/a', file: old, mtimeMs: mtime(old) }]);
  expect(nativeSessionsAt({ runtime: 'codex', root: join(root, 'missing') })).toEqual([]);
});

test('sessions written by the fake native writer read back through nativeFormat for both formats', () => {
  const { root } = account();
  for (const runtime of ['fake', 'codex']) {
    const format = nativeFormat(runtime); const home = join(root, runtime); const sessionId = `${runtime}-session`;
    const write = (rows: Parameters<typeof writeFakeNativeSession>[0]['rows'], append: boolean) => writeFakeNativeSession({ format, home, sessionId, cwd: '/worktree', rows, append });
    write([{ role: 'user', text: 'Task one' }], false);
    write([{ role: 'assistant', text: 'Working on it.', tools: [{ id: 'call-1', name: 'Read', input: { path: 'a.ts' }, output: 'contents' }, { id: 'call-2', name: 'Write', input: {}, output: 'denied', failed: true }] }], true);
    write([{ role: 'user', text: 'Task two' }], true);
    const read = nativeTranscriptAt(at(home, format, sessionId));
    expect(read.session).toMatchObject({ id: nativeSessionId(format, sessionId), runtime: format, cwd: null });
    expect(texts(read)).toEqual(['user:Task one', 'assistant:Read:completed', 'assistant:Write:failed', 'assistant:Working on it.', 'user:Task two']);
    expect(nativeSessionsAt({ runtime: format, root: home })).toMatchObject([{ nativeId: sessionId, cwd: '/worktree' }]);
  }
  expect(nativeFormat('fake')).toBe('claude'); expect(nativeFormat('codex')).toBe('codex');
});

test('transcripts at a root keep the last 500 turns and the 8 MiB tail', () => {
  const { root, file } = account();
  file('projects/-many/many.jsonl', jsonl(...Array.from({ length: 501 }, (_, index) => index % 2
    ? claude('assistant', [{ type: 'text', text: `Turn ${index}` }], { sessionId: 'many' }) : claude('user', `Turn ${index}`, { sessionId: 'many' }))));
  const many = nativeTranscriptAt(at(root, 'claude', 'many'));
  expect(many.turns).toHaveLength(500); expect(many.truncated).toBe(true);
  expect(texts(many)[0]).toBe('assistant:Turn 1'); expect(texts(many).at(-1)).toBe('user:Turn 500');
  expect(statSync(large(file)).size).toBeGreaterThan(8 * 1024 * 1024);
  const tail = nativeTranscriptAt(at(root, 'claude', 'large'));
  expect(tail.truncated).toBe(true); expect(tail.turns.length).toBeLessThan(500);
  expect(texts(tail)).not.toContain('user:Opening request'); expect(texts(tail).at(-1)).toBe('user:Latest request');
  expect(Number(tail.turns[0]!.id.replace('journal:', ''))).toBeGreaterThan(0);
});

test('a missing session is a 404 with the thread copy, and file hints count only inside the root journal layout', () => {
  const { root, file } = account(); const outside = account();
  expect(NATIVE_SESSION_UNAVAILABLE).toBe("This thread's session is not available on this device.");
  expect(failure(() => nativeTranscriptAt(at(root, 'claude', 'absent')))).toMatchObject({ message: NATIVE_SESSION_UNAVAILABLE, status: 404 });
  expect(failure(() => nativeTranscriptAt(at(join(root, 'missing'), 'codex', 'absent')))).toMatchObject({ message: NATIVE_SESSION_UNAVAILABLE, status: 404 });
  const foreign = outside.file('projects/-x/absent.jsonl', jsonl(claude('user', 'Not in this root', { sessionId: 'absent' })));
  expect(failure(() => nativeTranscriptAt(at(root, 'claude', 'absent', { file: foreign })))).toMatchObject({ status: 404 });
  expect(failure(() => nativeTranscriptAt(at(root, 'claude', 'absent', { file: `${root}/projects/-x/../../../${basename(outside.root)}/projects/-x/absent.jsonl` })))).toMatchObject({ status: 404 });
  const hinted = file('projects/-w/hinted.jsonl', jsonl(claude('user', 'Hinted', { sessionId: 'hinted' })));
  file('projects/-v/moved.jsonl', jsonl(claude('user', 'Moved', { sessionId: 'moved' })));
  expect(texts(nativeTranscriptAt(at(root, 'claude', 'hinted', { file: hinted })))).toEqual(['user:Hinted']);
  expect(texts(nativeTranscriptAt(at(root, 'claude', 'moved', { file: hinted })))).toEqual(['user:Moved']);
  const other = file('sessions/2026/10/01/rollout-other.jsonl', jsonl(codex('session_meta', { id: 'codex-other', cwd: '/a' }), codex('event_msg', { type: 'user_message', message: 'Other' })));
  file('sessions/2026/10/02/rollout-mine.jsonl', jsonl(codex('session_meta', { id: 'codex-mine', cwd: '/a' }), codex('event_msg', { type: 'user_message', message: 'Mine' })));
  expect(texts(nativeTranscriptAt(at(root, 'codex', 'codex-mine', { file: other })))).toEqual(['user:Mine']);
});

test('the transcript worker returns the same results without blocking the event loop and keeps the 404 status', async () => {
  const { root, file } = account();
  file('projects/-w/worker.jsonl', jsonl(claude('user', 'Through the worker', { sessionId: 'worker' })), DAY_MS);
  file('sessions/2026/10/03/rollout-worker.jsonl', jsonl(codex('session_meta', { id: 'codex-worker', cwd: '/w' })), DAY_MS);
  const direct = nativeTranscriptAt(at(root, 'claude', 'worker'));
  expect({ ...await readNativeTranscript(at(root, 'claude', 'worker')), observedAt: '' }).toEqual({ ...direct, observedAt: '' });
  expect(await listNativeSessions({ runtime: 'codex', root })).toEqual(nativeSessionsAt({ runtime: 'codex', root }));
  const missing = await readNativeTranscript(at(root, 'codex', 'absent')).catch((error: unknown) => error as Error & { status?: number });
  expect(missing).toMatchObject({ message: NATIVE_SESSION_UNAVAILABLE, status: 404 });
  large(file); const order: string[] = [];
  const read = readNativeTranscript(at(root, 'claude', 'large')).then(transcript => { order.push('read'); return transcript; });
  setImmediate(() => order.push('immediate'));
  expect((await read).truncated).toBe(true); expect(order).toEqual(['immediate', 'read']);
}, 60_000);

test('the transcript worker times out with the thread copy and hides file system errors', async () => {
  const { root, file } = account();
  file('projects/-w/slow.jsonl', jsonl(claude('user', 'Slow', { sessionId: 'slow' })));
  const failed = (promise: Promise<unknown>) => promise.then(() => { throw new Error('Expected a failure.'); }, (error: unknown) => error as Error & { status?: number });
  expect(NATIVE_TRANSCRIPT_TIMEOUT).toBe('The thread transcript did not load in time.');
  expect(NATIVE_TRANSCRIPT_UNREADABLE).toBe('The thread transcript could not be read on this device.');
  expect(await failed(readNativeTranscript(at(root, 'claude', 'slow'), { timeoutMs: 1 }))).toMatchObject({ message: NATIVE_TRANSCRIPT_TIMEOUT });
  const blocker = file('not-a-directory', 'plain file');
  for (const error of [await failed(readNativeTranscript(at(blocker, 'claude', 'slow'))), await failed(listNativeSessions({ runtime: 'codex', root: blocker }))]) {
    expect(error.message).toBe(NATIVE_TRANSCRIPT_UNREADABLE); expect(error.status).toBeUndefined();
  }
  if (process.getuid?.() !== 0) {
    const locked = file('projects/-w/locked.jsonl', jsonl(claude('user', 'Locked', { sessionId: 'locked' })));
    chmodSync(locked, 0o000);
    try { const error = await failed(readNativeTranscript(at(root, 'claude', 'locked'))); expect(error.message).toBe(NATIVE_TRANSCRIPT_UNREADABLE); expect(error.message).not.toContain(root); }
    finally { chmodSync(locked, 0o600); }
  }
  await expect(readNativeTranscript(at('relative/root', 'claude', 'slow'))).rejects.toThrow();
}, 60_000);
