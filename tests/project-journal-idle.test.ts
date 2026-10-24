import { expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, defaultProjectWorkSettings, JournalDocumentSchema, ProjectDecisionSchema, ProjectSchema, ProjectWorkTaskSchema, type ProjectJournalRecord } from '../packages/core/dist/index.js';
import { LEDGER_ROLL_BYTES } from '../packages/conversations/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import { ProjectJournals, ProjectLedgers, ProjectPaths } from '../packages/projects/dist/index.js';
import { projectFixture } from './helpers/project-fixture.js';

test('unchanged journal document sources avoid recapture and still observe changed bytes across awaits', async () => {
  const fixture = await projectFixture({ github: false });
  try {
    const { app } = fixture, journal = app.projectWork.journal!;
    for (let n = 0; n < 20; n++) await app.projectWork.decisions.ask('project', { question: `Fixture question ${n}.` }, 'coordinator', `capture_${n}`);
    for (let n = 0; n < 3; n++) await journal.sync('project');
    const parsing = vi.spyOn(JournalDocumentSchema, 'parse'); let recaptures: number;
    try { for (let n = 0; n < 3; n++) { await app.presence.pulse(); await journal.sync('project'); } recaptures = parsing.mock.calls.length; }
    finally { parsing.mockRestore(); }
    expect(recaptures!, 'Unchanged authoritative document bytes must not be parsed and copied into the journal on every sweep.').toBe(0);
    const saved = app.hub.get('project-decisions', 'capture_0', ProjectDecisionSchema)!;
    const replace = (question: unknown) => app.hub.db.prepare('UPDATE documents SET document=? WHERE namespace=? AND id=?')
      .run(JSON.stringify({ ...saved.document, question }), 'project-decisions', saved.document.id);
    // A byte change without a revision change still invalidates the optimization and validates the full document.
    replace(42); await expect(journal.sync('project')).rejects.toThrow();
    replace('Changed source question.'); await journal.sync('project');
    const original = app.projectHub.decisions.bind(app.projectHub);
    const reading = vi.spyOn(app.projectHub, 'decisions').mockImplementationOnce(async id => {
      const rows = await original(id); replace('Changed while capture awaited.'); return rows;
    });
    try { replace('Before the awaited read.'); await journal.sync('project'); }
    finally { reading.mockRestore(); }
    await journal.sync('project');
    const text = Object.keys(journal.state('project').files).filter(path => path.endsWith('.md'))
      .map(path => readFileSync(join(journal.path('project'), path), 'utf8')).join('\n');
    expect(text).toContain('Changed source question.'); expect(text).toContain('Changed while capture awaited.');
    expect(app.hub.get('project-decisions', 'capture_0', ProjectDecisionSchema)?.revision).toBe(saved.revision);
  } finally { await fixture.close(); }
}, 60_000);

test('an idle large journal stays cheap to synchronize and still repairs missing files and records new work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-journal-idle-')));
  mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'hub'), join(root, 'user')); homes.ensure();
  const database = new HubDatabase(homes, 'hub');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Shop', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.memory' }, context: { state: 'none' } });
  database.put('projects', project.id, ProjectSchema, project, 0);
  const ledgers = new ProjectLedgers(new ProjectPaths(homes));
  const journal = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub: new HubProjectAccess(database, 'hub'), documentGeneration: () => database.generation(['projects']), projects: async () => [project], threads: () => [], now: () => Date.parse('2026-10-14T10:00:00.000Z') });
  const at = '2026-10-14T10:00:00.000Z', count = 13_000;
  try {
    const directory = join(homes.root, 'projects/project/ledger'); mkdirSync(directory, { recursive: true });
    let lines: string[] = [], bytes = 0, segment = 1;
    const flush = () => { writeFileSync(join(directory, `${String(segment++).padStart(6, '0')}.jsonl`), lines.join('')); lines = []; bytes = 0; };
    for (let id = 1; id <= count; id++) {
      const record: ProjectJournalRecord = { schema: 'project-journal-record-v1', deviceId: 'peer', ledgerId: 'coordinator', event: {
        schema: 'project-ledger-event-v1', id, t: at, type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: `Recorded update ${id}. ${'Synthetic project history. '.repeat(45)}` },
      } };
      const line = `${JSON.stringify({ schema: 'project-ledger-event-v1', id, t: at, type: 'journal-source', data: record })}\n`;
      lines.push(line); bytes += Buffer.byteLength(line); if (bytes >= LEDGER_ROLL_BYTES) flush();
    }
    if (lines.length) flush();
    await journal.sync(project.id);
    const day = join(journal.path(project.id), 'days/2026-10-14.md'), before = readFileSync(day, 'utf8'), state = journal.state(project.id);
    expect(before).toContain(`Recorded update ${count}.`);
    const start = process.cpuUsage();
    for (let n = 0; n < 8; n++) await journal.sync(project.id);
    const cpu = process.cpuUsage(start);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(200);
    expect(readFileSync(day, 'utf8')).toBe(before);
    expect(journal.state(project.id)).toEqual(state);
    unlinkSync(day); await journal.sync(project.id);
    expect(readFileSync(day, 'utf8')).toBe(before);
    ledgers.coordinator(project.id).append({ type: 'coordinator-text', t: '2026-10-15T10:00:00.000Z', data: { schema: 'coordinator-text-v1', text: 'New work after the idle window.' } });
    await journal.sync(project.id);
    expect(readFileSync(day, 'utf8')).toBe(before);
    expect(readFileSync(join(journal.path(project.id), 'days/2026-10-15.md'), 'utf8')).toContain('New work after the idle window.');
    await journal.sync(project.id, true);
    expect(readFileSync(day, 'utf8')).toContain(`Recorded update ${count}.`);
  } finally { await journal.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test.each(['blob', 'source'])('warm journal projections retain %s validation on rebuild', async kind => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-journal-validation-'))); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'hub'), join(root, 'user')); homes.ensure(); const database = new HubDatabase(homes, 'hub');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Shop', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.memory' }, context: { state: 'none' } });
  database.put('projects', project.id, ProjectSchema, project, 0);
  const ledgers = new ProjectLedgers(new ProjectPaths(homes)), ledger = ledgers.coordinator(project.id);
  const journal = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub: new HubProjectAccess(database, 'hub'), documentGeneration: () => database.generation(['projects']), projects: async () => [project], threads: () => [], now: () => Date.parse('2026-10-14T10:00:00.000Z') });
  try {
    const event = ledger.append({ type: 'journal-source', data: { schema: 'project-journal-record-v1', deviceId: 'peer', ledgerId: 'coordinator', event: {
      schema: 'project-ledger-event-v1', id: 1, t: '2026-10-14T10:00:00.000Z', type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: kind === 'blob' ? 'Before '.repeat(10000) : 'Before' },
    } } });
    await journal.sync(project.id);
    if (kind === 'blob') {
      expect(event.data).toMatchObject({ schema: 'blob-ref-v1' });
      const blob = join(ledger.dir, (event.data as { ref: string }).ref);
      writeFileSync(blob, readFileSync(blob, 'utf8').replace('Before', 'After_'));
      await expect(journal.sync(project.id, true)).rejects.toThrow('integrity');
    } else {
      const file = ledger.segments()[0]!; writeFileSync(file, readFileSync(file, 'utf8').replace('Before', 'After_'));
      await journal.sync(project.id, true);
      expect(readFileSync(join(journal.path(project.id), 'days/2026-10-14.md'), 'utf8')).toContain('After_');
    }
  } finally { await journal.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
});


test('unchanged journal rendering avoids task pages and refreshes settings changed during an await', async () => {
  const fixture = await projectFixture({ github: false }); const { app } = fixture;
  let clock = Date.parse('2026-10-14T10:00:00.000Z');
  const journal = new ProjectJournals({ ...app.projectWork.journal!.o, now: () => clock });
  try {
    expect(app.projectWork.store.list('project')).toEqual([]);
    const at = new Date(clock).toISOString();
    for (let n = 0; n < 30; n++) app.hub.put('project-work-tasks', `render_task_${n}`, ProjectWorkTaskSchema, {
      schema: 'project-work-task-v1', id: `render_task_${n}`, projectId: 'project', revision: 1, title: `Historical task ${n}`, brief: 'Durable completed work. '.repeat(100),
      kind: 'session', type: 'review', goalId: null, source: 'daily', state: 'done', rank: '8', ownerRanked: false, now: false, after: [], needs: [],
      dailyId: 'daily_fixture', jobId: null, threadId: null, jobRunId: null, fixed: {}, createdAt: at, updatedAt: at,
    }, 0);
    for (let n = 0; n < 3; n++) { clock += 20_000; await journal.sync('project'); }
    const tasks = vi.spyOn(app.projectHub, 'tasks'), threads = vi.spyOn(app.projectHub, 'threads'); let pages: number, threadPages: number;
    try { for (let n = 0; n < 4; n++) await journal.sync('project'); pages = tasks.mock.calls.length; threadPages = threads.mock.calls.length; }
    finally { tasks.mockRestore(); threads.mockRestore(); }
    expect(pages!, 'An unchanged journal with no local threads must not load full task documents merely to decide nothing changed.').toBe(0);
    expect(threadPages!).toBe(0);
    const replaceTime = async (time: string) => {
      const stored = await app.projectHub.settings('project'), settings = stored?.document ?? defaultProjectWorkSettings('project');
      await app.projectHub.putSettings({ ...settings, nightlyWindow: { ...settings.nightlyWindow, enabled: true, time } }, stored?.revision ?? 0);
    };
    await replaceTime('21:15'); clock += 20_000; await journal.sync('project');
    const index = () => readFileSync(join(journal.path('project'), 'INDEX.md'), 'utf8');
    expect(index()).toContain('21:15');
    const original = app.projectHub.threads.bind(app.projectHub);
    const changed = vi.spyOn(app.projectHub, 'threads').mockImplementationOnce(async (...args) => { const rows = await original(...args); await replaceTime('23:45'); return rows; });
    try { await replaceTime('22:15'); clock += 20_000; await journal.sync('project'); } finally { changed.mockRestore(); }
    clock += 20_000; await journal.sync('project'); expect(index()).toContain('23:45');
    const state = journal.state('project'), path = Object.keys(state.files).find(path => path.startsWith('days/'))!;
    const before = readFileSync(join(journal.path('project'), path), 'utf8'); unlinkSync(join(journal.path('project'), path));
    await journal.sync('project'); expect(readFileSync(join(journal.path('project'), path), 'utf8')).toBe(before);
  } finally { await journal.close(); await fixture.close(); }
}, 60_000);
