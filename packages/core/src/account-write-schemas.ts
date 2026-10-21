import { z } from 'zod';
import { IdSchema, AccountEndpointSchema } from './schemas.js';
const PaidUseSchema = z.enum(['always', 'when-subscriptions-run-out', 'never']);
export const UpdateAccountSchema = z.strictObject({
  schema: z.literal('update-account-v1'), revision: z.number().int().positive(), label: z.string().trim().min(1).max(128),
  enabled: z.boolean(), ceilingPct: z.number().min(0).max(100), paidUse: PaidUseSchema.optional(), endpoint: AccountEndpointSchema.optional(), clientRequestId: IdSchema.optional(),
});
