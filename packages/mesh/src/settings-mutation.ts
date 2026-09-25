import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, stableJson, type DocumentSchema } from '@jevellan/core';
import type { HubDatabase } from './database.js';

const OperationSchema = z.enum(['account-add', 'account-update', 'rigging-add', 'rigging-update', 'project-put', 'jev-put']);
const ReceiptSchema = z.strictObject({
  schema: z.literal('settings-mutation-v1'), deviceId: IdSchema, requestId: IdSchema,
  operation: OperationSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), result: z.json(),
});

/** Commit a public Settings result and its receipt in the same hub transaction. */
export function settingsMutation<T>(hub: HubDatabase, deviceId: string, operation: z.infer<typeof OperationSchema>, input: unknown, requestId: string | undefined, schema: DocumentSchema<T>, apply: () => T extends PromiseLike<unknown> ? never : T): T {
  if (requestId === undefined) return hub.transaction(() => ({ value: schema.parse(apply()) })).value;
  IdSchema.parse(deviceId); IdSchema.parse(requestId);
  const key = createHash('sha256').update(`${deviceId}\0${requestId}`).digest('hex');
  const fingerprint = hub.vault.requestFingerprint(stableJson({ operation, input }));
  return hub.transaction(() => {
    const saved = hub.get('settings-mutations', key, ReceiptSchema)?.document;
    if (saved) {
      if (saved.deviceId !== deviceId || saved.requestId !== requestId || saved.operation !== operation || saved.fingerprint !== fingerprint) throw Object.assign(new Error('This Settings request was already used for a different save. Reload before trying again.'), { status: 409 });
      return { value: schema.parse(saved.result) };
    }
    const result = schema.parse(apply());
    hub.put('settings-mutations', key, ReceiptSchema, { schema: 'settings-mutation-v1', deviceId, requestId, operation, fingerprint, result }, 0);
    return { value: result };
  }).value;
}
