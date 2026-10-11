import { z } from 'zod';
import { TimestampSchema } from './schemas.js';
export const WorkflowInputNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export const WorkflowInputsSchema = z.record(WorkflowInputNameSchema, z.string().max(2000)).refine(value => Object.keys(value).length <= 25, 'At most twenty-five workflow inputs.');
export const WorkflowDispatchHandoffSchema = z.strictObject({ schema: z.literal('workflow-dispatch-handoff-v1'), pull: z.number().int().positive(), watchOrder: z.number().int().min(0).max(100) });
export const WorkflowHandoffStateSchema = z.strictObject({ schema: z.literal('workflow-handoff-state-v1'), pull: z.number().int().positive(), state: z.enum(['waiting', 'merged', 'blocked']), checkedAt: TimestampSchema, reason: z.string().max(300).optional() });
export type WorkflowHandoffState = z.infer<typeof WorkflowHandoffStateSchema>;
