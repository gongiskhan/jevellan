import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProjectWorkSettings, Homes, JournalThreadSchema, MemoryDreamReportSchema, MergeRouteSchema, PlacementRecordSchema, ProjectJobRunSchema, ProjectSchema, ProjectWindowSchema, ProjectWorkTaskSchema, ThreadIndexSchema, ThreadSchema, VerificationRunSchema, type ProjectJournalRecord } from '../packages/core/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import { ProjectJournals, ProjectLedgers, ProjectPaths, coordinatorJournalDigest, journalIndex, journalRecordKey, renderProjectJournal, threadJournalExcerpt, threadJournalFile } from '../packages/projects/dist/index.js';
import { fileWriteDenial, safetyDenial } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

const at = '2026-10-14T10:00:00.000Z';
const header = JournalThreadSchema.parse({ schema: 'journal-thread-v1', id: 'thread_a', projectId: 'project', title: 'Export invoices', task: 'Keep the full task brief.\nInclude VAT.', taskId: 'task_a', goal: 'Correct invoices', type: 'feature', runtime: 'codex', model: 'model', effort: 'high', deviceId: 'hub', isolation: 'worktree', branch: 'jv/export', pr: null, state: 'idle', createdAt: at, endedAt: null });
function record(id: number, type: string, data: unknown, ledgerId = 'thread_a', time = at): ProjectJournalRecord {
  return { schema: 'project-journal-record-v1', deviceId: 'hub', ledgerId, event: { schema: 'project-ledger-event-v1', id, t: time, type, data } };
}
let root: string, homes: Homes, database: HubDatabase, now: number;
let fixture: ProjectFixture | undefined;
const engines: ProjectJournals[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-journal-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'hub'), join(root, 'user')); homes.ensure();
  database = new HubDatabase(homes, 'hub'); now = Date.parse(at);
});
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.close())); await fixture?.close(); fixture = undefined; database.close(); rmSync(root, { recursive: true, force: true }); });

test('thread and day rendering is deterministic, anchored, complete and grows when late metadata arrives', () => {
  const message = 'Keep all of this owner message.\n' + 'VAT details. '.repeat(1000);
  const before = [record(1, 'coordinator-event', { schema: 'coordinator-event-v1', kind: 'thread-user-message', id: 'cev_owner', at, threadId: header.id, text: message }, 'coordinator')];
  const initial = renderProjectJournal({ name: 'Shop', timezone: 'Europe/Lisbon', records: before, open: [], updatedAt: at });
  const records = [...before, record(2, 'journal-thread', header), record(3, 'thread-report', { schema: 'thread-report-v1', turn: 1, status: 'needs-decision', summary: 'Choose the page size.', changedFiles: ['page.ts'], question: '10, 25 or 50?', options: [{ label: '10' }, { label: '25' }, { label: '50' }], synthesized: false }),
    record(4, 'journal-message', { schema: 'journal-message-v1', id: 'message_answer', from: 'owner', text: '25', at, interrupt: false })];
  const result = renderProjectJournal({ name: 'Shop', timezone: 'Europe/Lisbon', records, open: [], updatedAt: at });
  expect(result).toEqual(renderProjectJournal({ name: 'Shop', timezone: 'Europe/Lisbon', records, open: [], updatedAt: at }));
  const text = result.files[threadJournalFile(header)]!;
  expect(text).toContain(header.task); expect(text).toContain(message); expect(text).toContain('10, 25 or 50?'); expect(text).toContain('"text": "25"');
  for (const entry of records) expect(result.files['days/2026-10-14.md']).toContain(`<a id="e-${journalRecordKey(entry)}"></a>`);
  expect(result.files['days/2026-10-14.md']!.startsWith(initial.files['days/2026-10-14.md']!)).toBe(true);
});

test('INDEX folds old weeks then oldest thread lines before whole days without removing open state', () => {
  const open = ['- Thread "Active work" → threads/active.md', '- Question 1: [Active work] Choose? → threads/active.md#e-1'];
  const days = Array.from({ length: 30 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, ownerMessages: 1, questions: 1,
    ended: Array.from({ length: 20 }, (_, n) => ({ thread: { ...header, id: `thread_${index}_${n}`, title: `Finished ${index} ${n} ${'long title '.repeat(5)}`, state: 'done', pr: n + 1 }, outcome: 'merged' })) }));
  const input = { name: 'Shop', updatedAt: '2026-09-30T23:00:00Z', timezone: 'UTC', open, days };
  const text = journalIndex(input, 6000); expect(text.length).toBeLessThanOrEqual(6000);
  for (const entry of open) expect(text).toContain(entry);
  expect(text).toContain('Week 2026-W'); expect(text).toContain('- 2026-09-24:'); expect(text).toContain('- 2026-09-30:');
  expect(text).not.toContain('"Finished 23 0'); expect(text).toContain('"Finished 29 0');
  expect(journalIndex(input)).toBe(journalIndex(input));
  expect(() => journalIndex({ ...input, open: ['x'.repeat(12001)] })).toThrow('Open now');
});

test('night files contain exact job commits and links, review, fix route, verification and dream reports', () => {
  const commit = 'a'.repeat(40), windowId = 'window_night';
  const window = ProjectWindowSchema.parse({ schema: 'project-window-v1', id: windowId, projectId: 'project', revision: 1, date: '2026-10-14', closingProjectDay: '2026-10-13', state: 'finished', mergesHeld: false, openedAt: at, finishedAt: at, taskIds: ['task_review'], plans: [], outcome: 'Reviewed all changes; fixed one issue; suite and deploy passed.', failed: false });
  const review = ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id: 'task_review', projectId: 'project', revision: 1, title: 'Review since last', brief: 'Read the complete committed range.', kind: 'session', type: 'review', goalId: null, source: 'daily', state: 'done', rank: '8', ownerRanked: false, now: false, after: [], needs: [], dailyId: 'daily_review', jobId: null, threadId: null, jobRunId: null, fixed: {}, createdAt: at, updatedAt: at, nightlyWindowId: windowId,
    reviewRun: { schema: 'project-review-run-v1', sequence: 1, state: 'completed', commit, fromCommit: 'b'.repeat(40), deviceId: 'hub', runtime: 'claude', modelId: 'model', model: 'model', modelLabel: 'Model', majorityProvider: 'codex', selectionBasis: 'Other provider.', startedAt: at, completedAt: at, followupChosen: true, fixTaskId: 'task_fix', report: { schema: 'project-review-report-v1', projectId: 'project', taskId: 'task_review', fromCommit: 'b'.repeat(40), commit, reviewedAt: at, runtime: 'claude', model: 'model', summary: 'One combined regression finding.', findings: [{ what: 'Fix invoice rounding.', detail: 'One cent is lost.', files: ['invoice.ts'] }] } } });
  const job = ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id: 'run_suite', projectId: 'project', revision: 1, jobId: 'job_suite', taskId: 'task_suite', commit, deviceId: 'hub', projectDay: '2026-10-13', startedAt: at, endedAt: at, conclusion: 'passed', summary: 'Suite passed on the fix.', logTail: 'All tests passed.', url: 'https://github.com/example/shop/actions/runs/42', phase: 'finished', spec: { kind: 'github-workflow', workflow: 'suite.yml', mode: 'dispatch', timeoutMinutes: 30, commitInput: 'sha' }, baseBranch: 'main', watchAfter: at, nightlyWindowId: windowId });
  const route = MergeRouteSchema.parse({ schema: 'merge-route-v1', id: 'route_fix', projectId: 'project', revision: 1, deviceId: 'hub', threadId: header.id, commit, at, prNumber: 42, questionSet: 'm-v1', route: 'merge', source: 'jev', reason: 'Covered low-risk fix.', packet: { schema: 'merge-route-state-v1', title: 'Fix invoice rounding', task: { type: 'fix', goal: null, needs: [] }, summary: 'Fixed the cent.', riskyAreas: '', files: [{ path: 'invoice.ts', additions: 2, deletions: 1 }], totalSize: 3, corrections: [] }, calls: [], state: 'merged', failures: 0, decisionId: null, verificationId: null });
  const verification = VerificationRunSchema.parse({ schema: 'verification-run-v1', id: 'verification_fix', projectId: 'project', revision: 1, deviceId: 'hub', threadId: header.id, commit, at, runtime: 'claude', modelId: 'other', model: 'other', modelLabel: 'Other provider', providerChoice: 'other-provider', state: 'passed', endedAt: at, report: { result: 'passed', commands: ['npm test'], failures: [] } });
  const dream = MemoryDreamReportSchema.parse({ schema: 'memory-dream-report-v1', projectId: 'project', dreamId: 'dream_night', at, fromCommit: commit, toCommit: 'b'.repeat(40), mainCommit: commit, counts: { inboxPromoted: 1, inboxDropped: 0, merged: 0, corrected: 1, archived: 0, created: 0 }, briefUpdated: true, summary: 'Consolidated the invoice gotcha.', changes: [{ note: 'Invoices', action: 'updated', reason: 'Use the corrected rounding.' }] });
  const records = [record(1, 'journal-thread', header), ...[
    ['window', window.id, window], ['task', review.id, review], ['job', job.id, job], ['merge', route.id, route], ['merge', verification.id, verification], ['dream', dream.dreamId, dream],
  ].map(([collection, key, document], index) => record(index + 2, 'journal-document', { schema: 'journal-document-v1', collection, key, document, nightlyWindowId: windowId }, 'coordinator'))];
  const result = renderProjectJournal({ name: 'Shop', timezone: 'UTC', records, open: [], updatedAt: at }), night = result.files['nights/2026-10-14.md']!;
  for (const text of [commit, job.url!, review.reviewRun!.report!.summary, 'task_fix', route.reason!, '"route": "merge"', 'npm test', dream.summary, window.outcome!]) expect(night).toContain(text);
  expect(result.files[threadJournalFile(header)]).toContain(route.reason!);
});

test('digests retain notebook/questions, fold history before conversation, and keep the thread header and tail', () => {
  const notebook = 'N'.repeat(42000), question = 'Question 1: choose the database?';
  const fresh = `Project notebook:\n${notebook}\n\n${question}\n\nRecent conversation with the owner:\n${'recent '.repeat(2500)}\n\nProject memory:\nBuild with npm test.`;
  const index = '# Shop journal\n\n## Open now\n- Running invoice task\n\n## Last 7 days\n' + Array.from({ length: 60 }, (_, i) => `  - old work ${i}\n`).join('') + '\n## Earlier\n' + 'old week\n'.repeat(1000);
  const result = coordinatorJournalDigest(fresh, '/journal', index);
  expect(result.length).toBeLessThanOrEqual(60000); expect(result).toContain(notebook); expect(result).toContain(question); expect(result).toContain('Running invoice task'); expect(result).toContain('Build with npm test.');
  const text = '# Thread\nTask: task_a\n\n## Entries\n' + 'old '.repeat(8000) + 'latest answer:25';
  const excerpt = threadJournalExcerpt(text, '/journal/thread.md');
  expect(excerpt.startsWith('# Thread\nTask: task_a')).toBe(true); expect(excerpt).toContain('Earlier entries: /journal/thread.md'); expect(excerpt.endsWith('latest answer:25')).toBe(true);
  expect(threadJournalExcerpt('short', '/journal/thread.md')).toBe('short');
});

function setup() {
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Shop', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.memory' }, context: { state: 'none' } });
  database.put('projects', project.id, ProjectSchema, project, 0);
  const ledgers = new ProjectLedgers(new ProjectPaths(homes), { now: () => new Date(now).toISOString() });
  const hub = new HubProjectAccess(database, 'hub');
  const engine = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub, projects: async () => [project], threads: () => [], now: () => now }); engines.push(engine);
  return { project, ledgers, hub, engine };
}
test('a local thread records its full metadata once and subsequent reports append without replacing it', async () => {
  const { engine, ledgers } = setup();
  const placement = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fallback', fixed: [], isolation: 'worktree', runtime: header.runtime,
    modelId: 'model', model: header.model, effortRequested: 'high', effortEffective: 'high', deviceId: 'hub', accountId: 'account', eligibleModels: ['model'], excludedModels: [], eligibleDevices: ['hub'], excludedDevices: [], jevCalls: [], decidedAt: at });
  const thread = ThreadSchema.parse({ schema: 'project-thread-v1', id: header.id, projectId: 'project', title: header.title, task: header.task, createdAt: at, createdBy: 'owner', state: 'idle', isolation: 'worktree', placement, ownerDeviceId: 'hub', coordinatorDeviceId: 'hub', cwd: '/private/worktree', baseBranch: 'main', baseCommit: '', turns: 1, turnAllowance: 30, queuedMessages: [], verificationAttempts: 0, nativeSessionId: 'never-copy-native-identity' });
  const journal = new ProjectJournals({ ...engine.o, threads: () => [thread] }); engines.push(journal);
  const ledger = ledgers.thread('project', thread.id);
  ledger.append({ type: 'thread-report', data: { schema: 'thread-report-v1', turn: 1, status: 'progress', summary: 'First report.', changedFiles: [], synthesized: false } });
  await journal.sync('project'); const path = join(journal.path('project'), threadJournalFile(header)), first = readFileSync(path, 'utf8');
  expect(first).toContain(header.task); expect(first).toContain('Runtime: codex'); expect(first).not.toContain(thread.nativeSessionId!);
  now += 1000; ledger.append({ type: 'thread-report', data: { schema: 'thread-report-v1', turn: 2, status: 'progress', summary: 'Second report.', changedFiles: [], synthesized: false } });
  await journal.sync('project'); expect(readFileSync(path, 'utf8').startsWith(first)).toBe(true);
  expect(ledger.events().filter(event => event.type === 'journal-thread')).toHaveLength(1);
  thread.state = 'done'; thread.endedAt = new Date(now).toISOString();
  await journal.sync('project'); const ended = readFileSync(path, 'utf8');
  expect(ended.startsWith(first)).toBe(true); expect(ended).toContain('"state": "done"'); expect(ended).toContain('"endedAt":');
  expect(ended.split(header.task)).toHaveLength(2);
});
test('incremental journal, manifest and rebuild agree after restart, with atomic read-only files and throttled index', async () => {
  const { engine, ledgers, hub, project } = setup(), ledger = ledgers.coordinator(project.id);
  ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'First reply.' } }); await engine.sync(project.id);
  const index = readFileSync(join(engine.path(project.id), 'INDEX.md'), 'utf8');
  now += 1000; ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Second reply.' } }); await engine.sync(project.id);
  expect(readFileSync(join(engine.path(project.id), 'INDEX.md'), 'utf8')).toBe(index);
  expect(readFileSync(join(engine.path(project.id), 'days/2026-10-14.md'), 'utf8')).toContain('Second reply.');
  now += 10000; await engine.sync(project.id);
  const files = Object.fromEntries(Object.keys(engine.state(project.id).files).map(path => [path, readFileSync(join(engine.path(project.id), path), 'utf8')]));
  for (const path of Object.keys(files)) expect(statSync(join(engine.path(project.id), path)).mode & 0o222).toBe(0);
  const reopened = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers: new ProjectLedgers(new ProjectPaths(homes)), hub, projects: async () => [project], threads: () => [], now: () => now }); engines.push(reopened);
  await reopened.sync(project.id, true);
  expect(Object.fromEntries(Object.keys(files).map(path => [path, readFileSync(join(engine.path(project.id), path), 'utf8')]))).toEqual(files);
  expect(reopened.state(project.id).files).toEqual(engine.state(project.id).files);
});

test('publication is idempotent, source identities immutable, and file reads are bound to a verified manifest', async () => {
  const { engine, project } = setup(), source = record(1, 'coordinator-text', { schema: 'coordinator-text-v1', text: 'A reply.' }, 'coordinator');
  const input = { schema: 'project-journal-request-v1', operation: 'publish', projectId: project.id, records: [source] };
  expect(await engine.request(input, 'hub')).toMatchObject({ accepted: 1 }); expect(await engine.request(input, 'hub')).toMatchObject({ accepted: 0 });
  await expect(engine.request(input, 'other_device')).rejects.toMatchObject({ status: 403 });
  await expect(engine.request({ ...input, records: [{ ...source, event: { ...source.event, data: { schema: 'coordinator-text-v1', text: 'Changed identity.' } } }] }, 'hub')).rejects.toThrow('identity');
  await engine.sync(project.id); const state = engine.state(project.id), hash = state.files['INDEX.md']!;
  const result = await engine.request({ schema: 'project-journal-request-v1', operation: 'file', projectId: project.id, path: 'INDEX.md', sha256: hash, offset: 0 }, 'hub');
  expect(result.operation).toBe('file');
  await expect(engine.request({ schema: 'project-journal-request-v1', operation: 'file', projectId: project.id, path: '../secret', sha256: hash, offset: 0 }, 'hub')).rejects.toThrow();
  await expect(engine.request({ schema: 'project-journal-request-v1', operation: 'file', projectId: project.id, path: 'INDEX.md', sha256: '0'.repeat(64), offset: 0 }, 'hub')).rejects.toThrow('changed');
});

test.each(['coordinator', 'thread', 'verification', 'review', 'memory'] as const)('%s can read the journal but ordinary writes and shell mutations are refused', profile => {
  const journal = join(root, 'journal'); mkdirSync(journal); writeFileSync(join(journal, 'INDEX.md'), 'Read this.');
  const context = { cwd: root, daemonPid: process.pid, profile, readOnlyDirectories: [journal] };
  expect(readFileSync(join(journal, 'INDEX.md'), 'utf8')).toBe('Read this.');
  expect(fileWriteDenial('Write', { file_path: join(journal, 'INDEX.md') }, context)).toContain('read-only');
  expect(fileWriteDenial('apply_patch', `*** Update File: ${journal}/INDEX.md\n`, context)).toContain('read-only');
  for (const command of [`echo changed > ${journal}/INDEX.md`, `rm ${journal}/INDEX.md`, `chmod 600 ${journal}/INDEX.md`]) expect(safetyDenial(command, context)).toContain('read-only');
  expect(safetyDenial(`cat ${journal}/INDEX.md`, context)).toBeNull();
});

test('saving default settings and later calendar or name changes never rewrites earlier journal entries', async () => {
  const { project, hub, ledgers, engine } = setup(), ledger = ledgers.coordinator(project.id);
  ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Before settings exist.' } });
  await engine.sync(project.id); const path = join(engine.path(project.id), 'days/2026-10-14.md'), before = readFileSync(path, 'utf8');
  const stored = await hub.putSettings(defaultProjectWorkSettings(project.id), 0);
  await engine.sync(project.id); expect(readFileSync(path, 'utf8').startsWith(before)).toBe(true);
  project.name = 'Renamed shop';
  await hub.putSettings({ ...stored.document, nightlyWindow: { ...stored.document.nightlyWindow, timezone: 'UTC' } }, stored.revision);
  await engine.sync(project.id);
  now += 60000; ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'After the calendar change.' } });
  await engine.sync(project.id); const updated = readFileSync(path, 'utf8');
  expect(updated.startsWith(before)).toBe(true); expect(updated).toContain('2026-10-14 11:00'); expect(updated).toContain('2026-10-14 10:01');
  await engine.sync(project.id, true); expect(readFileSync(path, 'utf8')).toBe(updated);
});

test('a slow project does not delay an independent journal in the same sweep', async () => {
  const { project, hub, ledgers } = setup(), slow = ProjectSchema.parse({ ...project, id: 'slow_project' });
  database.put('projects', slow.id, ProjectSchema, slow, 0);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const delayed = new Proxy(hub, { get(target, property) {
    if (property === 'tasks') return async (id: string, after?: string) => { if (id === slow.id) await pending; return target.tasks(id, after); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const journal = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub: delayed, projects: async () => [slow, project], threads: () => [], now: () => now }); engines.push(journal);
  const sweep = journal.syncAll();
  try { await expect.poll(() => existsSync(join(journal.path(project.id), 'INDEX.md')), { timeout: 1000 }).toBe(true); }
  finally { release(); await sweep; }
});

test('one failed project does not prevent later journals from synchronizing and recovers on the next sweep', async () => {
  const { project, hub, ledgers } = setup(), bad = ProjectSchema.parse({ ...project, id: 'bad_project', name: 'Unavailable project' });
  database.put('projects', bad.id, ProjectSchema, bad, 0);
  let unavailable = true;
  const journal = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub, projects: async () => [bad, project],
    threads: id => { if (id === bad.id && unavailable) throw new Error('This project is temporarily unavailable.'); return []; }, now: () => now }); engines.push(journal);
  await journal.syncAll().catch(() => undefined);
  expect(existsSync(join(journal.path(project.id), 'INDEX.md'))).toBe(true);
  expect(existsSync(join(journal.path(bad.id), 'INDEX.md'))).toBe(false);
  unavailable = false; await journal.syncAll();
  expect(existsSync(join(journal.path(bad.id), 'INDEX.md'))).toBe(true);
});

test('two actual local daemons mirror changes and catch up after a simulated hub disconnection', { timeout: 120000 }, async () => {
  fixture = await projectFixture(); const member = await projectMember(fixture), projectId = fixture.project.id;
  const authority = fixture.app.projectWork.journal!, mirror = member.app.projectWork.journal!;
  authority.start(); mirror.start();
  fixture.app.projectWork.coordinatorLedger(projectId).append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Shared journal across devices.' } });
  const path = 'days/' + new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) + '.md';
  const started = Date.now();
  await expect.poll(() => existsSync(join(mirror.path(projectId), path)) ? readFileSync(join(mirror.path(projectId), path), 'utf8') : '', { timeout: 30000 }).toContain('Shared journal across devices.');
  await expect.poll(() => mirror.state(projectId).files, { timeout: Math.max(1, 30000 - (Date.now() - started)) }).toEqual(authority.state(projectId).files);
  expect(Date.now() - started).toBeLessThan(30000);
  member.offline = true;
  fixture.app.projectWork.coordinatorLedger(projectId).append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Written while the member is offline.' } });
  member.app.projectWork.coordinatorLedger(projectId).append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Member note while offline.' } });
  await expect(mirror.sync(projectId)).rejects.toThrow();
  expect(readFileSync(join(mirror.path(projectId), path), 'utf8')).not.toContain('Written while the member is offline.');
  member.offline = false;
  await expect.poll(() => readFileSync(join(mirror.path(projectId), path), 'utf8'), { timeout: 30000 }).toContain('Written while the member is offline.');
  await expect.poll(() => readFileSync(join(authority.path(projectId), path), 'utf8'), { timeout: 30000 }).toContain('Member note while offline.');
});

test('INDEX links a thread only when its journal file exists, and lists a remote thread without one by title and state', async () => {
  // Readiness failure: INDEX linked threads/<file>.md for threads whose header was never captured on this device.
  const { engine, project } = setup();
  await new HubProjectAccess(database, 'dev_other').publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_remote', projectId: project.id, title: 'Remote work', state: 'running', isolation: 'worktree',
    ownerDeviceId: 'dev_other', runtime: 'claude', modelLabel: 'Claude Opus', effort: 'high', accountLabel: 'Work', turns: 1, createdAt: at, updatedAt: at }), 1);
  await engine.sync(project.id, true);
  const index = readFileSync(join(engine.path(project.id), 'INDEX.md'), 'utf8'), line = index.split('\n').find(row => row.includes('Remote work'))!;
  expect(line).toContain('(no journal yet)'); expect(line).toContain('running'); expect(line).not.toMatch(/threads\//u);
  for (const link of index.matchAll(/(?:→ |\]\()((?:threads|days|nights)\/[^\s#)]+)/gu)) expect(existsSync(join(engine.path(project.id), link[1]!)), link[1]).toBe(true);
});
