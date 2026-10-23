import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {JevLessonSchema,JevPromptVersionSchema,JevProposalSchema,JevRuleSchema} from './jev-control-schemas.js';

export const JevRuleDraftSchema=z.strictObject({schema:z.literal('jev-rule-draft-v1'),id:z.string(),scope:z.enum(['global','project']),enabled:z.boolean(),taskType:z.string().max(40),goal:z.string().max(200),label:z.string().max(200),keywords:z.string().max(1300),minModel:z.string().max(120),minEffort:z.string().max(20),maxEffort:z.string().max(20),account:z.string().max(120),runtime:z.string().max(40),landingRoute:z.string().max(40),note:z.string().max(400)});
export const JevControlOperationSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('rule_set'),draft:JevRuleDraftSchema}),
 z.strictObject({kind:z.literal('rule_remove'),rule:JevRuleSchema.shape.id}),
 z.strictObject({kind:z.literal('prompt_propose'),name:z.string().min(1).max(40),text:JevPromptVersionSchema.shape.text,summary:z.string().trim().min(1).max(400)}),
 z.strictObject({kind:z.literal('prompt_apply'),proposal:JevProposalSchema.shape.id}),
 z.strictObject({kind:z.literal('prompt_rollback'),name:z.string().min(1).max(40),version:z.number().int().positive()}),
 z.strictObject({kind:z.literal('lesson_edit'),lesson:JevLessonSchema.shape.id,text:JevLessonSchema.shape.text,enabled:z.boolean()}),
 z.strictObject({kind:z.literal('lesson_remove'),lesson:JevLessonSchema.shape.id}),
 z.strictObject({kind:z.literal('replay_lesson'),lesson:JevLessonSchema.shape.id,n:z.number().int().min(1).max(50)}),
 z.strictObject({kind:z.literal('replay_proposal'),proposal:JevProposalSchema.shape.id,n:z.number().int().min(1).max(50)}),
]);
export const JevControlCommandSchema=z.strictObject({schema:z.literal('jev-control-command-v1'),projectId:IdSchema,command:JevControlOperationSchema});
const action=z.strictObject({label:z.string(),command:JevControlOperationSchema,disabled:z.boolean()});
const field=z.strictObject({key:JevRuleDraftSchema.keyof(),label:z.string(),kind:z.enum(['text','textarea','select','checkbox']),options:z.array(z.strictObject({value:z.string(),label:z.string()})),maxLength:z.number().int().positive().optional()});
export const JevControlWorkspaceSchema=z.strictObject({schema:z.literal('jev-control-workspace-v1'),projectId:IdSchema,projectName:z.string(),projectLabel:z.string(),projects:z.array(z.strictObject({id:IdSchema,name:z.string()})),title:z.string(),intro:z.string(),resultLabel:z.string(),emptyRules:z.string(),emptyLessons:z.string(),ruleDraft:JevRuleDraftSchema,ruleFields:z.array(field),newRuleLabel:z.string(),ruleSaveLabel:z.string(),promptsTitle:z.string(),rulesTitle:z.string(),lessonsTitle:z.string(),
 rules:z.array(z.strictObject({id:JevRuleSchema.shape.id,title:z.string(),description:z.string(),draft:JevRuleDraftSchema,remove:action})),
 prompts:z.array(z.strictObject({name:z.string(),title:z.string(),text:z.string(),activeVersion:z.number().int().positive(),propose:action,summaryLabel:z.string(),textLabel:z.string(),historyLabel:z.string(),history:z.array(z.strictObject({version:z.number().int().positive(),label:z.string(),rollback:action})),proposals:z.array(z.strictObject({id:JevProposalSchema.shape.id,title:z.string(),diff:z.string(),replay:z.string(),apply:action,replayAction:action}))})),
 lessons:z.array(z.strictObject({id:JevLessonSchema.shape.id,title:z.string(),text:z.string(),enabled:z.boolean(),description:z.string(),textLabel:z.string(),enabledLabel:z.string(),edit:action,remove:action,replay:action})),
 endpoint:z.literal('/api/jev/control'),method:z.literal('POST'),
});
export const JevControlResultSchema=z.strictObject({schema:z.literal('jev-control-result-v1'),view:JevControlWorkspaceSchema,notice:z.string(),promptDrafts:z.array(z.strictObject({name:z.string(),text:z.string()})).optional(),ruleDraft:JevRuleDraftSchema.optional()});
export type JevRuleDraft=z.infer<typeof JevRuleDraftSchema>;
export type JevControlWorkspace=z.infer<typeof JevControlWorkspaceSchema>;
export type JevControlCommand=z.infer<typeof JevControlCommandSchema>;
export type JevControlOperation=z.infer<typeof JevControlOperationSchema>;
export type JevControlResult=z.infer<typeof JevControlResultSchema>;

export const JevControlEmptySchema=z.strictObject({schema:z.literal('jev-control-empty-v1'),title:z.string(),emptyText:z.string()});
export const JevControlReadSchema=z.discriminatedUnion('schema',[JevControlWorkspaceSchema,JevControlEmptySchema]);
export type JevControlRead=z.infer<typeof JevControlReadSchema>;
export function emptyJevControl(){return JevControlEmptySchema.parse({schema:'jev-control-empty-v1',title:'Jev',emptyText:'Add a project in Projects to manage its Jev rules, prompts and lessons.'});}
