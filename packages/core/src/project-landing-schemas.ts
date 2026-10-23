import {JevLessonInputSchema,PlacementRuleContextSchema} from './jev-control-schemas.js';
import { z } from 'zod';
import { IdSchema, JevCallSchema, TimestampSchema } from './schemas.js';
import { TaskPlacementContextSchema } from './task-types.js';
import { EnvNameSchema, ProjectRelativePathSchema } from './project-parity-schemas.js';

export const DeliverySchema = z.enum(['land', 'pull-request']);
export const LandingRouteNameSchema = z.enum(['land', 'verify-then-land', 'ask-owner']);
export const LandingCheckPortSchema = z.strictObject({ schema: z.literal('landing-check-port-v1'), variable: EnvNameSchema, urlVariable: EnvNameSchema.optional() });
export const LandingCheckPortsSchema = z.array(LandingCheckPortSchema).max(12).refine(rows => {
  const names = rows.flatMap(row => [row.variable, ...(row.urlVariable ? [row.urlVariable] : [])]);
  return new Set(names).size === names.length;
}, 'Managed port environment names must be unique.');
export type LandingCheckPort = z.infer<typeof LandingCheckPortSchema>;
export const LandingBlockerSchema = z.strictObject({ schema: z.literal('landing-blocker-v1'), kind: z.literal('port'), port: z.number().int().min(1).max(65535),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/u), check: z.string().min(1).max(80), managed: z.boolean().optional() });
export const ThreadLandingWaitSchema = z.strictObject({ schema: z.literal('thread-landing-wait-v1'), blocker: LandingBlockerSchema,
  decisionId: IdSchema, reason: z.string().min(1).max(1200), createdAt: TimestampSchema });
export const LandingCheckSchema = z.strictObject({ name: z.string().min(1).max(80), paths: z.array(ProjectRelativePathSchema).max(30), command: z.string().min(1).max(2000) });
export const LandingCheckResultSchema = z.strictObject({ name: z.string().min(1).max(80), passed: z.boolean(), at: TimestampSchema });
export const ThreadLandingSchema = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40,64}$/u), at: TimestampSchema,
  method: z.enum(['squash', 'merge-commit']), checks: z.array(LandingCheckResultSchema).max(31), route: LandingRouteNameSchema });
export type ThreadLanding = z.infer<typeof ThreadLandingSchema>;
export const LandingRouteStateSchema = z.strictObject({ schema: z.literal('landing-route-state-v1'), title: z.string().max(120), task: TaskPlacementContextSchema,
  summary: z.string().max(4000), riskyAreas: z.string().max(2000), files: z.array(z.strictObject({ path: z.string().max(4096), bytes: z.number().int().nonnegative(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() })).max(3000),
  checks: z.array(LandingCheckResultSchema).max(31), corrections: z.array(z.string().max(500)).max(8), lessons: JevLessonInputSchema.optional() });
const identity = { id: IdSchema, projectId: IdSchema, revision: z.number().int().nonnegative(), deviceId: IdSchema, threadId: IdSchema,
  commit: z.string().regex(/^[a-f0-9]{40,64}$/u), at: TimestampSchema };
export const LandingRouteSchema = z.strictObject({ schema: z.literal('landing-route-v1'), ...identity, questionSet: z.literal('l-v1'), route: LandingRouteNameSchema,
  source: z.enum(['jev', 'unavailable', 'guard', 'owner']), reason: z.string().max(1200).optional(), packet: LandingRouteStateSchema, calls: z.array(JevCallSchema),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(), state: z.enum(['waiting', 'asked', 'verifying', 'landing', 'landed', 'failed']),
  failures: z.number().int().min(0).max(3).default(0), decisionId: IdSchema.nullable().default(null), verificationId: IdSchema.nullable().default(null),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(), checkedCommit: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
  gateValidUntil: TimestampSchema.optional(),
  settingsDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), candidate: ThreadLandingSchema.optional(), backupDeletedAt: TimestampSchema.optional(),
  // bridge: Jev's answer before the owner's rules, the rules that changed it, the prompt version asked and the lessons Jev saw.
  inputPacket: LandingRouteStateSchema.optional(), ruleContext: PlacementRuleContextSchema.optional(), inputsRef: IdSchema.optional(), promptText: z.string().min(1).max(60000).optional(), rawChoice: LandingRouteNameSchema.optional(), rulesApplied: z.array(z.string().max(20)).max(20).optional(), promptVersion: z.number().int().positive().optional(), lessons: z.array(z.string().max(20)).max(38).optional(), lessonKeys: z.array(IdSchema).max(38).optional() });
export type LandingRoute = z.infer<typeof LandingRouteSchema>;
export const LandingCorrectionSchema = z.strictObject({ schema: z.literal('landing-correction-v1'), ...identity, title: z.string().max(120),
  correction: z.enum(['should-have-asked', 'did-not-need-asking']), receivedOrder: z.number().int().positive().optional() });
export const LandingCorrectionInputSchema = z.strictObject({ schema: z.literal('landing-correction-input-v1'), clientRequestId: IdSchema,
  commit: identity.commit, correction: LandingCorrectionSchema.shape.correction });
