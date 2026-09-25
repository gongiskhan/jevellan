import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalSessionsSchema, ProjectSchema, type Heartbeat } from '../packages/core/dist/index.js';
import { DevicePresence, HEARTBEAT_INTERVAL_MS, parseProjectGitStatus, type DevicePresenceOptions } from '../packages/mesh/dist/index.js';

let root: string; const pumps: DevicePresence[] = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-presence-'))); });
afterEach(async () => { await Promise.all(pumps.splice(0).map(pump => pump.close())); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function create(options: Partial<DevicePresenceOptions> = {}) {
  const sent: Heartbeat[] = [];
  const pump = new DevicePresence({ deviceId: 'here', version: '0.1.0', projects: async () => [], running: () => [],
    sensor: { read: async () => ExternalSessionsSchema.parse({ schema: 'external-sessions-v1', at: new Date().toISOString(), sessions: [], unavailable: [] }) },
    report: heartbeat => { sent.push(heartbeat); }, timers: false, ...options }); pumps.push(pump); return { pump, sent };
}
test('porcelain status preserves branch, complete head, changed files and locally known upstream counts', () => {
  const head = 'a'.repeat(40);
  expect(parseProjectGitStatus(`# branch.oid ${head}\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -1\n1 .M N... file\n? new\n`)).toEqual({ branch: 'main', head, ahead: 3, behind: 1, dirty: true });
  expect(parseProjectGitStatus(`# branch.oid ${head}\n# branch.head (detached)\n`)).toEqual({ branch: '(detached)', head, ahead: 0, behind: 0, dirty: false });
  expect(parseProjectGitStatus('# branch.oid (initial)\n# branch.head main\n')).toEqual({ branch: 'main', head: '(initial)', ahead: 0, behind: 0, dirty: false });
  expect(parseProjectGitStatus('not a git status')).toBeNull();
});
test('a heartbeat includes real checkout state without fetching, running ids and only sensor metadata', async () => {
  const path = join(root, 'checkout'); mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-b', 'main'); writeFileSync(join(path, 'value.txt'), '1\n'); git('add', '-A'); git('commit', '-m', 'Seed');
  const head = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', head); git('config', 'branch.main.remote', 'origin'); git('config', 'branch.main.merge', 'refs/heads/main'); git('remote', 'add', 'origin', join(root, 'absent-remote'));
  writeFileSync(join(path, 'value.txt'), '2\n'); git('add', '-A'); git('commit', '-m', 'Local checkpoint'); writeFileSync(join(path, 'untracked.txt'), '3\n');
  const index = readFileSync(join(path, '.git', 'index')); const origin = git('rev-parse', 'refs/remotes/origin/main');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Project', paths: { here: path }, branchPolicy: 'main', allowedDevices: ['elsewhere'], memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  const session = { runtime: 'claude', cwd: path, projectId: project.id, lastActivityAt: new Date().toISOString(), source: 'claude-journal' };
  const { pump, sent } = create({ projects: async () => [project, { ...project, id: 'missing', paths: { here: join(root, 'missing') } }], running: () => ['owned_work'],
    sensor: { read: async () => ExternalSessionsSchema.parse({ schema: 'external-sessions-v1', at: new Date().toISOString(), sessions: [session], unavailable: [] }) } });
  await pump.pulse(); expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ deviceId: 'here', runningConversations: ['owned_work'], projects: [{ projectId: project.id, path, branch: 'main', head: git('rev-parse', 'HEAD'), ahead: 1, behind: 0, dirty: true }], externalSessions: [session] });
  expect(readFileSync(join(path, '.git', 'index'))).toEqual(index); expect(git('rev-parse', 'refs/remotes/origin/main')).toBe(origin);
  expect(sent[0]!.load.cpuPct).toBeGreaterThanOrEqual(0); expect(sent[0]!.load.cpuPct).toBeLessThanOrEqual(100);
});
test('the pump reports immediately and every thirty seconds, then stops on close', async () => {
  vi.useFakeTimers(); const { pump, sent } = create({ timers: true }); await pump.pulse(); expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1); expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(sent).toHaveLength(2);
  await pump.close(); await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); expect(sent).toHaveLength(2); expect(await pump.pulse()).toBeNull();
});
test('failed heartbeat delivery is contained and a later pulse reports current activity', async () => {
  let offline = true; let running = ['work']; const reported: Heartbeat[] = [];
  const { pump } = create({ running: () => running, report: heartbeat => { if (offline) throw new Error('Fixture outage'); reported.push(heartbeat); } });
  expect(await pump.pulse()).toBeNull(); expect(pump.unavailable).toBe(true); expect(running).toEqual(['work']);
  offline = false; running = []; expect(await pump.pulse()).toMatchObject({ runningConversations: [] }); expect(pump.unavailable).toBe(false); expect(reported).toHaveLength(1);
});
test('pending pulses coalesce and shutdown prevents a late report after discovery', async () => {
  const gate = deferred(); const { pump, sent } = create({ projects: async () => { await gate.promise; return []; } });
  const first = pump.pulse(); expect(pump.pulse()).toBe(first);
  const close = pump.close(); gate.resolve(); await close; expect(await first).toBeNull(); expect(sent).toEqual([]);
});
test('recovery readiness must settle before the first presence report', async () => {
  const ready = deferred(); const { pump, sent } = create({ ready: ready.promise }); const pending = pump.pulse(); await Promise.resolve(); expect(sent).toEqual([]);
  ready.resolve(); await pending; expect(sent).toHaveLength(1);
});
