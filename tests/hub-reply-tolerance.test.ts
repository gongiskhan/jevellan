import { expect, test } from 'vitest';
import { SecretRedactor, defaultProjectWorkSettings, parseReply } from '../packages/core/dist/index.js';
import { HubProtocolError, MemberHubClient } from '../packages/mesh/dist/index.js';
import { z } from 'zod';

const projectId = 'project_tolerance';
function fakeHub(reply: (body: Record<string, unknown>) => unknown) {
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(reply(body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return new MemberHubClient({ hubUrl: 'https://hub.tailtest.ts.net', hubName: 'Fixture hub', deviceId: 'dev_member', token: () => 'a'.repeat(43), redactor: new SecretRedactor(), fetch });
}
const settingsReply = (document: Record<string, unknown>) => ({ schema: 'project-hub-result-v1', operation: 'settings-get', record: { revision: 1, document } });

test('a member reads a settings reply from a newer hub that adds a nested key', async () => {
  // The exact readiness case: the hub's settings reply gained sessionCheckpoints, and an older member failed every thread.
  const document = { ...defaultProjectWorkSettings(projectId), revision: 1 } as Record<string, unknown>;
  const newer = { ...document, laterSetting: { enabled: true }, memory: { ...(document.memory as object), laterMemoryKey: 3 } };
  const client = fakeHub(() => settingsReply(newer));
  const result = await client.projects('settings', { schema: 'project-hub-request-v1', operation: 'settings-get', projectId });
  expect(result.operation).toBe('settings-get');
  const record = (result as { record: { document: Record<string, unknown> } }).record.document;
  expect(record).not.toHaveProperty('laterSetting'); expect(record.memory).not.toHaveProperty('laterMemoryKey');
  expect(record).toEqual(document);
});

test('other reply problems remain protocol errors', async () => {
  const document = { ...defaultProjectWorkSettings(projectId), revision: 1 } as Record<string, unknown>;
  const client = fakeHub(() => settingsReply({ ...document, laterSetting: true, maxRunningThreads: 'many' }));
  await expect(client.projects('settings', { schema: 'project-hub-request-v1', operation: 'settings-get', projectId })).rejects.toBeInstanceOf(HubProtocolError);
});

test('parseReply removes only reported keys, at most ten levels deep, and leaves the input untouched', () => {
  const Leaf = z.strictObject({ a: z.number() });
  let schema: z.ZodType = Leaf; for (let i = 0; i < 12; i++) schema = z.strictObject({ child: schema });
  const nest = (depth: number, leaf: Record<string, unknown>): Record<string, unknown> => depth === 0 ? leaf : { child: nest(depth - 1, leaf), [`extra${depth}`]: 1 };
  const input = nest(12, { a: 1, extra0: true });
  // Strict parsing reports nested unknown keys together, so the deep reply is cleaned in one pass.
  const clean = (depth: number): Record<string, unknown> => depth === 0 ? { a: 1 } : { child: clean(depth - 1) };
  expect(parseReply(schema, input)).toEqual(clean(12));
  expect(input.extra12).toBe(1);
  expect(() => parseReply(Leaf, { a: 'one', b: 1 })).toThrow();
  expect(() => parseReply(Leaf, 'text')).toThrow();
});
