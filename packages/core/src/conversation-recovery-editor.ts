import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ConversationChangesSchema,CheckpointReviewSchema,AdoptChangesSchema,RetryRedoSchema,type ConversationPublicSchema} from './conversation-schemas.js';
export const ConversationReviewedChangesSchema=z.strictObject({schema:z.literal('conversation-reviewed-changes-v1'),projectId:IdSchema.optional(),conversationId:IdSchema.optional(),stretch:z.number().int().positive(),recovery:CheckpointReviewSchema});
const reviewInput=z.union([ConversationReviewedChangesSchema,ConversationChangesSchema]);
export const ConversationRecoveryEditorRequestSchema=z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('conversation-recovery-editor-request-v1'),kind:z.literal('adopt'),changes:reviewInput}),
 z.strictObject({schema:z.literal('conversation-recovery-editor-request-v1'),kind:z.literal('redo'),id:IdSchema,generation:z.number().int().nonnegative().optional()}),
]);
export const ConversationRecoveryPendingSchema=z.strictObject({schema:z.literal('conversation-recovery-pending-v1'),kind:z.enum(['adopt','redo']),id:IdSchema,signature:z.string().regex(/^[a-f0-9]{64}$/u)});
export const ConversationRecoveryDraftRequestSchema=z.strictObject({schema:z.literal('conversation-recovery-draft-request-v1'),request:ConversationRecoveryEditorRequestSchema,pending:ConversationRecoveryPendingSchema.optional()});
export const ConversationRecoveryCommandSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('conversation-recovery-command-v1'),operation:z.literal('adopt'),body:AdoptChangesSchema}),
 z.strictObject({schema:z.literal('conversation-recovery-command-v1'),operation:z.literal('redo'),body:RetryRedoSchema}),
]);
export const ConversationRecoveryEditorSchema=z.strictObject({schema:z.literal('conversation-recovery-editor-v1'),projectId:IdSchema,conversationId:IdSchema,kind:z.enum(['adopt','redo']),request:ConversationRecoveryEditorRequestSchema,title:z.string(),text:z.string(),reason:z.string().nullable(),enabled:z.boolean(),submitLabel:z.string(),busyLabel:z.string(),refreshLabel:z.string().nullable()});
export const ConversationRecoveryDraftSchema=z.strictObject({schema:z.literal('conversation-recovery-draft-v1'),projectId:IdSchema,conversationId:IdSchema,editor:ConversationRecoveryEditorSchema,pending:ConversationRecoveryPendingSchema.nullable(),command:ConversationRecoveryCommandSchema.nullable()});
type View=z.infer<typeof ConversationPublicSchema>;
const conflict=(message:string)=>Object.assign(new Error(message),{status:409});
/** Only original review identity crosses the write-preparation boundary; displayed diffs stay in the reader. */
export function conversationRecoveryReview(raw:unknown){
 const changes=reviewInput.parse(raw);if(!changes.recovery)throw conflict('This step has no reviewed changes to accept.');
 return ConversationReviewedChangesSchema.parse({schema:'conversation-reviewed-changes-v1',projectId:changes.projectId,conversationId:changes.conversationId,stretch:changes.stretch,recovery:changes.recovery});
}
/** Adoption carries the review already displayed, never a newly read filesystem fingerprint. */
export function conversationRecoveryEditor(view:View,raw:unknown){
 const input=ConversationRecoveryEditorRequestSchema.parse(raw),common={schema:'conversation-recovery-editor-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id};
 if(input.kind==='adopt'){
  const changes=conversationRecoveryReview(input.changes),review=changes.recovery,step=view.stretches.find(entry=>entry.n===changes.stretch);
  if(changes.projectId!==undefined&&changes.projectId!==view.conversation.projectId||changes.conversationId!==undefined&&changes.conversationId!==view.conversation.id)throw conflict('These reviewed changes belong to another conversation or project.');
  if(!review||!step)throw conflict('This step has no reviewed changes to accept.');
  return ConversationRecoveryEditorSchema.parse({...common,kind:input.kind,request:{...input,changes},title:'Accept reviewed changes',text:review.mode==='acknowledge'?'Continue acknowledges the files shown here. This project follows its own Git rules; Jevellan will not commit or push these changes.':'Continue saves the files shown here as this work’s checkpoint. You can then choose the next step or publish after verification.',reason:review.reason??null,enabled:!view.busy&&!!review.fingerprint&&review.generation===view.conversation.generation,submitLabel:'Continue',busyLabel:'Accepting…',refreshLabel:'Refresh changes'});
 }
 const entry=view.redos.find(record=>record.id===input.id);if(!entry)throw conflict('This undo request is unavailable.');
 return ConversationRecoveryEditorSchema.parse({...common,kind:input.kind,request:{...input,generation:input.generation??view.conversation.generation},title:`Resume correction · step ${entry.fromStretch}`,text:'Completed undo changes are kept. A redo step that already started will not run twice.',reason:entry.reason??'Undo and redo did not finish.',enabled:true,submitLabel:'Retry undo and redo',busyLabel:'Resuming…',refreshLabel:null});
}
export function conversationRecoveryDraft(view:View,raw:unknown,mint:(prefix:'adopt'|'retry')=>string,fingerprint:(value:string)=>string){
 const input=ConversationRecoveryDraftRequestSchema.parse(raw),editor=conversationRecoveryEditor(view,input.request),request=editor.request;let pending=input.pending??null,command:z.infer<typeof ConversationRecoveryCommandSchema>|null=null;
 if(editor.enabled){
  const subject=request.kind==='adopt'?[request.kind,editor.projectId,editor.conversationId,view.stretches.find(step=>step.n===request.changes.stretch)!.workId,request.changes.stretch,request.changes.recovery!.fingerprint]:[request.kind,editor.projectId,editor.conversationId,request.id,request.generation];
  const signature=fingerprint(JSON.stringify(subject));if(!pending||pending.kind!==request.kind||pending.signature!==signature)pending={schema:'conversation-recovery-pending-v1',kind:request.kind,id:mint(request.kind==='adopt'?'adopt':'retry'),signature};
  command=ConversationRecoveryCommandSchema.parse(request.kind==='adopt'?{schema:'conversation-recovery-command-v1',operation:'adopt',body:{schema:'adopt-changes-v1',clientRequestId:pending.id,workId:view.stretches.find(step=>step.n===request.changes.stretch)!.workId,stretch:request.changes.stretch,generation:request.changes.recovery!.generation,fingerprint:request.changes.recovery!.fingerprint}}:{schema:'conversation-recovery-command-v1',operation:'redo',body:{schema:'retry-redo-v1',clientRequestId:pending.id,id:request.id,generation:request.generation}});
 }
 return ConversationRecoveryDraftSchema.parse({schema:'conversation-recovery-draft-v1',projectId:editor.projectId,conversationId:editor.conversationId,editor,pending,command});
}
