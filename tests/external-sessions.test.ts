import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Homes, ProjectSchema, type Project } from '../packages/core/dist/index.js';
import { ExternalSessionSensor, readCursorMetadata, type SessionSensorOptions } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let project: Project; let now: number;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-sensor-'))); now = Math.floor(Date.now() / 1000) * 1000; mkdirSync(join(root, 'user')); mkdirSync(join(root, 'project'));
  homes = new Homes(join(root, 'jevellan'), join(root, 'user')); homes.ensure();
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Project', paths: { here: join(root, 'project') }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function sensor(options: Partial<SessionSensorOptions> = {}) { return new ExternalSessionSensor({ homes, now: () => now, cursorDatabase: null, ...options }); }
function file(path: string, contents: string, at = now - 1000) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); utimesSync(path, new Date(at), new Date(at)); return path; }
function json(path: string, value: unknown, at?: number) { return file(path, JSON.stringify(value), at); }
function codex(home: string, id: string, cwd = project.paths.here!, at = now - 1000, extra = {}) {
  return file(join(home, 'sessions', '2025', '01', '01', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd, ...extra } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'PRIVATE BODY' } }) + '\n', at);
}
test('recent activity in old Codex creation directories is mapped by real path, deduplicated and stripped to metadata', async () => {
  const native = join(homes.userHome, '.codex'); const extra = join(root, 'other-codex'); mkdirSync(join(root, 'project', 'src')); symlinkSync(join(root, 'project'), join(root, 'alias'));
  codex(native, 'native-identifier', join(root, 'alias', 'src'));
  codex(extra, 'native-identifier', project.paths.here, now - 2000);
  codex(native, 'child', project.paths.here, now - 1000, { thread_source: 'subagent' });
  codex(native, 'other-child', project.paths.here, now - 1000, { source: { subagent: { parent: 'parent' } } });
  codex(native, 'old', project.paths.here, now - 6 * 86400000);
  codex(native, 'future', project.paths.here, now + 10000);
  const snapshot = await sensor({ roots: { codex: [native, extra, native] } }).read([project], 'here');
  expect(snapshot.unavailable).toEqual([]); expect(snapshot.sessions).toEqual([{ runtime: 'codex', cwd: join(root, 'project', 'src'), projectId: 'project', lastActivityAt: new Date(now - 1000).toISOString(), source: 'codex-journal' }]);
  expect(JSON.stringify(snapshot)).not.toMatch(/native-identifier|PRIVATE BODY|rollout|session_meta/);
});
test('Codex identity comes from the first record, never a replayed parent or a later parseable record', async () => {
  const native = join(homes.userHome, '.codex');
  const valid = JSON.stringify({ type: 'session_meta', payload: { id: 'parent', cwd: project.paths.here } });
  file(join(native, 'sessions', 'rollout-parent.jsonl'), JSON.stringify({ type: 'event_msg' }) + '\n' + valid + '\n');
  file(join(native, 'sessions', 'rollout-partial.jsonl'), '{partial\n' + valid + '\n');
  expect((await sensor().read([project], 'here')).sessions).toEqual([]);
});
test('Jevellan homes and their aliases are excluded without hiding an unrelated agent in the same project', async () => {
  const owned = homes.ensure('homes', 'codex', 'fixture'); codex(owned, 'owned');
  symlinkSync(owned, join(root, 'owned-alias')); codex(join(homes.userHome, '.codex'), 'independent');
  const snapshot = await sensor({ roots: { codex: [owned, join(root, 'owned-alias'), join(homes.userHome, '.codex')] } }).read([project], 'here');
  expect(snapshot.sessions).toHaveLength(1); expect(snapshot.sessions[0]).toMatchObject({ runtime: 'codex', projectId: 'project' });
});
test('Claude journals need no live registry and more than three hundred recent journals stay visible', async () => {
  const directory = join(homes.userHome, '.claude', 'projects', '-fixture');
  for (let i = 0; i < 305; i++) file(join(directory, `${i}.jsonl`), JSON.stringify({ type: 'user', cwd: project.paths.here, message: { content: 'PRIVATE BODY' } }) + '\n');
  const before = readFileSync(join(directory, '0.jsonl'));
  const snapshot = await sensor().read([project], 'here'); expect(snapshot.sessions).toHaveLength(305);
  expect(snapshot.sessions.every(row => row.source === 'claude-journal' && row.projectId === project.id)).toBe(true);
  expect(readFileSync(join(directory, '0.jsonl'))).toEqual(before); expect(JSON.stringify(snapshot)).not.toContain('PRIVATE BODY');
});
test('Claude registry discovery rejects mismatched filenames, pre-boot entries and reused processes', async () => {
  const directory = join(homes.userHome, '.claude', 'sessions'); const base = { pid: process.pid, cwd: project.paths.here, startedAt: now - 1000, updatedAt: now - 500 };
  json(join(directory, `${process.pid}.json`), { ...base, sessionId: 'valid' });
  json(join(directory, `${process.pid + 1}.json`), { ...base, sessionId: 'mismatch' });
  json(join(directory, 'pre-boot.json'), { ...base, sessionId: 'boot', startedAt: 1 });
  json(join(directory, 'reused.json'), { ...base, sessionId: 'reused', startedAt: now - 60000 });
  const snapshot = await sensor({ processStarts: async () => new Map([[process.pid, now - 1000]]) }).read([project], 'here');
  expect(snapshot.sessions).toEqual([{ runtime: 'claude', cwd: project.paths.here, projectId: project.id, lastActivityAt: new Date(now - 500).toISOString(), source: 'claude-registry' }]);
});
test('Cursor uses proven cwd metadata for CLI and flat journals, without guessing from a lossy slug', async () => {
  const native = join(homes.userHome, '.cursor');
  json(join(native, 'chats', 'workspace', 'cli', 'meta.json'), { cwd: project.paths.here, createdAtMs: now - 3000, updatedAtMs: now - 2000, title: 'PRIVATE TITLE' });
  file(join(native, 'projects', '-fixture', 'agent-transcripts', 'cli.txt'), 'PRIVATE BODY\n');
  file(join(native, 'projects', '-fixture', 'agent-transcripts', 'unknown.txt'), 'PRIVATE BODY\n');
  json(join(native, 'chats', 'workspace', 'metadata-only', 'meta.json'), { cwd: join(root, 'elsewhere'), updatedAtMs: now - 1500 });
  const snapshot = await sensor().read([project], 'here');
  expect(snapshot.sessions).toHaveLength(2); expect(snapshot.sessions.find(row => row.projectId)).toMatchObject({ source: 'cursor-journal', lastActivityAt: new Date(now - 1000).toISOString() });
  expect(snapshot.sessions.find(row => row.cwd.endsWith('elsewhere'))).not.toHaveProperty('projectId'); expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|metadata-only|cli\.txt/);
});
function cursorDatabase() {
  const path = join(root, 'cursor.sqlite'); const database = new DatabaseSync(path);
  database.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  database.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:native-cursor-id', JSON.stringify({ cwd: project.paths.here, lastUpdatedAt: now - 1000, name: 'PRIVATE TITLE', messages: ['PRIVATE BODY'] })); database.close(); return path;
}
test('Cursor desktop reads select metadata through a read-only worker without changing the database', async () => {
  const path = cursorDatabase(); const before = readFileSync(path);
  const snapshot = await sensor({ cursorDatabase: path }).read([project], 'here');
  expect(snapshot.unavailable).toEqual([]); expect(snapshot.sessions).toEqual([{ runtime: 'cursor', cwd: project.paths.here, projectId: project.id, lastActivityAt: new Date(now - 1000).toISOString(), source: 'cursor-desktop' }]);
  expect(readFileSync(path)).toEqual(before); expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|native-cursor-id/);
});
test('a failed Cursor refresh retains original activity, expires it by age and recovers an empty result', async () => {
  const path = cursorDatabase(); let fail = false;
  const observed = sensor({ cursorDatabase: path, readCursor: async value => { if (fail) throw new Error('Fixture read unavailable'); return readCursorMetadata(value); } });
  const first = await observed.read([project], 'here'); fail = true; now += 6000;
  const stale = await observed.read([project], 'here'); expect(stale.sessions).toEqual(first.sessions); expect(stale.unavailable).toEqual(['cursor']);
  now += 6 * 86400000; expect((await observed.read([project], 'here')).sessions).toEqual([]);
  fail = false; const db = new DatabaseSync(path); db.exec('DELETE FROM cursorDiskKV'); db.close();
  expect(await observed.read([project], 'here')).toMatchObject({ sessions: [], unavailable: [] });
});
test('a removed Cursor metadata source clears its old snapshot after a successful absence check', async () => {
  const path = cursorDatabase(); const observed = sensor({ cursorDatabase: path }); expect((await observed.read([project], 'here')).sessions).toHaveLength(1);
  rmSync(path); expect(await observed.read([project], 'here')).toMatchObject({ sessions: [], unavailable: [] });
});
test('Gemini reads mapped headers without retaining prompts or following an escaping project mapping', async () => {
  const native = join(homes.userHome, '.gemini'); json(join(native, 'projects.json'), { projects: { [project.paths.here!]: 'project', '/unrelated': '../../outside' } });
  file(join(native, 'tmp', 'project', 'chats', 'session-fixture.jsonl'), JSON.stringify({ sessionId: 'native-gemini-id', lastUpdated: new Date(now - 2000).toISOString() }) + '\n' + JSON.stringify({ $set: { messages: ['PRIVATE BODY'] } }));
  const snapshot = await sensor().read([project], 'here'); expect(snapshot.sessions).toEqual([{ runtime: 'gemini', cwd: project.paths.here, projectId: project.id, lastActivityAt: new Date(now - 1000).toISOString(), source: 'gemini-journal' }]);
  expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|native-gemini-id/);
});
test('an exhausted discovery budget is explicit and preserves previous timestamps without fabricating freshness', async () => {
  const options: SessionSensorOptions = { homes, now: () => now, cursorDatabase: null, scanLimit: 100 };
  codex(join(homes.userHome, '.codex'), 'first'); const observed = new ExternalSessionSensor(options); const first = await observed.read([project], 'here');
  options.scanLimit = 1; now += 6000; const second = await observed.read([project], 'here');
  expect(second.sessions).toEqual(first.sessions); expect(second.unavailable).toContain('codex');
});
