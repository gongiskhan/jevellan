import { z } from 'zod';

const Key = z.string().min(1).max(300).regex(/^[A-Za-z0-9_:-]+$/);
export const SessionListPreferencesSchema = z.strictObject({
  schema: z.literal('session-list-preferences-v1'), revision: z.number().int().nonnegative(),
  titles: z.record(Key, z.string().trim().min(1).max(200)),
  order: z.array(Key).max(10000),
});
export const SessionListUpdateSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('session-list-update-v1'), revision: z.number().int().nonnegative(), operation: z.literal('rename'), id: Key, title: z.string().trim().min(1).max(200) }),
  z.strictObject({ schema: z.literal('session-list-update-v1'), revision: z.number().int().nonnegative(), operation: z.literal('order'), order: z.array(Key).max(10000) }),
]);
