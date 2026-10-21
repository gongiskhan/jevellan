import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ConversationMessageSchema,ResumeDecisionSchema,RetryExternalActivitySchema,type ConversationPublicSchema} from './conversation-schemas.js';
import {conversationControlsView} from './conversation-controls-view.js';
export const ConversationMessagePendingSchema=z.discriminatedUnion('mode',[
 z.strictObject({schema:z.literal('conversation-message-pending-v1'),mode:z.literal('compose'),id:IdSchema}),
 z.strictObject({schema:z.literal('conversation-message-pending-v1'),mode:z.literal('resend'),id:IdSchema,signature:z.string().regex(/^[a-f0-9]{64}$/u)}),
]);
const text=z.string().max(100_000),eventId=z.number().int().positive();
export const ConversationMessageDraftRequestSchema=z.strictObject({schema:z.literal('conversation-message-draft-request-v1'),pending:ConversationMessagePendingSchema.optional(),intent:z.discriminatedUnion('mode',[
 z.strictObject({mode:z.literal('compose'),kind:z.enum(['message','note']).default('message'),text}),
 z.strictObject({mode:z.literal('resend'),eventId,text}),z.strictObject({mode:z.literal('retry'),eventId,text}),
 z.strictObject({mode:z.literal('answer'),option:z.number().int().min(0).max(3)}),
])});
export const ConversationMessageCommandSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('conversation-message-command-v1'),operation:z.literal('message'),body:ConversationMessageSchema}),
 z.strictObject({schema:z.literal('conversation-message-command-v1'),operation:z.literal('resume'),body:ResumeDecisionSchema}),
 z.strictObject({schema:z.literal('conversation-message-command-v1'),operation:z.literal('retry-external'),body:RetryExternalActivitySchema}),
]);
export const ConversationMessageEditorSchema=z.strictObject({schema:z.literal('conversation-message-editor-v1'),canSend:z.boolean(),canSendEdited:z.boolean()});
export const ConversationMessageDraftSchema=z.strictObject({schema:z.literal('conversation-message-draft-v1'),projectId:IdSchema,conversationId:IdSchema,pending:ConversationMessagePendingSchema.nullable(),command:ConversationMessageCommandSchema.nullable(),editor:ConversationMessageEditorSchema});
type View=z.infer<typeof ConversationPublicSchema>;
export function conversationMessageEditor(view:View,value:string){const controls=conversationControlsView(view),nonblank=!!value.trim();return ConversationMessageEditorSchema.parse({schema:'conversation-message-editor-v1',canSend:nonblank&&!controls.settlement.kept&&!controls.finishing,canSendEdited:nonblank&&controls.messageActions.canEdit});}
/** Prepares explicit owner intent; canonical writers still enforce admission and durable receipts. */
export function conversationMessageDraft(view:View,raw:unknown,mint:(prefix:'message'|'answer')=>string,fingerprint:(value:string)=>string){
 const input=ConversationMessageDraftRequestSchema.parse(raw),intent=input.intent;let pending=input.pending??null,command:z.infer<typeof ConversationMessageCommandSchema>|null=null;
 const value=intent.mode==='answer'?view.openQuestion?.options[intent.option]?.label??'':intent.text;
 const result=()=>ConversationMessageDraftSchema.parse({schema:'conversation-message-draft-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id,pending,command,editor:conversationMessageEditor(view,value)});
 if(intent.mode==='answer'){
  pending=null;const question=view.openQuestion,label=question?.options[intent.option]?.label;if(!question||!label)return result();
  command=ConversationMessageCommandSchema.parse({schema:'conversation-message-command-v1',operation:'message',body:{schema:'conversation-message-v1',clientMessageId:mint('answer'),text:label,kind:'message',answer:{stretch:question.stretch,option:intent.option}}});return result();
 }
 if(intent.mode==='retry'&&intent.eventId===view.messages.at(-1)?.id){
  if(view.decisionWait){command={schema:'conversation-message-command-v1',operation:'resume',body:{schema:'resume-decision-v1',generation:view.conversation.generation}};return result();}
  if(view.externalWait){command={schema:'conversation-message-command-v1',operation:'retry-external',body:{schema:'retry-external-activity-v1',waitId:view.externalWait.id,generation:view.conversation.generation}};return result();}
 }
 if(!intent.text.trim())return result();
 if(intent.mode==='compose'){
  if(pending?.mode!=='compose')pending={schema:'conversation-message-pending-v1',mode:'compose',id:mint('message')};
 }else{
  if(!view.messages.some(row=>row.id===intent.eventId))throw Object.assign(new Error('The recorded message is no longer available.'),{status:404});
  const signature=fingerprint(JSON.stringify({eventId:intent.eventId,text:intent.text}));
  if(pending?.mode!=='resend'||pending.signature!==signature)pending={schema:'conversation-message-pending-v1',mode:'resend',id:mint('message'),signature};
 }
 command=ConversationMessageCommandSchema.parse({schema:'conversation-message-command-v1',operation:'message',body:{schema:'conversation-message-v1',clientMessageId:ConversationMessagePendingSchema.parse(pending).id,text:intent.text,kind:intent.mode==='compose'?intent.kind:'message'}});return result();
}
