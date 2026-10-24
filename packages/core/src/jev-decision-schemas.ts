import {z} from 'zod';
import {AccountSchema,AccountStatusSchema,ConfigurationSettingsSchema,DeviceFactsSchema,DeviceTagsSchema,EffortSchema,IdSchema,JevCallSchema,ProjectSchema,TimestampSchema} from './schemas.js';
import {DevicePresenceSchema} from './mesh-schemas.js';
import {PlacementConstraintsSchema} from './project-parity-schemas.js';
import {JevPromptVersionSchema,PlacementRuleContextSchema,PlacementRawChoiceSchema,ProjectJevPolicySchema} from './jev-control-schemas.js';
const isolation=z.enum(['main','worktree']);
export const PlacementReplayEnvironmentSchema=z.strictObject({
 schema:z.literal('placement-replay-environment-v1'),settings:ConfigurationSettingsSchema,project:ProjectSchema,defaultIsolation:isolation,
 constraints:PlacementConstraintsSchema.optional(),projectGuidance:z.string().optional(),reason:z.enum(['start','follow-up','account-limit','model-unavailable','escalation']).optional(),minimumEffort:EffortSchema.optional(),excludedModels:z.record(z.string(),z.string()).optional(),continuity:z.strictObject({modelId:IdSchema,effort:EffortSchema,accountId:IdSchema}).optional(),
 runtimes:z.array(z.tuple([IdSchema,z.strictObject({mcp:z.boolean(),readOnlyEnforced:z.boolean(),edit:z.boolean(),shell:z.boolean(),turns:z.boolean(),displayName:z.string()})])).max(200),accounts:z.array(AccountSchema).max(2000),statuses:z.array(AccountStatusSchema).max(5000),
 devices:z.array(z.strictObject({id:IdSchema,name:z.string(),status:DevicePresenceSchema,revoked:z.boolean(),hasPath:z.boolean(),allowed:z.boolean(),running:z.number().int().nonnegative(),isCoordinator:z.boolean(),checkoutBranch:z.string().optional(),tags:DeviceTagsSchema.optional(),facts:DeviceFactsSchema.optional(),mainBlockedBy:z.string().optional(),runtimeRefusals:z.record(IdSchema,z.string().max(1000)).optional()})).max(200),
 maxRunningPerDevice:z.number().int().positive(),perDeviceLimits:z.record(IdSchema,z.number().int().positive()).optional(),needs:DeviceTagsSchema.optional(),ignoreRunningLimit:z.boolean(),deviceId:IdSchema,coordinatorDeviceId:IdSchema,gates:z.strictObject({mainIsolation:z.boolean(),remoteDevices:z.boolean()}),
 fixed:z.strictObject({isolation:isolation.optional(),runtimeId:IdSchema.optional(),accountId:IdSchema.optional(),modelId:IdSchema.optional(),effort:EffortSchema.optional(),deviceId:IdSchema.optional()}),now:z.number().finite(),
});
export const PlacementDecisionInputsSchema=z.strictObject({schema:z.literal('placement-decision-inputs-v1'),state:z.string().max(100000),environment:PlacementReplayEnvironmentSchema,policy:ProjectJevPolicySchema,prompt:JevPromptVersionSchema.optional(),ruleContext:PlacementRuleContextSchema.optional()});
export type PlacementDecisionInputs=z.infer<typeof PlacementDecisionInputsSchema>;
export const JevPlacementDecisionSchema=z.strictObject({schema:z.literal('jev-placement-decision-v1'),id:IdSchema,projectId:IdSchema,deviceId:IdSchema,threadId:IdSchema.optional(),at:TimestampSchema,questionSet:z.literal('p-v1'),promptVersion:z.number().int().positive().nullable(),promptSource:z.enum(['code','versioned']),title:z.string().max(1200),source:z.enum(['jev','fallback','fixed']),rawChoice:PlacementRawChoiceSchema,finalChoice:PlacementRawChoiceSchema.nullable(),refusal:z.string().max(4000).nullable(),rulesApplied:z.array(z.string()).max(1000),reason:z.string().max(4000),inputs:PlacementDecisionInputsSchema,calls:z.array(JevCallSchema),overrideModes:z.array(z.enum(['override_undo','override_only'])).optional(),overriddenBy:IdSchema.optional(),gitRef:z.string().regex(/^[a-f0-9]{40,64}$/u).optional()}).refine(row=>row.finalChoice!==null||!!row.refusal,{message:'A refused placement needs its refusal.'});
export type JevPlacementDecision=z.infer<typeof JevPlacementDecisionSchema>;
export const JevDecisionPageSchema=z.strictObject({schema:z.literal('jev-decision-page-v1'),projectId:IdSchema,deviceId:IdSchema,records:z.array(JevPlacementDecisionSchema).max(100),next:IdSchema.nullable()});
export const JEV_DECISION_PAGE_BYTES=1_000_000;
export const JevDecisionPageRequestSchema=z.strictObject({schema:z.literal('jev-decision-page-request-v1'),after:IdSchema.optional()});
const decisionRead={schema:z.literal('jev-decision-read-request-v1'),projectId:IdSchema,deviceId:IdSchema};
export const JevDecisionReadRequestSchema=z.discriminatedUnion('operation',[
 z.strictObject({...decisionRead,operation:z.literal('page'),after:IdSchema.optional()}),
 z.strictObject({...decisionRead,operation:z.literal('read'),id:IdSchema}),
]);
