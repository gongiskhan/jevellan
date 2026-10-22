import {AgentAccessCreateSchema,AgentAccessRevokeRequestSchema,AgentAccessEditorViewSchema,agentAccessEditorView,agentAccessSetup} from '@jevellan/core';
import {UiAuth} from '@jevellan/mesh';
import type {Application} from './application.js';

/** Trusted owner transports use a short-lived session; the normal browser supplies its verified session. */
async function withSession<T>(app:Application,ownerSession:string|undefined,run:(session:string)=>Promise<T>):Promise<T>{
 if(ownerSession!==undefined)return run(ownerSession);
 if(!(app.auth instanceof UiAuth))throw Object.assign(Error('Owner tools must run on the state point.'),{status:409});
 const session=app.auth.issue();app.redactor.add(session);try{return await run(session);}finally{app.auth.logout(session);}
}
export async function readAgentAccessEditor(app:Application,ownerSession?:string,gatewayDeviceId=app.device.deviceId){
 let origin=app.device.url;
 if(gatewayDeviceId!==app.device.deviceId){const row=(await app.roster()).devices.find(row=>row.device.id===gatewayDeviceId&&!row.revoked);if(!row)throw Object.assign(Error('The requesting device is no longer available.'),{status:409});origin=row.device.url;}
 return withSession(app,ownerSession,async session=>{
  const [connections,projects]=await Promise.all([app.agentAccess.list(session),app.state.projects.list()]);
  return agentAccessEditorView({schema:'agent-access-editor-facts-v1',connections,projects:projects.map(row=>({id:row.project.id,name:row.project.name})),mcpUrl:`${origin.replace(/\/$/,'')}/mcp`,now:Date.now()});
 });
}
export async function createAgentAccess(app:Application,raw:unknown,ownerSession?:string){
 const input=AgentAccessCreateSchema.parse(raw);return withSession(app,ownerSession,session=>app.agentAccess.create(input,session));
}
export async function revokeAgentAccess(app:Application,raw:unknown,ownerSession?:string){
 const input=AgentAccessRevokeRequestSchema.parse(raw);return withSession(app,ownerSession,session=>app.agentAccess.revoke(input.connectionId,session));
}

/** Rebuild fixed nonfunctional placeholders after redaction, never restore supplied snippet content. */
export function agentAccessEditorReply(app:Application,raw:unknown){
 const safe=AgentAccessEditorViewSchema.parse(app.redactor.document(AgentAccessEditorViewSchema.parse(raw)));
 return AgentAccessEditorViewSchema.parse({...safe,setup:agentAccessSetup(safe.mcpUrl)});
}
