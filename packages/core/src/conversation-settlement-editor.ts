import {z} from 'zod';
import {IdSchema,type Project} from './schemas.js';
import {SettleWorkSchema,type ConversationPublicSchema} from './conversation-schemas.js';
const choice=SettleWorkSchema.shape.choice;
export const ConversationSettlementContextSchema=z.strictObject({schema:z.literal('conversation-settlement-context-v1'),projectId:IdSchema,conversationId:IdSchema,workId:IdSchema,generation:z.number().int().nonnegative()});
export const ConversationSettlementEditorRequestSchema=z.strictObject({schema:z.literal('conversation-settlement-editor-request-v1'),context:ConversationSettlementContextSchema.optional()});
export const ConversationSettlementPendingSchema=z.strictObject({schema:z.literal('conversation-settlement-pending-v1'),context:ConversationSettlementContextSchema,choice,id:IdSchema});
export const ConversationSettlementDraftRequestSchema=z.strictObject({schema:z.literal('conversation-settlement-draft-request-v1'),context:ConversationSettlementContextSchema,choice,pending:ConversationSettlementPendingSchema.optional()});
export const ConversationSettlementCommandSchema=z.strictObject({schema:z.literal('conversation-settlement-command-v1'),body:SettleWorkSchema});
export const ConversationSettlementEditorSchema=z.strictObject({schema:z.literal('conversation-settlement-editor-v1'),projectId:IdSchema,conversationId:IdSchema,context:ConversationSettlementContextSchema,title:z.string(),intro:z.string(),choices:z.array(z.strictObject({choice,label:z.string(),description:z.string().nullable(),secondary:z.boolean(),confirm:z.boolean()})),confirmation:z.strictObject({title:z.string(),paragraphs:z.array(z.string()),submitLabel:z.string(),backLabel:z.string()}).nullable()});
export const ConversationSettlementDraftSchema=z.strictObject({schema:z.literal('conversation-settlement-draft-v1'),projectId:IdSchema,conversationId:IdSchema,editor:ConversationSettlementEditorSchema,pending:ConversationSettlementPendingSchema,command:ConversationSettlementCommandSchema});
type View=z.infer<typeof ConversationPublicSchema>;
const conflict=(message:string)=>Object.assign(new Error(message),{status:409});
export function conversationSettlementContext(view:View,workId?:string){
 const target=view.conversation.work??view.closedWorks.at(-1);
 if(!target||workId!==undefined&&target.id!==workId)throw conflict('Choose the open work or the last cancelled or closed work.');
 return ConversationSettlementContextSchema.parse({schema:'conversation-settlement-context-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,workId:target.id,generation:view.conversation.generation});
}
/** Preserve the originally displayed target; canonical settlement owns admission and repeated receipts. */
export function conversationSettlementEditor(view:View,project:Pick<Project,'id'|'branchPolicy'>,raw:unknown){
 const input=ConversationSettlementEditorRequestSchema.parse(raw),context=input.context??conversationSettlementContext(view);
 if(project.id!==view.conversation.projectId||context.projectId!==view.conversation.projectId||context.conversationId!==view.conversation.id)throw conflict('This settlement belongs to another conversation or project.');
 const external=project.branchPolicy==='external';
 return ConversationSettlementEditorSchema.parse({schema:'conversation-settlement-editor-v1',projectId:project.id,conversationId:view.conversation.id,context,title:'Close this work',intro:external?'This project follows its own git rules. Its files stay as they are.':'Choose what happens to this work’s unpublished changes.',choices:external?[{choice:'keep',label:'Close and keep changes',description:null,secondary:false,confirm:false}]:[
  {choice:'publish',label:'Publish',description:'Verify the final checkpoint, bring in newer work from main, and publish.',secondary:false,confirm:false},
  {choice:'keep',label:'Keep them',description:'Close the work and keep its changes. The checkout stays reserved while changes remain unsettled.',secondary:true,confirm:false},
  {choice:'discard',label:'Discard…',description:'Save a recovery ref, then reset unpublished checkpoints.',secondary:true,confirm:true},
 ],confirmation:external?null:{title:'Discard this work',paragraphs:['This resets this work’s unpublished code and memory checkpoints to where the work started. A recovery ref is saved first. Uncommitted files must be checkpointed before they can be discarded.','Anything outside the repository, such as databases, deployments or messages sent, is not undone.'],submitLabel:'Discard checkpoints',backLabel:'Back'}});
}
export function conversationSettlementDraft(view:View,project:Pick<Project,'id'|'branchPolicy'>,raw:unknown,mint:()=>string){
 const input=ConversationSettlementDraftRequestSchema.parse(raw),editor=conversationSettlementEditor(view,project,{schema:'conversation-settlement-editor-request-v1',context:input.context});
 if(!editor.choices.some(option=>option.choice===input.choice))throw conflict('This project follows its own git rules. Close it keeping its changes.');
 const prior=input.pending,c=editor.context,matching=prior&&prior.choice===input.choice&&prior.context.projectId===c.projectId&&prior.context.conversationId===c.conversationId&&prior.context.workId===c.workId&&prior.context.generation===c.generation;
 const pending=matching?prior:ConversationSettlementPendingSchema.parse({schema:'conversation-settlement-pending-v1',context:c,choice:input.choice,id:mint()});
 return ConversationSettlementDraftSchema.parse({schema:'conversation-settlement-draft-v1',projectId:project.id,conversationId:view.conversation.id,editor,pending,command:{schema:'conversation-settlement-command-v1',body:{schema:'settle-work-v1',clientRequestId:pending.id,workId:c.workId,generation:c.generation,choice:input.choice}}});
}
