import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {EmptySchema} from './client-schemas.js';
import {RenameConversationSchema,FinishOutsideSchema,type ConversationPublicSchema} from './conversation-schemas.js';
const kind=z.enum(['rename','finish']);
export const ConversationControlContextSchema=z.strictObject({schema:z.literal('conversation-control-context-v1'),projectId:IdSchema,conversationId:IdSchema,title:RenameConversationSchema.shape.previousTitle,generation:z.number().int().nonnegative()});
export const ConversationControlEditorRequestSchema=z.strictObject({schema:z.literal('conversation-control-editor-request-v1'),kind,context:ConversationControlContextSchema.optional()});
export const ConversationControlPendingSchema=z.strictObject({schema:z.literal('conversation-control-pending-v1'),kind,id:IdSchema,signature:z.string().regex(/^[a-f0-9]{64}$/u)});
export const ConversationControlDraftRequestSchema=z.strictObject({schema:z.literal('conversation-control-draft-request-v1'),kind,context:ConversationControlContextSchema,value:z.string().max(100_000),pending:ConversationControlPendingSchema.optional()});
export const ConversationControlCommandSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('conversation-control-command-v1'),operation:z.literal('rename'),body:RenameConversationSchema}),
 z.strictObject({schema:z.literal('conversation-control-command-v1'),operation:z.literal('finish'),body:FinishOutsideSchema}),
 z.strictObject({schema:z.literal('conversation-control-command-v1'),operation:z.literal('cancel'),body:EmptySchema}),
]);
export const ConversationControlEditorSchema=z.strictObject({schema:z.literal('conversation-control-editor-v1'),projectId:IdSchema,conversationId:IdSchema,kind,context:ConversationControlContextSchema,initialValue:z.string(),dialogTitle:z.string(),label:z.string(),maxLength:z.number().int().positive(),required:z.boolean(),multiline:z.boolean(),help:z.string().nullable(),optionalLabel:z.string().nullable(),submitLabel:z.string()});
export const ConversationControlPreviewSchema=z.strictObject({schema:z.literal('conversation-control-preview-v1'),value:z.string(),canSave:z.boolean()});
export const ConversationControlDraftSchema=z.strictObject({schema:z.literal('conversation-control-draft-v1'),projectId:IdSchema,conversationId:IdSchema,editor:ConversationControlEditorSchema,preview:ConversationControlPreviewSchema,pending:ConversationControlPendingSchema.nullable(),command:ConversationControlCommandSchema.nullable()});
type View=z.infer<typeof ConversationPublicSchema>;
export function conversationControlContext(view:View){return ConversationControlContextSchema.parse({schema:'conversation-control-context-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,title:view.conversation.title,generation:view.conversation.generation});}
/** A supplied snapshot stays original; canonical writers decide whether its request is stale or repeated. */
export function conversationControlEditor(view:View,raw:unknown){
 const input=ConversationControlEditorRequestSchema.parse(raw),context=input.context??conversationControlContext(view);
 if(context.projectId!==view.conversation.projectId||context.conversationId!==view.conversation.id)throw Object.assign(new Error('This editor belongs to another conversation or project.'),{status:409});
 const rename=input.kind==='rename',maxLength=rename?RenameConversationSchema.shape.title.maxLength:FinishOutsideSchema.shape.reason.unwrap().maxLength;
 return ConversationControlEditorSchema.parse({schema:'conversation-control-editor-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,kind:input.kind,context,initialValue:rename?context.title:'',dialogTitle:rename?'Rename conversation':'Finished outside Jevellan',label:rename?'Title':'What made you finish elsewhere?',maxLength,required:rename,multiline:!rename,help:rename?null:'This stops the active step and keeps repository changes. Kept changes remain available to settle.',optionalLabel:rename?null:'Optional',submitLabel:rename?'Save title':'Mark finished'});
}
export function conversationControlPreview(raw:unknown,value:string){const editor=ConversationControlEditorSchema.parse(raw),normalized=value.trim(),canSave=editor.kind==='rename'?RenameConversationSchema.shape.title.safeParse(normalized).success:!normalized||FinishOutsideSchema.shape.reason.unwrap().safeParse(normalized).success;return ConversationControlPreviewSchema.parse({schema:'conversation-control-preview-v1',value:normalized,canSave});}
export function conversationControlDraft(view:View,raw:unknown,mint:(prefix:'rename'|'finish')=>string,fingerprint:(value:string)=>string){
 const input=ConversationControlDraftRequestSchema.parse(raw),editor=conversationControlEditor(view,{schema:'conversation-control-editor-request-v1',kind:input.kind,context:input.context}),preview=conversationControlPreview(editor,input.value);let pending=input.pending??null,command:z.infer<typeof ConversationControlCommandSchema>|null=null;
 if(preview.canSave){const signature=fingerprint(preview.value);if(!pending||pending.kind!==input.kind||pending.signature!==signature)pending={schema:'conversation-control-pending-v1',kind:input.kind,id:mint(input.kind),signature};
  command=ConversationControlCommandSchema.parse(input.kind==='rename'?{schema:'conversation-control-command-v1',operation:'rename',body:{schema:'rename-conversation-v1',clientRequestId:pending.id,previousTitle:editor.context.title,title:preview.value}}:{schema:'conversation-control-command-v1',operation:'finish',body:{schema:'finish-outside-v1',clientRequestId:pending.id,generation:editor.context.generation,...(preview.value?{reason:preview.value}:{})}});
 }
 return ConversationControlDraftSchema.parse({schema:'conversation-control-draft-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,editor,preview,pending,command});
}
