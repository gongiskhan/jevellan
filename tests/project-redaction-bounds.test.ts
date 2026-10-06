// Redaction never makes a checked text longer than its schema allows (P8 review S-1): a summary or reason that redaction would lengthen
// ("Bearer token" becomes "Bearer [redacted]") is cut back to a point redaction leaves unchanged, so what was checked is what is stored and
// sent, and every later redaction pass changes nothing. Live: the ledgers, the outbox files and the zod schemas; nothing is simulated.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorEventSchema, Homes, SecretRedactor, ThreadReportSchema, boundedRedaction, fitRedacted, type ProjectLedgerEvent } from '../packages/core/dist/index.js';
import { Outbox, ProjectLedgers, ProjectPaths, synthesizedReport } from '../packages/projects/dist/index.js';

let root: string; let homes: Homes; let paths: ProjectPaths;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-redaction-bounds-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); paths = new ProjectPaths(homes); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const redactor = new SecretRedactor();
const stable = (text: string) => redactor.text(text) === text;
/** 1,200 characters (the report summary maximum) whose redaction is 1,205: "token" (5) becomes "[redacted]" (10). */
const SUMMARY = `${'Fixed the parser. '.repeat(70)}`.slice(0, 1200 - ' The middleware reads the Bearer token now.'.length) + ' The middleware reads the Bearer token now.';
const report = (summary: string) => ({ schema: 'thread-report-v1', turn: 1, status: 'progress', summary, changedFiles: [], synthesized: true });
const event = (summary: string) => ({ schema: 'coordinator-event-v1', kind: 'thread-report', id: 'cev_bearer', at: '2026-10-05T10:00:00.000Z', threadId: 'thread_x', report: report(summary) });

test('a cut keeps to a point redaction leaves unchanged and always ends, also inside a redacted token', () => {
  expect(SUMMARY).toHaveLength(1200); expect(redactor.text(SUMMARY)).toHaveLength(1205);
  // Cutting "Bearer [redacted]" at "Bearer [reda" would grow again on the next pass; the cut moves back to "Bearer ".
  expect(fitRedacted(redactor, 'Bearer [redacted]', 12)).toBe('Bearer ');
  for (let max = 0; max <= 20; max += 1) {
    const cut = fitRedacted(redactor, 'see Bearer [redacted] end', max);
    expect(cut.length).toBeLessThanOrEqual(max); expect(stable(cut)).toBe(true); expect('see Bearer [redacted] end'.startsWith(cut)).toBe(true);
  }
  // Keeping the end (a summary is the last 1,200 characters of the final message) cuts at the front.
  const tail = fitRedacted(redactor, redactor.text(`Bearer abc ${'x'.repeat(30)}`), 30, 'end');
  expect(tail).toBe('x'.repeat(30)); expect(stable(tail)).toBe(true);
});

test('bounded redaction never lengthens a string, leaves shorter results as redaction does, and the result passes its schema', () => {
  const bounded = boundedRedaction(redactor, event(SUMMARY));
  expect(bounded.report.summary.length).toBeLessThanOrEqual(1200); expect(stable(bounded.report.summary)).toBe(true);
  expect(bounded.report.summary).toContain('The middleware reads the Bearer [redacted]');
  expect(() => CoordinatorEventSchema.parse(bounded)).not.toThrow();
  // A redaction that shortens (a long token) is kept exactly as `document` gives it.
  const token = `ghp_${'a'.repeat(36)}`;
  expect(boundedRedaction(redactor, { text: `use ${token} here` })).toEqual(redactor.document({ text: `use ${token} here` }));
  // A short secret the device knows grows when replaced; the string keeps its old length.
  const secrets = new SecretRedactor(); secrets.add('abc');
  const grown = boundedRedaction(secrets, { text: 'abc abc abc' });
  expect(grown.text.length).toBeLessThanOrEqual('abc abc abc'.length); expect(secrets.text(grown.text)).toBe(grown.text); expect(grown.text).not.toContain('abc');
});

test('a synthesized report keeps the end of the final message, redacted, within the summary maximum', () => {
  const text = `${'x'.repeat(1300)} The middleware reads the Bearer token now.`;
  const synthesized = synthesizedReport({ status: 'completed', finalText: text }, 1, redactor);
  expect(synthesized.summary.length).toBeLessThanOrEqual(1200); expect(stable(synthesized.summary)).toBe(true);
  expect(synthesized.summary.endsWith('reads the Bearer [redacted] now.')).toBe(true);
  // A token in the final message never reaches the report.
  const token = `ghp_${'b'.repeat(36)}`;
  expect(synthesizedReport({ status: 'completed', finalText: `done with ${token}` }, 1, redactor).summary).toBe('done with [redacted]');
});

test('the project ledger stores what it checked: a report that redaction would lengthen is stored within its maximum and reads back', () => {
  const ledger = new ProjectLedgers(paths, { redactor }).thread('project', 'thread_x');
  const appended = ledger.append({ type: 'thread-report', data: ThreadReportSchema.parse(report(SUMMARY)) });
  const read = ledger.payload(appended as ProjectLedgerEvent & { type: 'thread-report' });
  expect(read.summary.length).toBeLessThanOrEqual(1200); expect(stable(read.summary)).toBe(true);
});

test('a stored report that is longer than its maximum (written before this fix) reads back cut to the maximum instead of failing the page', () => {
  const ledger = new ProjectLedgers(paths, { redactor }).thread('project', 'thread_x');
  ledger.append({ type: 'notice', data: { schema: 'project-notice-v1', text: 'First.', kind: 'info' } });
  const folder = join(paths.thread('project', 'thread_x'), 'ledger'); const file = join(folder, readdirSync(folder).sort().at(-1)!);
  // The record an earlier version wrote: checked at 1,200 characters, then redacted to 1,205.
  appendFileSync(file, `${JSON.stringify({ schema: 'project-ledger-event-v1', id: 2, t: '2026-10-05T10:00:00.000Z', type: 'thread-report', data: report(redactor.text(SUMMARY)) })}\n`);
  const stored = new ProjectLedgers(paths, { redactor }).thread('project', 'thread_x');
  const events = stored.events().filter((entry) => entry.type === 'thread-report');
  expect(events).toHaveLength(1);
  const read = stored.payload(events[0] as ProjectLedgerEvent & { type: 'thread-report' });
  expect(read.summary.length).toBeLessThanOrEqual(1200); expect(stable(read.summary)).toBe(true);
});

test('the outbox takes an event that redaction would lengthen and stores it within its maximum', () => {
  const outbox = new Outbox({ paths, hub: { coordinator: async () => null, putEnvelope: async () => ({ stored: true }) }, deviceId: 'dev_a', redactor,
    timers: { outboxRetryMs: 10_000, outboxMaxMs: 60_000, now: () => Date.parse('2026-10-05T10:00:00.000Z') } });
  const entry = outbox.enqueue('project', 'coordinator', { kind: 'coordinator-event', event: CoordinatorEventSchema.parse(event(SUMMARY)) });
  const body = entry.envelope.body as { event: { report: { summary: string } } };
  expect(body.event.report.summary.length).toBeLessThanOrEqual(1200); expect(stable(body.event.report.summary)).toBe(true);
});
