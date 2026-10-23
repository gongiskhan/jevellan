import { expect, test } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, ProjectSchema, type ProjectJournalRecord } from '../packages/core/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import { ProjectJournals, ProjectLedgers, ProjectPaths, renderProjectJournal } from '../packages/projects/dist/index.js';
import { LEDGER_ROLL_BYTES } from '../packages/conversations/dist/index.js';

test('a large recorded project journal renders within the owner request budget', () => {
  const at = '2026-10-14T10:00:00.000Z';
  const count = 13_000;
  const records: ProjectJournalRecord[] = Array.from({ length: count }, (_, index) => ({
    schema: 'project-journal-record-v1', deviceId: 'hub', ledgerId: 'coordinator',
    event: { schema: 'project-ledger-event-v1', id: index + 1, t: at, type: 'coordinator-text',
      data: { schema: 'coordinator-text-v1', text: `Recorded update ${index + 1}. ${'Synthetic project history. '.repeat(50)}` } },
  }));
  const start = performance.now();
  const result = renderProjectJournal({ name: 'Shop', timezone: 'Europe/Lisbon', records, open: [], updatedAt: at });
  const elapsed = performance.now() - start;
  const day = result.files['days/2026-10-14.md']!;
  expect(day).toContain('Recorded update 1.');
  expect(day).toContain(`Recorded update ${count}.`);
  expect(day.match(/<a id="e-hub-coordinator-/g)).toHaveLength(count);
  expect(elapsed).toBeLessThan(1_000);
}, 60_000);

test('historical timezone changes preserve each recorded day and daylight saving time', () => {
  const at = '2026-03-29T01:30:00.000Z';
  const records: ProjectJournalRecord[] = [
    { schema: 'project-journal-record-v1', deviceId: 'hub', ledgerId: 'coordinator', event: {
      schema: 'project-ledger-event-v1', id: 2, t: at, type: 'coordinator-text',
      data: { schema: 'coordinator-text-v1', text: 'Lisbon update.' },
    } },
    { schema: 'project-journal-record-v1', deviceId: 'hub', ledgerId: 'coordinator', event: {
      schema: 'project-ledger-event-v1', id: 3, t: at, type: 'journal-config',
      data: { schema: 'journal-config-v1', name: 'Shop', timezone: 'America/New_York' },
    } },
    { schema: 'project-journal-record-v1', deviceId: 'hub', ledgerId: 'coordinator', event: {
      schema: 'project-ledger-event-v1', id: 4, t: at, type: 'coordinator-text',
      data: { schema: 'coordinator-text-v1', text: 'New York update.' },
    } },
  ];
  // Record the initial timezone explicitly, as the durable journal does.
  records.unshift({ schema: 'project-journal-record-v1', deviceId: 'hub', ledgerId: 'coordinator', event: {
    schema: 'project-ledger-event-v1', id: 1, t: at, type: 'journal-config',
    data: { schema: 'journal-config-v1', name: 'Shop', timezone: 'Europe/Lisbon' },
  } });
  const result = renderProjectJournal({ name: 'Shop', timezone: 'UTC', records, open: [], updatedAt: at });
  expect(result.files['days/2026-03-29.md']).toContain('2026-03-29 02:30 Coordinator');
  expect(result.files['days/2026-03-28.md']).toContain('2026-03-28 21:30 Coordinator');
  expect(result.files['days/2026-03-29.md']).toContain('Lisbon update.');
  expect(result.files['days/2026-03-28.md']).toContain('New York update.');
});

test('publishing a batch into a large journal serves owner requests and keeps concurrent publication idempotent', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-journal-load-')));
  mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'hub'), join(root, 'user')); homes.ensure();
  const database = new HubDatabase(homes, 'hub');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Shop', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.memory' }, context: { state: 'none' } });
  const ledgers = new ProjectLedgers(new ProjectPaths(homes));
  const journal = new ProjectJournals({ homes, deviceId: 'hub', isHub: true, ledgers, hub: new HubProjectAccess(database, 'hub'), projects: async () => [project], threads: () => [], now: Date.now });
  const at = '2026-10-14T10:00:00.000Z';
  const record = (id: number): ProjectJournalRecord => ({ schema: 'project-journal-record-v1', deviceId: 'peer', ledgerId: 'coordinator', event: {
    schema: 'project-ledger-event-v1', id, t: at, type: 'coordinator-text',
    data: { schema: 'coordinator-text-v1', text: `Recorded update ${id}. ${'Synthetic project history. '.repeat(45)}` },
  } });
  try {
    const count = 13_000, directory = join(homes.root, 'projects/project/ledger'); mkdirSync(directory, { recursive: true });
    let lines: string[] = [], bytes = 0, segment = 1;
    const flush = () => { writeFileSync(join(directory, `${String(segment++).padStart(6, '0')}.jsonl`), lines.join('')); lines = []; bytes = 0; };
    for (let id = 1; id <= count; id++) {
      const line = `${JSON.stringify({ schema: 'project-ledger-event-v1', id, t: at, type: 'journal-source', data: record(id) })}\n`;
      lines.push(line); bytes += Buffer.byteLength(line); if (bytes >= LEDGER_ROLL_BYTES) flush();
    }
    if (lines.length) flush();
    const input = { schema: 'project-journal-request-v1', operation: 'publish', projectId: project.id, records: Array.from({ length: 100 }, (_, n) => record(count + n + 1)) };
    const start = performance.now();
    const ownerRequest = new Promise<number>(resolve => setImmediate(() => resolve(performance.now() - start)));
    let lastRequest = start, longestGap = 0, requestsServed = 0;
    const requests = setInterval(() => {
      const now = performance.now(); longestGap = Math.max(longestGap, now - lastRequest); lastRequest = now; requestsServed++;
    }, 10);
    const publications = Promise.all([journal.request(input, 'peer'), journal.request(input, 'peer')]);
    let results: Awaited<typeof publications>, delay: number;
    try { delay = await ownerRequest; results = await publications; }
    finally { clearInterval(requests); longestGap = Math.max(longestGap, performance.now() - lastRequest); }
    expect(results.map(result => result.operation === 'publish' ? result.accepted : -1).sort((a, b) => a - b)).toEqual([0, 100]);
    expect(ledgers.coordinator(project.id).lastId()).toBe(count + 100);
    await expect(journal.request({ ...input, records: [{ ...input.records[0]!, event: { ...input.records[0]!.event, data: { schema: 'coordinator-text-v1', text: 'Changed identity.' } } }] }, 'peer')).rejects.toThrow('identity');
    await expect(journal.request(input, 'peer')).resolves.toMatchObject({ operation: 'publish', accepted: 0 });
    expect(delay).toBeLessThan(1_000);
    expect(requestsServed).toBeGreaterThan(1);
    expect(longestGap).toBeLessThan(1_000);
  } finally { await journal.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
