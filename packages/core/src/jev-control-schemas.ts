import { z } from 'zod';
import { EffortSchema, IdSchema, TimestampSchema } from './schemas.js';

// Jev control (bridge specification, "Jev control"), state point hub namespaces owner-jev-rules, owner-jev-prompts, owner-jev-proposals, owner-jev-lessons.
export const JevRuleSchema = z.strictObject({ schema: z.literal('jev-rule-v1'), id: z.string().regex(/^R[1-9][0-9]*$/u), key: IdSchema, scope: z.enum(['global', 'project']), projectId: IdSchema.optional(),
  when: z.strictObject({ taskType: z.string().max(40).optional(), goalId: IdSchema.optional(), label: z.string().max(200).optional(), keywords: z.array(z.string().min(1).max(60)).max(20).optional() }),
  set: z.strictObject({ minModel: z.string().max(120).optional(), minEffort: EffortSchema.optional(), maxEffort: EffortSchema.optional(), account: z.string().max(120).optional(), runtime: z.string().max(40).optional(),
    landingRoute: z.enum(['land', 'verify-then-land', 'ask-owner']).optional() }),
  note: z.string().max(400), enabled: z.boolean(), createdAt: TimestampSchema });
export type JevRule = z.infer<typeof JevRuleSchema>;
export const JevPromptVersionSchema = z.strictObject({ schema: z.literal('jev-prompt-version-v1'), key: IdSchema, name: z.string().min(1).max(40), version: z.number().int().positive(), text: z.string().min(1).max(60000),
  summary: z.string().max(400), createdAt: TimestampSchema, active: z.boolean(), source: z.enum(['code', 'owner']), replay: z.string().max(4000).optional(), replayReportId: IdSchema.optional() });
export type JevPromptVersion = z.infer<typeof JevPromptVersionSchema>;
export const JevProposalSchema = z.strictObject({ schema: z.literal('jev-prompt-proposal-v1'), key: IdSchema, id: z.string().regex(/^P[1-9][0-9]*$/u), projectId: IdSchema, name: z.string().min(1).max(40), fromVersion: z.number().int().positive(),
  text: z.string().min(1).max(60000), summary: z.string().max(400), source: z.enum(['owner', 'code']), createdAt: TimestampSchema, state: z.enum(['proposed', 'applied', 'superseded']), replay: z.string().max(12000).optional(), replayReportId: IdSchema.optional() });
export type JevProposal = z.infer<typeof JevProposalSchema>;
export const JevLessonSchema = z.strictObject({ schema: z.literal('jev-lesson-v1'), key: IdSchema, id: z.string().regex(/^L[1-9][0-9]*$/u), scope: z.enum(['global', 'project']), projectId: IdSchema.optional(),
  about: z.enum(['landing', 'placement', 'other']), text: z.string().min(1).max(1000), source: z.string().regex(/^(?:override:D[1-9][0-9]*|owner|migrated)$/u), enabled: z.boolean(), timesApplied: z.number().int().nonnegative(), createdAt: TimestampSchema });
export type JevLesson = z.infer<typeof JevLessonSchema>;

export const JEV_RULES_NAMESPACE = 'owner-jev-rules';
export const ProjectJevPolicySchema = z.strictObject({ schema: z.literal('project-jev-policy-v1'), projectId: IdSchema, rules: z.array(JevRuleSchema).max(1000), prompts: z.array(JevPromptVersionSchema).max(100).optional() });
export type ProjectJevPolicy = z.infer<typeof ProjectJevPolicySchema>;
const promptText = z.string().trim().min(1).max(12000);
export const PlacementPromptSchema = z.strictObject({ schema: z.literal('placement-prompt-v1'),
  instructions: z.strictObject({ isolation: promptText, pick_model: promptText, effort: promptText, device: promptText }),
  isolation: z.strictObject({ main: promptText, worktree: promptText }) });
export type PlacementPrompt = z.infer<typeof PlacementPromptSchema>;
export const MergePromptSchema = z.strictObject({ schema: z.literal('merge-prompt-v1'), instructions: promptText,
  criteria: z.strictObject({ merge: promptText, 'test-then-merge': promptText, 'ask-owner': promptText }) });
export type MergePrompt = z.infer<typeof MergePromptSchema>;
export const PlacementRawChoiceSchema = z.strictObject({ schema: z.literal('placement-raw-choice-v1'), isolation: z.enum(['worktree', 'main']), runtime: IdSchema, modelId: IdSchema, model: z.string().min(1), effortRequested: EffortSchema, effortEffective: EffortSchema, deviceId: IdSchema, accountId: IdSchema });
export type PlacementRawChoice = z.infer<typeof PlacementRawChoiceSchema>;

export const PlacementRuleContextSchema = z.strictObject({ schema: z.literal('placement-rule-context-v1'),
  taskType: z.string().max(40).optional(), goalId: IdSchema.nullable().optional(), label: z.string().max(200).optional(),
  text: z.string().max(34000), complete: z.boolean() });
export type PlacementRuleContext = z.infer<typeof PlacementRuleContextSchema>;
