import { ConversationSidebarDropRequestSchema, ConversationSidebarDropResultSchema, ConversationSidebarRenameRequestSchema, conversationSidebarDrop, conversationSidebarRename, sessionListView } from '@jevellan/core';
import {readSessionListPreferences,saveSessionListPreferences} from '@jevellan/conversations';
import type {Application} from './application.js';
import {ownerConversationSidebar} from './conversation-sidebar-view.js';
import {ownerConversationOperation} from './owner-proxy.js';
const fail=(message:string,status:number)=>Object.assign(new Error(message),{status});

export async function ownerConversationSidebarDrop(app:Application,raw:unknown,ownerToken?:string){
 const input=ConversationSidebarDropRequestSchema.parse(raw),preferences=readSessionListPreferences(app.homes),view=await ownerConversationSidebar(app,undefined,ownerToken);
 const prepared=conversationSidebarDrop(view.allRows,preferences,input),saved=prepared.request?saveSessionListPreferences(app.homes,prepared.request):preferences;
 return ConversationSidebarDropResultSchema.parse({schema:'conversation-sidebar-drop-result-v1',accepted:!!prepared.request,previewOrder:prepared.previewOrder,preferences:saved});
}
export async function ownerConversationSidebarRename(app:Application,raw:unknown,ownerToken?:string,projectId?:string){
 const input=ConversationSidebarRenameRequestSchema.parse(raw);
 if(input.kind==='owner'){
  const location=await app.conversations.location(input.id);
  const prepared=conversationSidebarRename({id:input.id,title:input.previousTitle,cursor:false},input.title,input.clientRequestId,readSessionListPreferences(app.homes));
  if(prepared.kind!=='owner')throw fail('This rename belongs to another resource.',409);
  return ownerConversationOperation(app,projectId??location.projectId,input.id,'rename',prepared.request,ownerToken);
 }
 const view=await ownerConversationSidebar(app,undefined,ownerToken),target=view.allRows.find(row=>row.id===input.id);
 if(!target)throw fail('This session is no longer in the list.',404);
 if(!target.cursor)throw fail('This rename belongs to another resource.',409);
 const preferences=readSessionListPreferences(app.homes),prepared=conversationSidebarRename(target,input.title,'unused_native_rename',{...preferences,revision:input.revision});
 if(prepared.kind!=='native')throw fail('This rename belongs to another resource.',409);
 return sessionListView(app.device.deviceId,saveSessionListPreferences(app.homes,prepared.request));
}
