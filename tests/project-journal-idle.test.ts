import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, ProjectSchema, type ProjectJournalRecord } from '../packages/core/dist/index.js';
import { LEDGER_ROLL_BYTES } from '../packages/conversations/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import { ProjectJournals, ProjectLedgers, ProjectPaths } from '../packages/projects/dist/index.js';

test('an idle large journal stays cheap to synchronize and still repairs missing files and records new work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-journal-idle-')));
  mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'hub'), join(root, 'user')); homes.ensure();
  const database = new HubDatabase(homes, 'hub');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Shop', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.memory' }, context: { state: 'none' } });
  database.put('projects', project.id, ProjectSchema, project, 0);
  const ledgers = new ProjectLedgers(new ProjectPaths(homes));
  const journal = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub: new HubProjectAccess(database, 'hub'), projects: async () => [project], threads: () => [], now: () => Date.parse('2026-10-14T10:00:00.000Z') });
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
  const journal = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub: new HubProjectAccess(database, 'hub'), projects: async () => [project], threads: () => [], now: () => Date.parse('2026-10-14T10:00:00.000Z') });
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
