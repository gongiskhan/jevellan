import { expect, test } from 'vitest';
import { projectBoundary, projectDay, shiftProjectDate } from '../packages/projects/dist/project-day.js';

test('a Lisbon project day closes at the configured local boundary on ordinary and DST days', () => {
  expect(projectBoundary('2026-03-29', '02:00', 'Europe/Lisbon')).toBe(Date.parse('2026-03-29T01:00:00Z'));
  expect(projectBoundary('2026-10-25', '02:00', 'Europe/Lisbon')).toBe(Date.parse('2026-10-25T02:00:00Z'));
  expect(projectBoundary('2026-10-24', '02:00', 'Europe/Lisbon')).toBe(Date.parse('2026-10-24T01:00:00Z'));
  const boundary = projectBoundary('2026-10-25', '02:00', 'Europe/Lisbon');
  expect(projectDay(boundary - 1)).toBe('2026-10-24'); expect(projectDay(boundary)).toBe('2026-10-25');
  expect(shiftProjectDate('2026-01-01', -1)).toBe('2025-12-31');
});
test('ambiguous times choose the first occurrence and missing times choose the next valid local minute', () => {
  expect(projectBoundary('2026-10-25', '01:30', 'Europe/Lisbon')).toBe(Date.parse('2026-10-25T00:30:00Z'));
  expect(projectBoundary('2026-03-29', '01:30', 'Europe/Lisbon')).toBe(Date.parse('2026-03-29T01:00:00Z'));
  expect(() => projectBoundary('2026-10-11', '25:00', 'Europe/Lisbon')).toThrow();
  expect(() => projectDay(Date.now(), '02:00', 'Invalid/Zone')).toThrow();
});
