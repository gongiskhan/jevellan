import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

export const OwnerCommandSchema = z.strictObject({ kind: z.enum(['shell', 'prompt']).default('shell'), command: z.string().min(1).max(4000), why: z.string().min(1).max(300),
  cwd: z.string().min(1).max(1024).refine(value => ['worktree', 'checkout', 'home'].includes(value) || value.startsWith('/') && !/[\0\r\n]/u.test(value), 'Choose worktree, checkout, home or an absolute folder.'), deviceId: IdSchema.optional() });
export type OwnerCommand = z.input<typeof OwnerCommandSchema>;
export const OwnerCommandsSchema = z.array(OwnerCommandSchema).max(5);
export const OwnerCommandRunRequestSchema = z.strictObject({ schema: z.literal('owner-command-run-request-v1'), clientRequestId: IdSchema,
  projectId: IdSchema, threadId: IdSchema.optional(), decisionId: IdSchema.optional(), command: OwnerCommandSchema });
export const OwnerCommandRunReceiptSchema = z.strictObject({ schema: z.literal('owner-command-run-receipt-v1'), terminalId: IdSchema,
  deviceId: IdSchema, deviceName: z.string().min(1), at: TimestampSchema });
