import { expect, test } from 'vitest';
import type { ProjectLedgerEvent } from '../packages/core/dist/index.js';
import { projectHistory } from '../apps/web/src/project-history.js';

const event = (id: number): ProjectLedgerEvent => ({ schema: 'project-ledger-event-v1', id, type: 'coordinator-text',
  t: '2026-10-16T09:00:00.000Z', data: { schema: 'coordinator-text-v1', text: `Reply ${id}` } });

test('slow history is shown once, after its work snapshot is covered, without chasing later polls', () => {
  const history = projectHistory();
  expect(history.snapshot(4)).toBeUndefined();
  for (const id of [1, 2, 3]) expect(history.add(event(id))).toBeUndefined();
  expect(history.snapshot(10)).toBeUndefined();
  expect(history.add(event(4))).toEqual([1, 2, 3, 4].map(event));
});

test('history can arrive before the work snapshot; reconnect duplicates are sorted and deduplicated', () => {
  const history = projectHistory();
  for (const id of [1, 2, 2, 3]) expect(history.add(event(id))).toBeUndefined();
  expect(history.snapshot(3)).toEqual([1, 2, 3].map(event));
});

test('an empty project loads immediately and a moved coordinator gets an independent ledger', () => {
  expect(projectHistory().snapshot(0)).toEqual([]);
  const old = projectHistory(); old.add(event(10)); expect(old.snapshot(10)).toEqual([event(10)]);
  const moved = projectHistory(); expect(moved.snapshot(2)).toBeUndefined();
  expect(moved.add(event(1))).toBeUndefined(); expect(moved.add(event(2))).toEqual([event(1), event(2)]);
});
