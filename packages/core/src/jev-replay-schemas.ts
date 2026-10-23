import {ThreadUsageTotalSchema} from './project-usage-schemas.js';
import {z} from 'zod';
import {IdSchema,JevCallSchema,ModelPriceTableSchema,TimestampSchema} from './schemas.js';
import {JevPlacementDecisionSchema} from './jev-decision-schemas.js';
import {JevLessonSchema,JevPromptVersionSchema,JevRuleSchema,PlacementRawChoiceSchema} from './jev-control-schemas.js';
import {LandingRouteNameSchema,LandingRouteSchema} from './project-landing-schemas.js';
import {MergeRouteNameSchema,MergeRouteSchema} from './merge-schemas.js';

const choice=z.union([PlacementRawChoiceSchema,LandingRouteNameSchema,MergeRouteNameSchema]);
export const JevReplayCostSchema=z.strictObject({status:z.enum(['not-needed','unavailable','estimated']),reason:z.string().max(1000),oldUsd:z.number().nonnegative().nullable(),newUsd:z.number().nonnegative().nullable(),deltaUsd:z.number().nullable()}).refine(cost=>cost.status==='estimated'?cost.oldUsd!==null&&cost.newUsd!==null&&cost.deltaUsd!==null:cost.status==='unavailable'?cost.oldUsd===null&&cost.newUsd===null&&cost.deltaUsd===null:cost.oldUsd===null&&cost.newUsd===null&&cost.deltaUsd===0,'Cost status must agree with its numeric evidence.');
export type JevReplayCost=z.infer<typeof JevReplayCostSchema>;
export const JevReplayRunUsageSchema=z.strictObject({schema:z.literal('jev-replay-run-usage-v1'),threadId:IdSchema,placementInputsRef:IdSchema,modelId:IdSchema,turns:z.number().int().positive(),usage:ThreadUsageTotalSchema});
export const JevReplayEntrySchema=z.strictObject({schema:z.literal('jev-replay-entry-v1'),sourceId:IdSchema,deviceId:IdSchema,threadId:IdSchema.optional(),at:TimestampSchema,
  input:z.union([JevPlacementDecisionSchema,LandingRouteSchema,MergeRouteSchema]),askedState:z.string().max(100000).optional(),originalChoice:choice.nullable(),rawChoice:choice.nullable(),finalChoice:choice.nullable(),
  status:z.enum(['compared','unavailable','skipped']),changed:z.boolean().nullable(),reason:z.string().max(4000),rulesApplied:z.array(z.string()).max(1000),calls:z.array(JevCallSchema),runUsage:JevReplayRunUsageSchema.optional(),cost:JevReplayCostSchema});
export type JevReplayEntry=z.infer<typeof JevReplayEntrySchema>;
const summary={schema:z.literal('jev-replay-summary-v1'),id:IdSchema,projectId:IdSchema,deviceId:IdSchema,at:TimestampSchema,questionSet:z.enum(['p-v1','m-v1','l-v1','lessons']),proposalId:z.string().regex(/^P[1-9][0-9]*$/u).optional(),lessonId:z.string().regex(/^L[1-9][0-9]*$/u).optional(),
  evidence:z.enum(['live','simulated']),engineVersion:z.string().min(1).max(100),requested:z.number().int().min(1).max(50),selected:z.number().int().min(0).max(50),compared:z.number().int().min(0).max(50),changed:z.number().int().min(0).max(50),unavailable:z.number().int().min(0).max(50),priceTableVersion:IdSchema.nullable(),
  unavailableDevices:z.array(IdSchema).max(200),historyLimitedDevices:z.array(IdSchema).max(200).optional(),legacySkipped:z.number().int().nonnegative().optional(),unusableSkipped:z.number().int().nonnegative().optional(),componentReports:z.array(IdSchema).max(3).optional(),text:z.string().max(12000)};
export const JevReplaySummarySchema=z.strictObject(summary);
export type JevReplaySummary=z.infer<typeof JevReplaySummarySchema>;
export const JevReplayReportSchema=z.strictObject({...summary,schema:z.literal('jev-replay-report-v1'),priceTable:ModelPriceTableSchema.nullable().optional(),proposedPromptText:z.string().max(60000),promptTexts:z.array(JevPromptVersionSchema).max(3).optional(),proposedLessons:z.array(JevLessonSchema).max(38).optional(),rules:z.array(JevRuleSchema).max(1000),entries:z.array(JevReplayEntrySchema).max(50)});
export type JevReplayReport=z.infer<typeof JevReplayReportSchema>;
