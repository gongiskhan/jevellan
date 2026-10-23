import { expect, test } from 'vitest';
import { SecretRedactor } from '../packages/core/dist/index.js';

test('repeated public snapshots stay responsive as the registered credential set grows', () => {
  const redactor = new SecretRedactor();
  for (let n = 0; n < 1200; n++) redactor.add(`simulated-credential-${n.toString().padStart(5, '0')}-private`);
  const snapshot = { rows: Array.from({ length: 800 }, (_, n) => ({ id: `item_${n}`, text: `Recorded message ${n}: ${'safe product history '.repeat(6)}` })) };
  expect(redactor.document(snapshot)).toEqual(snapshot);
  const started = process.cpuUsage();
  for (let n = 0; n < 8; n++) expect(redactor.document(snapshot)).toEqual(snapshot);
  const elapsed = process.cpuUsage(started), milliseconds = (elapsed.user + elapsed.system) / 1000;
  expect(milliseconds, 'Repeated unchanged views must not rescan every registered credential for every field.').toBeLessThan(200);
  redactor.add('Recorded message');
  expect(redactor.document(snapshot).rows[0]!.text).toBe(`[redacted] 0: ${'safe product history '.repeat(6)}`);
});

test('repeated redaction retains longest-first behavior and invalidates on every new secret', () => {
  const redactor = new SecretRedactor(); redactor.add('private-value'); redactor.add('private');
  for (let n = 0; n < 3; n++) expect(redactor.text('private-value and private')).toBe('[redacted] and [redacted]');
  expect(redactor.text('later value')).toBe('later value'); redactor.add('later');
  expect(redactor.text('later value')).toBe('[redacted] value');
  redactor.add('\ud800');
  expect(redactor.text('\ufffd')).toBe('\ufffd'); expect(redactor.text('\ud800')).toBe('[redacted]');
  for (let n = 0; n < 5000; n++) redactor.text(`A different safe message ${n}`);
  expect(redactor.text('later value')).toBe('[redacted] value');
  const large = `Large ${'safe '.repeat(30000)}`; expect(redactor.text(large)).toBe(large);
  redactor.add('Large'); expect(redactor.text(large)).toBe(large.replace('Large', '[redacted]'));
});
