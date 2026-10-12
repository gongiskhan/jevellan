import { expect, test } from 'vitest';
import { SecretRedactor } from '../packages/core/dist/index.js';

test('an oversized patch line stops consumption at the input cap without buffering the full line', async () => {
  const { boundedReviewLines } = await import('../packages/projects/dist/review-input.js');
  let consumed = 0, written = 0;
  async function* source() { for (let i = 0; i < 1000; i++) { consumed++; yield Buffer.alloc(64 * 1024, 'x'); } }
  expect(await boundedReviewLines(source(), () => 8 * 1024 * 1024 - written, text => { written += Buffer.byteLength(text); return true; })).toBe(true);
  expect(consumed).toBeLessThanOrEqual(130); expect(written).toBeLessThanOrEqual(8 * 1024 * 1024);
});
test('review streaming preserves UTF-8 and redacts a secret split between chunks', async () => {
  const { boundedReviewLines } = await import('../packages/projects/dist/review-input.js');
  const redactor = new SecretRedactor(); redactor.add('fixture-sensitive-value'); const parts: string[] = [];
  const raw = Buffer.from('ação fixture-sensitive-value\n');
  async function* source() { for (const byte of raw) yield Buffer.from([byte]); }
  await boundedReviewLines(source(), () => 8 * 1024 * 1024, text => { parts.push(redactor.text(text)); return true; });
  expect(parts.join('')).toContain('ação'); expect(parts.join('')).not.toContain('fixture-sensitive-value');
});
