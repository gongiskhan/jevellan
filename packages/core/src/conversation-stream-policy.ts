import {z} from 'zod';
import {IdSchema,LedgerEventSchema,type LedgerEvent} from './schemas.js';
import {ConversationEventSchema} from './conversation-schemas.js';
import {ConversationStatusEventSchema,STATUS_REFRESH_WINDOW_MS} from './status-stream.js';

export const ConversationStreamPolicySchema=z.strictObject({schema:z.literal('conversation-stream-policy-v1'),refreshWindowMs:z.literal(STATUS_REFRESH_WINDOW_MS),duplicate:z.literal('first-id-wins'),order:z.literal('ascending'),malformed:z.literal('close'),statusRequiresInitialView:z.literal(true)});
export const ConversationStreamFrameSchema=z.strictObject({schema:z.literal('conversation-stream-frame-v1'),event:LedgerEventSchema,refreshWindowMs:z.literal(STATUS_REFRESH_WINDOW_MS)});
export const ConversationStreamRequestSchema=z.strictObject({schema:z.literal('conversation-stream-request-v1'),afterId:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(64).default(64)});
export const ConversationStreamSourceSchema=z.strictObject({schema:z.literal('conversation-stream-source-v1'),projectId:IdSchema,conversationId:IdSchema,request:ConversationStreamRequestSchema,policy:ConversationStreamPolicySchema,head:z.number().int().nonnegative(),events:z.array(LedgerEventSchema).max(64),nextAfterId:z.number().int().nonnegative(),hasMore:z.boolean()});

export function conversationStreamPolicy(){return ConversationStreamPolicySchema.parse({schema:'conversation-stream-policy-v1',refreshWindowMs:STATUS_REFRESH_WINDOW_MS,duplicate:'first-id-wins',order:'ascending',malformed:'close',statusRequiresInitialView:true});}
export function conversationStreamRequest(raw:unknown={schema:'conversation-stream-request-v1'}){return ConversationStreamRequestSchema.parse(raw);}
const wire=(raw:unknown):unknown=>typeof raw==='string'?JSON.parse(raw):raw;
export function conversationStreamFrame(raw:unknown){const value=ConversationEventSchema.parse(wire(raw));return ConversationStreamFrameSchema.parse({schema:'conversation-stream-frame-v1',event:value.event,refreshWindowMs:STATUS_REFRESH_WINDOW_MS});}

/** Duplicate delivery retains the first value and original array identity, as before. */
export function conversationStreamEvents(previous:LedgerEvent[],event:LedgerEvent){return previous.some(row=>row.id===event.id)?previous:[...previous,event].sort((a,b)=>a.id-b.id);}
export function conversationStreamStatusView(raw:unknown,context:{conversationId:string;initialReady:boolean;stopped:boolean}){
 if(context.stopped||!context.initialReady)return null;
 const value=ConversationStatusEventSchema.parse(wire(raw));return value.view.conversation.id===context.conversationId?value.view:null;
}

/** Facts contain only the bounded canonical ledger page; no browser history is posted back. */
export function conversationStreamSource(facts:{projectId:string;conversationId:string;head:number;events:readonly LedgerEvent[]},raw:unknown){
 const request=conversationStreamRequest(raw);if(request.afterId>facts.head)throw Object.assign(new Error('Conversation event cursor is ahead of its history.'),{status:400});
 const events=facts.events.filter(event=>event.id>request.afterId).slice(0,request.limit),nextAfterId=events.at(-1)?.id??request.afterId;
 return ConversationStreamSourceSchema.parse({schema:'conversation-stream-source-v1',projectId:facts.projectId,conversationId:facts.conversationId,request,policy:conversationStreamPolicy(),head:facts.head,events,nextAfterId,hasMore:nextAfterId<facts.head});
}
