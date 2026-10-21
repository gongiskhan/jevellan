import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { RenameConversationSchema } from './conversation-schemas.js';
import { SessionListPreferencesSchema, SessionListUpdateSchema } from './session-list-schemas.js';
import type { ConversationSidebarRow } from './conversation-sidebar-view.js';

const NativeRenameSchema = SessionListUpdateSchema.options[0], OrderSchema = SessionListUpdateSchema.options[1];
const KeySchema = NativeRenameSchema.shape.id;
export const ConversationSidebarDropRequestSchema = z.strictObject({schema:z.literal('conversation-sidebar-drop-v1'),revision:SessionListPreferencesSchema.shape.revision,id:KeySchema,target:KeySchema,after:z.boolean()});
export const ConversationSidebarDropViewSchema = z.strictObject({schema:z.literal('conversation-sidebar-drop-view-v1'),previewOrder:z.array(KeySchema),request:OrderSchema.nullable()});
export const ConversationSidebarDropResultSchema = z.strictObject({schema:z.literal('conversation-sidebar-drop-result-v1'),accepted:z.boolean(),previewOrder:z.array(KeySchema),preferences:SessionListPreferencesSchema});
export const ConversationSidebarRenameRequestSchema = z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('conversation-sidebar-rename-request-v1'),kind:z.literal('owner'),id:IdSchema,previousTitle:RenameConversationSchema.shape.previousTitle,title:RenameConversationSchema.shape.title,clientRequestId:RenameConversationSchema.shape.clientRequestId}),
 z.strictObject({schema:z.literal('conversation-sidebar-rename-request-v1'),kind:z.literal('native'),id:KeySchema,revision:SessionListPreferencesSchema.shape.revision,title:NativeRenameSchema.shape.title}),
]);
export const ConversationSidebarRenameViewSchema = z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('conversation-sidebar-rename-view-v1'),kind:z.literal('owner'),path:z.string(),request:RenameConversationSchema}),
 z.strictObject({schema:z.literal('conversation-sidebar-rename-view-v1'),kind:z.literal('native'),request:NativeRenameSchema}),
]);

/** Keep the complete optimistic preview separate from the bounded saved order. */
export function conversationSidebarDrop(rows:ReadonlyArray<Pick<ConversationSidebarRow,'id'>>,preferences:z.infer<typeof SessionListPreferencesSchema>,raw:unknown){
 const input=ConversationSidebarDropRequestSchema.parse(raw),saved=SessionListPreferencesSchema.parse(preferences),ids=rows.map(row=>row.id);
 if(input.id===input.target||!ids.includes(input.id)||!ids.includes(input.target))return ConversationSidebarDropViewSchema.parse({schema:'conversation-sidebar-drop-view-v1',previewOrder:ids,request:null});
 const order=ids.filter(id=>id!==input.id);order.splice(order.indexOf(input.target)+Number(input.after),0,input.id);
 return ConversationSidebarDropViewSchema.parse({schema:'conversation-sidebar-drop-view-v1',previewOrder:order,request:{schema:'session-list-update-v1',revision:input.revision,operation:'order',order:[...order,...saved.order.filter(id=>!order.includes(id))].slice(0,10000)}});
}
export const conversationSidebarCanRename=(title:string)=>!!title.trim();

/** Resource kind comes from the canonical row; writers retain their own revision/title checks. */
export function conversationSidebarRename(target:Pick<ConversationSidebarRow,'id'|'title'|'cursor'>,title:string,clientRequestId:string,preferences:z.infer<typeof SessionListPreferencesSchema>){
 return target.cursor?ConversationSidebarRenameViewSchema.parse({schema:'conversation-sidebar-rename-view-v1',kind:'native',request:{schema:'session-list-update-v1',revision:preferences.revision,operation:'rename',id:target.id,title}})
  :ConversationSidebarRenameViewSchema.parse({schema:'conversation-sidebar-rename-view-v1',kind:'owner',path:`/api/conversations/${IdSchema.parse(target.id)}/rename`,request:{schema:'rename-conversation-v1',clientRequestId,previousTitle:target.title,title}});
}
