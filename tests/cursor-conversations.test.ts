import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCursorTranscript, cursorSessionId } from '../packages/mesh/dist/cursor-transcript.js';
import { cursorList, cursorTranscript } from '../packages/mesh/dist/cursor-reader.js';
import { queueCursorMessage, saveCursorHookState } from '../packages/mesh/dist/cursor-control.js';
import { recordCursorActivity } from '../packages/mesh/dist/cursor-activity.js';

// Adapted from the reference lister/structured-transcript regressions. Synthetic
// input only. Run for the reported Cursor display and activity regressions.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const message = (role: string, content: unknown) => ({ role, message: { content } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-cursor-')); roots.push(root);
  const options = { home: join(root, 'jevellan'), userHome: join(root, 'user'), deviceId: 'device', deviceName: 'Device', projectPaths: [] as string[] };
  mkdirSync(options.userHome); const directory = join(options.userHome, '.cursor', 'projects', 'fixture', 'agent-transcripts');
  function file(id: string, content: string, age = 1000) {
    const path = join(directory, id, `${id}.jsonl`); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    const time = new Date(Date.now() - age); utimesSync(path, time, time); return path;
  }
  return { options, file };
}
test('markdown, code and tables remain intact while tool results join their calls', () => {
  const markdown = '## Result\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst ok = true;\n```';
  const parsed = parseCursorTranscript(jsonl(message('user', [{ type: 'text', text: '<user_query>Help</user_query>' }]),
    message('assistant', [{ type: 'text', text: markdown }, { type: 'tool_use', id: 'tool-fixture', name: 'Shell', input: { command: 'pwd' } }]),
    message('user', [{ type: 'tool_result', tool_use_id: 'tool-fixture', content: 'fixture output' }])), 'jsonl');
  expect(parsed.turns).toHaveLength(2);
  expect(parsed.turns[0]!.blocks[0]).toEqual({ type: 'text', text: 'Help' });
  expect(parsed.turns[1]!.blocks).toEqual([{ type: 'text', text: markdown }, { type: 'tool', id: 'tool-fixture', name: 'Shell', input: '{\n  "command": "pwd"\n}', output: 'fixture output', state: 'completed' }]);
});
test.each(['success', 'failed', 'cancelled'])('explicit %s completion ends activity until another message arrives', status => {
  const finished = jsonl(message('assistant', 'Done'), { type: 'turn_ended', status });
  expect(parseCursorTranscript(finished, 'jsonl')).toMatchObject({ completed: true, active: false });
  expect(parseCursorTranscript(finished + jsonl(message('user', 'Continue')), 'jsonl')).toMatchObject({ completed: false, active: true });
});
test('legacy role headings become separate turns, preserving formatting', () => {
  const result = parseCursorTranscript('user:\nHello\n\nassistant:\n## Answer\n\n- one\n- two', 'text');
  expect(result.turns.map(turn => turn.role)).toEqual(['user', 'assistant']);
  expect(result.turns[1]!.blocks[0]).toEqual({ type: 'text', text: '## Answer\n\n- one\n- two' });
});
test('Cursor timestamp and context envelopes do not become conversation titles or messages', () => {
  const { options, file } = fixture();
  file('desktop-fixture', jsonl(message('user', '<timestamp>Monday morning</timestamp>\n<user_info>machine context</user_info>\n<user_query>Fix the table\n\n- Keep sorting</user_query>'), message('user', '<timestamp>Later</timestamp>')));
  const session = cursorList(options).sessions[0]!;
  expect(session.title).toBe('Fix the table - Keep sorting');
  expect(cursorTranscript(options, session.id).turns).toHaveLength(1);
  expect(cursorTranscript(options, session.id).turns[0]!.blocks[0]).toEqual({ type: 'text', text: 'Fix the table\n\n- Keep sorting' });
});
test('journal tool calls without saved results are not asserted to be running', () => {
  const parsed = parseCursorTranscript(jsonl(message('assistant', [{ type: 'tool_use', name: 'Read', input: { path: 'fixture.ts' } }]), message('assistant', 'Finished reading')), 'jsonl');
  expect(parsed.turns[0]!.blocks[0]).toMatchObject({ type: 'tool', state: 'unknown', input: '{\n  "path": "fixture.ts"\n}' });
});
test('hook results and thoughts are visible before the saved journal updates, with generation isolation', () => {
  const { options, file } = fixture(); const id = cursorSessionId('desktop-fixture');
  const native = file('desktop-fixture', jsonl(message('user', 'Work'))); const before = readFileSync(native);
  const payload = { conversation_id: 'desktop-fixture', generation_id: 'turn-a', hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: 'tool-fixture', tool_input: { command: 'pwd' }, tool_output: '{"stdout":"fixture output","exitCode":0}' };
  recordCursorActivity(options.home, id, 'turn-a', payload);
  recordCursorActivity(options.home, id, 'turn-a', payload);
  const live = cursorTranscript(options, id);
  expect(live.activity).toHaveLength(1);
  expect(live.activity[0]!.blocks[0]).toMatchObject({ name: 'Shell', output: '{\n  "stdout": "fixture output",\n  "exitCode": 0\n}', state: 'completed' });
  recordCursorActivity(options.home, id, 'turn-a', { ...payload, hook_event_name: 'afterAgentThought', text: 'Checking the result' });
  expect(cursorTranscript(options, id).activity[1]!.blocks[0]).toEqual({ type: 'thinking', text: 'Checking the result' });
  recordCursorActivity(options.home, id, 'turn-b', { ...payload, hook_event_name: 'beforeSubmitPrompt' });
  expect(cursorTranscript(options, id).activity).toEqual([]);
  expect(readFileSync(native)).toEqual(before);
});
test('only recent desktop sessions are listed and native journals remain unchanged', () => {
  const { options, file } = fixture();
  const native = file('desktop-fixture', jsonl(message('user', 'Recent request'), { type: 'turn_ended' })); const before = readFileSync(native);
  file('old-fixture', jsonl(message('user', 'Old request')), 6 * 86_400_000);
  file('cli-fixture', jsonl(message('user', 'CLI request')));
  mkdirSync(join(options.userHome, '.cursor', 'chats', 'workspace', 'cli-fixture'), { recursive: true });
  const list = cursorList(options);
  expect(list.sessions).toHaveLength(1); expect(list.sessions[0]).toMatchObject({ title: 'Recent request', state: 'idle', canSend: false });
  expect(cursorTranscript(options, list.sessions[0]!.id).turns[0]!.role).toBe('user');
  expect(readFileSync(native)).toEqual(before);
});
test('newer explicit completion outranks an older start hook', () => {
  const { options, file } = fixture(); const id = cursorSessionId('desktop-fixture');
  file('desktop-fixture', jsonl(message('assistant', 'Finished'), { type: 'turn_ended', status: 'success' }));
  saveCursorHookState(options.home, { schema: 'cursor-hook-state-v1', id, nativeId: 'desktop-fixture', generation: 'fixture-turn', cwd: null, title: 'Fixture', state: 'working', at: new Date(Date.now() - 10_000).toISOString(), hold: null });
  expect(cursorList(options).sessions[0]).toMatchObject({ state: 'idle', canSteer: false, canSend: false });
});
test('queue retries preserve one message and refuse conflicting text or unsupported delivery', () => {
  const { options, file } = fixture(); const id = cursorSessionId('desktop-fixture');
  file('desktop-fixture', jsonl(message('user', 'Work')));
  const input = { schema: 'cursor-message-input-v1', clientMessageId: 'message_fixture', mode: 'steer', text: 'Use the existing function' };
  expect(() => queueCursorMessage(options, id, input)).toThrow('cannot receive steering');
  saveCursorHookState(options.home, { schema: 'cursor-hook-state-v1', id, nativeId: 'desktop-fixture', generation: 'fixture-turn', cwd: null, title: 'Fixture', state: 'working', at: new Date().toISOString(), hold: null });
  const first = queueCursorMessage(options, id, input);
  expect(queueCursorMessage(options, id, input)).toEqual(first);
  expect(() => queueCursorMessage(options, id, { ...input, text: 'Different' })).toThrow('different text');
});
test('bundled observer exits successfully with only its requested session response', () => {
  const { options, file } = fixture();
  file('desktop-fixture', jsonl(message('user', 'Recent request'), { type: 'turn_ended' }));
  const helper = new URL('../packages/mesh/dist/standalone/cursor-stdio.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(helper)], {
    input: JSON.stringify({ ...options, schema: 'cursor-request-v1', operation: 'list' }), encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'cursor-list-v1', sessions: [{ title: 'Recent request' }], unavailable: [] });
});
test('standalone installation and repeated installation preserve existing command and prompt hooks', () => {
  const { options } = fixture();
  mkdirSync(join(options.userHome, '.cursor'), { recursive: true });
  const path = join(options.userHome, '.cursor', 'hooks.json');
  const existing = [{ command: 'existing-hook' }, { type: 'prompt', prompt: 'Existing user instruction' }];
  writeFileSync(path, JSON.stringify({ version: 1, hooks: { stop: existing } }));
  const installer = fileURLToPath(new URL('../packages/mesh/dist/standalone/cursor-install.mjs', import.meta.url));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, [installer, '--standalone'], {
      env: { ...process.env, JEVELLAN_HOME: options.home, JEVELLAN_CURSOR_USER_HOME: options.userHome }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const hooks = JSON.parse(readFileSync(path, 'utf8')).hooks;
    expect(hooks.stop).toHaveLength(3);
    expect(hooks.stop.slice(0, 2)).toEqual(existing);
    expect(Object.values(hooks).flat()).toHaveLength(9);
  }
});

test('Windows Cursor paths are explicit host paths, never mistaken for tunnel paths', async () => {
  const { CursorConnectionSchema, CursorHostPathSchema } = await import('../packages/core/dist/cursor.js');
  const { cursorDatabasePath } = await import('../packages/mesh/dist/cursor-reader.js');
  expect(CursorHostPathSchema.parse('C:/Users/fixture/.jevellan')).toBe('C:/Users/fixture/.jevellan');
  expect(CursorHostPathSchema.safeParse('relative/home').success).toBe(false);
  expect(cursorDatabasePath('/fixture/user', 'win32')).toBe('/fixture/user/AppData/Roaming/Cursor/User/globalStorage/state.vscdb');
  expect(CursorConnectionSchema.parse({ id: 'cursor_remote_fixture', name: 'Fixture Windows', port: 2222, user: 'fixture', nodePath: '/mnt/c/reader/node.exe', helperPath: 'C:/Users/fixture/.jevellan/cursor-stdio.mjs', home: 'C:/Users/fixture/.jevellan' }).helperPath).toMatch(/^C:/);
});

test('desktop checkpoint activity keeps an older conversation discoverable and completed state idle', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { cursorDatabasePath } = await import('../packages/mesh/dist/cursor-reader.js');
  const { options } = fixture();
  const path = cursorDatabasePath(options.userHome); mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  const now = Date.now() - 1000;
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:checkpoint-fixture', JSON.stringify({ name: 'Existing desktop work', createdAt: now - 10 * 86_400_000, lastUpdatedAt: now - 6 * 86_400_000, conversationCheckpointLastUpdatedAt: now, status: 'generating' }));
  expect(cursorList(options).sessions[0]).toMatchObject({ title: 'Existing desktop work', state: 'working', lastActivityAt: new Date(now).toISOString() });
  db.prepare('UPDATE cursorDiskKV SET value = json_set(value, ?, ?)').run('$.status', 'completed');
  expect(cursorList(options).sessions[0]).toMatchObject({ state: 'idle' });
  db.close();
});

test('lagging journals and desktop stream aborts do not hide newer hook activity', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { cursorDatabasePath } = await import('../packages/mesh/dist/cursor-reader.js');
  const { options, file } = fixture(); const nativeId = 'desktop-fixture'; const id = cursorSessionId(nativeId);
  file(nativeId, jsonl(message('assistant', 'Earlier finish'), { type: 'turn_ended' }), 20_000);
  const path = cursorDatabasePath(options.userHome); mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path); db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`composerData:${nativeId}`, JSON.stringify({ name: 'Desktop work', createdAt: Date.now() - 86_400_000, conversationCheckpointLastUpdatedAt: Date.now() - 1000, status: 'aborted' }));
  saveCursorHookState(options.home, { schema: 'cursor-hook-state-v1', id, nativeId, generation: 'fixture-turn', cwd: null, title: 'Desktop work', state: 'working', at: new Date(Date.now() - 2000).toISOString(), hold: null });
  expect(cursorList(options).sessions[0]).toMatchObject({ title: 'Desktop work', state: 'working', canSteer: true });
  db.close();
});

test('desktop waiting subagents keep the spinner and their saved tool details', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { cursorDatabasePath } = await import('../packages/mesh/dist/cursor-reader.js');
  const { options, file } = fixture(); const nativeId = 'desktop-fixture';
  file(nativeId, jsonl(message('assistant', 'Export without results'), { type: 'turn_ended' }), 100);
  const path = cursorDatabasePath(options.userHome); mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path); db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  insert.run(`composerData:${nativeId}`, JSON.stringify({ name: 'Parent work', createdAt: Date.now() - 1000, status: 'aborted', fullConversationHeadersOnly: [{ bubbleId: 'tool-a' }, { bubbleId: 'tool-b' }] }));
  insert.run(`bubbleId:${nativeId}:tool-a`, JSON.stringify({ bubbleId: 'tool-a', type: 2, toolFormerData: { name: 'read_file', toolCallId: 'a', status: 'completed', params: { path: 'fixture.ts' }, result: { content: 'file contents' } } }));
  insert.run(`bubbleId:${nativeId}:tool-b`, JSON.stringify({ bubbleId: 'tool-b', type: 2, toolFormerData: { name: 'task_v2', toolCallId: 'b', status: 'loading', rawArgs: '{"task":"Inspect logs"}' } }));
  const session = cursorList(options).sessions[0]!; expect(session.state).toBe('working');
  const transcript = cursorTranscript(options, session.id);
  expect(transcript.turns[0]!.blocks[0]).toMatchObject({ type: 'tool', name: 'read_file', input: '{\n  "path": "fixture.ts"\n}', output: '{\n  "content": "file contents"\n}', state: 'completed' });
  expect(transcript.turns[1]!.blocks[0]).toMatchObject({ type: 'tool', name: 'task_v2', input: '{\n  "task": "Inspect logs"\n}', state: 'running' });
  db.prepare('UPDATE cursorDiskKV SET value=json_set(value, ?, ?) WHERE key=?').run('$.status', 'completed', `composerData:${nativeId}`);
  expect(cursorList(options).sessions[0]!.state).toBe('idle');
  db.close();
});


test('the tunnel reader replies to a complete JSON line without waiting for stdin closure', async () => {
  const { options, file } = fixture(); file('desktop-fixture', jsonl(message('user', 'Recent request')));
  const helper = fileURLToPath(new URL('../packages/mesh/dist/standalone/cursor-stdio.mjs', import.meta.url));
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Reader waited for stdin closure.')); }, 3000);
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`Reader exited ${code}`)); });
    child.stdin.write(JSON.stringify({ ...options, schema: 'cursor-request-v1', operation: 'list' }) + '\n');
  });
  expect(JSON.parse(result)).toMatchObject({ schema: 'cursor-list-v1', sessions: [{ title: 'Recent request' }] });
});
