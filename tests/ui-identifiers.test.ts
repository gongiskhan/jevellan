import { afterEach, expect, test, vi } from 'vitest';
import { IdSchema } from '../packages/core/dist/index.js';
import { clientId } from '../apps/web/lib/client-id.js';

afterEach(() => vi.unstubAllGlobals());

test('plain-HTTP browsers can create distinct valid request identities without randomUUID', () => {
  vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  const ids = Array.from({ length: 100 }, () => clientId());
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(IdSchema.parse(`conversation_${id}`)).toBe(`conversation_${id}`);
  }
});
