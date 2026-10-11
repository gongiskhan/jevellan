import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

export const GoalAutonomySchema = z.enum(['propose', 'auto']);
export const GoalStateSchema = z.enum(['active', 'paused', 'done']);
const fields = {
  name: z.string().trim().min(1).max(80), motivation: z.string().trim().min(1).max(4000), health: z.string().max(1000),
  autonomy: GoalAutonomySchema, state: GoalStateSchema,
  dailyRefillCap: z.number().int().min(0).max(20), openPrCap: z.number().int().min(1).max(10),
};
export const ProjectGoalSchema = z.strictObject({ schema: z.literal('project-goal-v1'), id: IdSchema, projectId: IdSchema,
  revision: z.number().int().nonnegative(), ...fields, requestDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(), createdAt: TimestampSchema, updatedAt: TimestampSchema });
export type ProjectGoal = z.infer<typeof ProjectGoalSchema>;
export const GoalCreateRequestSchema = z.strictObject({ schema: z.literal('goal-create-request-v1'), clientRequestId: IdSchema,
  ...fields, health: fields.health.default(''), autonomy: fields.autonomy.default('propose'), state: fields.state.default('active'),
  dailyRefillCap: fields.dailyRefillCap.default(3), openPrCap: fields.openPrCap.default(2) });
export const GoalUpdateRequestSchema = z.strictObject({ schema: z.literal('goal-update-request-v1'), expectedRevision: z.number().int().positive(),
  ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.optional()])) as { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> } });
export const GoalCountsSchema = z.strictObject({ queued: z.number().int().nonnegative(), active: z.number().int().nonnegative(),
  inReview: z.number().int().nonnegative(), refillsToday: z.number().int().nonnegative() });
export const GoalViewSchema = z.strictObject({ schema: z.literal('goal-view-v1'), goal: ProjectGoalSchema, counts: GoalCountsSchema });
export const GoalListViewSchema = z.strictObject({ schema: z.literal('goal-list-view-v1'), projectId: IdSchema, goals: z.array(GoalViewSchema) });
export const ProjectRefillStateSchema = z.strictObject({ schema: z.literal('project-refill-state-v1'), projectId: IdSchema,
  revision: z.number().int().nonnegative(), lastAt: TimestampSchema, eventId: IdSchema,
  goals: z.array(z.strictObject({ goalId: IdSchema, name: fields.name, refillsToday: z.number().int().nonnegative(), cap: fields.dailyRefillCap })).max(100) });
export type ProjectRefillState = z.infer<typeof ProjectRefillStateSchema>;
