import { z } from 'zod';
import { ProjectRelativePathSchema } from './project-parity-schemas.js';
import { IdSchema } from './schemas.js';
const ref = z.string().min(1).max(500).refine(value => !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.' || !part), 'Use a relative file inside the job workspace.');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const JobDeliveryGateSchema = z.strictObject({ id: IdSchema, command: z.string().trim().min(1).max(2000), timeoutMinutes: z.number().int().min(1).max(600), protectedPaths: z.array(ProjectRelativePathSchema).max(30) });
export const JobDeliverySchema = z.strictObject({ id: IdSchema, title: z.string().trim().min(1).max(120), brief: z.string().trim().min(1).max(16000), type: z.enum(['fix', 'finding', 'docs', 'feature']),
  files: z.array(z.strictObject({ ref, name: z.string().min(1).max(200), sha256 })).max(10).default([]),
  gateInput: z.strictObject({ ref, sha256 }).optional() });
export const JobDeliveriesSchema = z.strictObject({ schema: z.literal('project-job-deliveries-v1'), deliveries: z.array(JobDeliverySchema).max(20) });
export const JobDeliveryReceiptSchema = z.strictObject({ schema: z.literal('project-job-delivery-v1'), id: IdSchema, title: JobDeliverySchema.shape.title, brief: z.string().min(1).max(20000), type: JobDeliverySchema.shape.type,
  fromBranch: z.string().min(1).max(200), gate: JobDeliveryGateSchema.optional(), inputSha256: sha256.optional() });
export const JobDeliveryBindingSchema = z.strictObject({ runId: IdSchema, deliveryId: IdSchema });
export type JobDeliveryReceipt = z.infer<typeof JobDeliveryReceiptSchema>;
