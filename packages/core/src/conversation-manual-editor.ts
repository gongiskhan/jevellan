import {z} from 'zod';
import {IdSchema,EffortSchema,type Configuration} from './schemas.js';
import {ManualStepSchema,type ConversationPublicSchema} from './conversation-schemas.js';
import {conversationActionLabel} from './conversation-page-view.js';
const action=ManualStepSchema.shape.action;
export const ConversationManualContextSchema=z.strictObject({schema:z.literal('conversation-manual-context-v1'),projectId:IdSchema,conversationId:IdSchema,generation:z.number().int().nonnegative(),allowed:z.array(action)});
export const ConversationManualSelectionSchema=z.strictObject({schema:z.literal('conversation-manual-selection-v1'),action,model:z.union([IdSchema,z.literal('')]),effort:EffortSchema,remember:z.boolean()});
export const ConversationManualEditorSchema=z.strictObject({schema:z.literal('conversation-manual-editor-v1'),projectId:IdSchema,conversationId:IdSchema,context:ConversationManualContextSchema,models:z.array(z.strictObject({id:IdSchema,label:z.string()})),actions:z.array(z.strictObject({value:action,label:z.string()})),efforts:z.array(EffortSchema),labels:z.strictObject({title:z.string(),action:z.string(),model:z.string(),effort:z.string(),remember:z.string(),submit:z.string(),busy:z.string()}),defaults:ConversationManualSelectionSchema,resetKey:z.string().min(1)});
export const ConversationManualPreviewSchema=z.strictObject({schema:z.literal('conversation-manual-preview-v1'),chosen:action.nullable(),canSubmit:z.boolean(),modelDisabled:z.boolean(),effortDisabled:z.boolean(),showRemember:z.boolean(),body:ManualStepSchema.nullable()});
export const ConversationManualDraftRequestSchema=z.strictObject({schema:z.literal('conversation-manual-draft-request-v1'),context:ConversationManualContextSchema,selection:ConversationManualSelectionSchema});
export const ConversationManualCommandSchema=z.strictObject({schema:z.literal('conversation-manual-command-v1'),body:ManualStepSchema});
export const ConversationManualDraftSchema=z.strictObject({schema:z.literal('conversation-manual-draft-v1'),projectId:IdSchema,conversationId:IdSchema,preview:ConversationManualPreviewSchema,command:ConversationManualCommandSchema.nullable()});
type View=z.infer<typeof ConversationPublicSchema>;
/** Manual selection preserves its established defaults and stricter plan-wait presentation. */
export function conversationManualEditor(view:View,settings:Configuration['x-jevellan']){
 const {once,pins,current}=view.conversation,models=settings.menu.filter(model=>model.enabled&&settings.runtimes[model.runtime]?.enabled),model=[once.modelId,pins.modelId,current?.modelId].find(id=>models.some(entry=>entry.id===id))??models[0]?.id??'';
 const waiting=settings.guards.pauseAfterPlan&&view.conversation.work?.latestPlanRef&&view.conversation.work.approvedPlanRef!==view.conversation.work.latestPlanRef,allowed=view.allowed.filter(entry=>!waiting||entry==='plan');
 const context={schema:'conversation-manual-context-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,generation:view.conversation.generation,allowed};
 return ConversationManualEditorSchema.parse({schema:'conversation-manual-editor-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,context,models:models.map(entry=>({id:entry.id,label:entry.label})),actions:allowed.map(value=>({value,label:conversationActionLabel(value)})),efforts:EffortSchema.options,labels:{title:'Pick the next step',action:'Action',model:'Model',effort:'Effort',remember:'This request explicitly asks to remember something.',submit:'Continue',busy:'Starting…'},defaults:{schema:'conversation-manual-selection-v1',action:once.action??'reply',model,effort:once.effort??pins.effort??current?.effort??'high',remember:false},resetKey:JSON.stringify([once.action,once.modelId,once.effort,pins.modelId,pins.effort])});
}
/** This is preparation over the captured click context; canonical manual admission remains authoritative. */
export function conversationManualPreview(rawContext:unknown,rawSelection:unknown){
 const context=ConversationManualContextSchema.parse(rawContext),selection=ConversationManualSelectionSchema.parse(rawSelection),chosen=context.allowed.includes(selection.action)?selection.action:context.allowed[0]??null,canSubmit=chosen!==null&&(chosen==='done'||!!selection.model);
 return ConversationManualPreviewSchema.parse({schema:'conversation-manual-preview-v1',chosen,canSubmit,modelDisabled:chosen==='done',effortDisabled:chosen==='done',showRemember:chosen==='reply',body:canSubmit?{schema:'manual-step-v1',generation:context.generation,action:chosen,...(selection.model?{modelId:selection.model}:{}),effort:selection.effort,remember:selection.remember}:null});
}
export function conversationManualDraft(view:View,raw:unknown){
 const input=ConversationManualDraftRequestSchema.parse(raw),context=input.context;
 if(context.projectId!==view.conversation.projectId||context.conversationId!==view.conversation.id)throw Object.assign(new Error('This manual choice belongs to another conversation or project.'),{status:409});
 const preview=conversationManualPreview(context,input.selection);
 return ConversationManualDraftSchema.parse({schema:'conversation-manual-draft-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,preview,command:preview.body?{schema:'conversation-manual-command-v1',body:preview.body}:null});
}
