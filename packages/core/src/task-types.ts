import { z } from 'zod';
import { IdSchema } from './schemas.js';
export const TaskTypeSchema = z.enum(['feature', 'fix', 'finding', 'refactor', 'docs', 'analysis', 'review', 'ops', 'memory']);
export type TaskType = z.infer<typeof TaskTypeSchema>;
export const TaskPlacementContextSchema = z.strictObject({ taskId: IdSchema.optional(), type: TaskTypeSchema, needs: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/u)).max(8),
  goal: z.strictObject({ id: IdSchema.optional(), name: z.string().max(80), motivation: z.string().max(600) }).nullable() });
export type TaskPlacementContext = z.infer<typeof TaskPlacementContextSchema>;
export const PlacementOverrideFilterSchema = z.strictObject({ type: TaskTypeSchema, match: z.enum(['same', 'other']) });
export type PlacementOverrideFilter = z.infer<typeof PlacementOverrideFilterSchema>;
