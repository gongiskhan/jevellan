import { z } from 'zod';
import { IdSchema, RiggingItemSchema } from './schemas.js';

export const RiggingAddressSchema = z.strictObject({
  ref: z.string().min(1), bucket: IdSchema.optional(), selector: z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1).optional(),
});
export const RiggingDiskItemSchema = z.strictObject({
  schema: z.literal('rigging-disk-item-v1'), id: IdSchema, runtime: z.enum(['claude', 'codex']), accountId: IdSchema,
  kind: RiggingItemSchema.shape.kind, name: z.string(), address: RiggingAddressSchema,
  state: RiggingItemSchema.shape.state, drifted: z.boolean(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.iso.datetime(), fileCount: z.number().int().nonnegative(), editable: z.boolean(), canPark: z.boolean(), problem: z.string().optional(),
});
export const RiggingPromotionInputSchema = z.strictObject({ schema: z.literal('rigging-promotion-input-v1'), requestId: IdSchema, fingerprint: RiggingDiskItemSchema.shape.fingerprint, name: z.string().trim().min(1).max(128), runtimes: z.record(IdSchema, z.boolean()) });
export const RiggingPromotionPendingSchema = z.strictObject({ request: RiggingPromotionInputSchema, runtime: z.enum(['claude', 'codex']), accountId: IdSchema, itemId: IdSchema, ref: z.string(), canCancel: z.boolean() });
export const RiggingDiskListSchema = z.strictObject({
  schema: z.literal('rigging-disk-list-v1'), items: z.array(RiggingDiskItemSchema),
  errors: z.array(z.strictObject({ runtime: IdSchema, accountId: IdSchema, message: z.string() })),
  pending: z.array(z.strictObject({ requestId: IdSchema, itemId: IdSchema, runtime: z.enum(['claude', 'codex']), accountId: IdSchema, action: z.enum(['park', 'restore']), fingerprint: z.string(), ref: z.string() })),
  promotions: z.array(RiggingPromotionPendingSchema).default([]),
});
export const RiggingDiskDetailSchema = z.strictObject({
  schema: z.literal('rigging-disk-detail-v1'), item: RiggingDiskItemSchema, content: z.string(), format: z.enum(['markdown', 'json', 'text']), redacted: z.boolean(),
});
export const RiggingDiskWriteSchema = z.strictObject({ schema: z.literal('rigging-disk-write-v1'), fingerprint: RiggingDiskItemSchema.shape.fingerprint, content: z.string().max(1024 * 1024) });
export const RiggingDiskTransitionSchema = z.strictObject({
  schema: z.literal('rigging-disk-transition-v1'), requestId: IdSchema, fingerprint: RiggingDiskItemSchema.shape.fingerprint, action: z.enum(['park', 'restore']),
});
export const RiggingDiskResultSchema = z.strictObject({ schema: z.literal('rigging-disk-result-v1'), requestId: IdSchema, status: z.literal('completed') });
export const RiggingDiskCancelSchema = z.strictObject({ schema: z.literal('rigging-disk-cancel-v1'), requestId: IdSchema });
export const RiggingDiskCancelledSchema = z.strictObject({ schema: z.literal('rigging-disk-cancelled-v1'), requestId: IdSchema, status: z.literal('cancelled') });
export type RiggingAddress = z.infer<typeof RiggingAddressSchema>;
export type RiggingDiskItem = z.infer<typeof RiggingDiskItemSchema>;
