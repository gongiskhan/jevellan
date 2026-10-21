import{z}from'zod';
import{IdSchema}from'./schemas.js';
import{ComposerInitialSchema}from'./composer-schemas.js';
import{StartConversationSchema}from'./conversation-schemas.js';
export const ConversationCreationPendingSchema=z.strictObject({schema:z.literal('conversation-creation-pending-v1'),signature:z.string().min(1),id:IdSchema,clientMessageId:IdSchema});
export const ConversationCreationIntentSchema=z.strictObject({schema:z.literal('conversation-creation-intent-v1'),projectId:IdSchema,message:StartConversationSchema.shape.message,choices:ComposerInitialSchema.default(()=>ComposerInitialSchema.parse({schema:'composer-initial-v1',once:{},pins:{}})),previous:ConversationCreationPendingSchema.optional()});
export const ConversationCreationDraftSchema=z.strictObject({schema:z.literal('conversation-creation-draft-v1'),pending:ConversationCreationPendingSchema,request:StartConversationSchema.nullable(),refusal:z.string().nullable()});
export type ConversationCreationPending=z.infer<typeof ConversationCreationPendingSchema>;

/** Exact raw form signature; an unsuccessful title still retains the pending id pair for retries. */
export function conversationCreationDraft(raw:unknown,mintId:()=>string,fingerprint:(signature:string)=>string){
 const input=ConversationCreationIntentSchema.parse(raw),rawChoices=(raw as {choices?:unknown}).choices??input.choices;
 const signature=fingerprint(JSON.stringify({projectId:input.projectId,message:input.message,choices:rawChoices}));
 const pending=input.previous?.signature===signature?input.previous:ConversationCreationPendingSchema.parse({schema:'conversation-creation-pending-v1',signature,id:`conversation_${mintId()}`,clientMessageId:`message_${mintId()}`});
 const request=StartConversationSchema.safeParse({schema:'start-conversation-v1',id:pending.id,clientMessageId:pending.clientMessageId,projectId:input.projectId,title:input.message.split('\n')[0]!.slice(0,100),message:input.message,...(Object.keys(input.choices.once).length||Object.keys(input.choices.pins).length?{choices:input.choices}:{})});
 return ConversationCreationDraftSchema.parse({schema:'conversation-creation-draft-v1',pending,request:request.success?request.data:null,refusal:request.success?null:'The first message line needs a title.'});
}
