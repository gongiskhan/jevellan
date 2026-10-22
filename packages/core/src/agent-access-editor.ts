import {z} from 'zod';
import {IdSchema,TimestampSchema} from './schemas.js';
import {AgentAccessCreateSchema,AgentAccessCreatedSchema,AgentConnectionSchema} from './agent-access-schemas.js';

export const AgentAccessDraftSchema=z.strictObject({schema:z.literal('agent-access-draft-v1'),label:z.string().max(120),scope:z.enum(['all','selected']),selected:z.array(IdSchema).max(1000).refine(ids=>new Set(ids).size===ids.length,'Choose each project once.'),lifetime:z.enum(['1','7','30','never'])});
export type AgentAccessDraft=z.infer<typeof AgentAccessDraftSchema>;
const ProjectChoiceSchema=z.strictObject({id:IdSchema,name:z.string()});
export const AgentAccessEditorFactsSchema=z.strictObject({schema:z.literal('agent-access-editor-facts-v1'),connections:z.array(AgentConnectionSchema),projects:z.array(ProjectChoiceSchema),mcpUrl:z.url(),now:z.number().finite()});
export const AgentAccessEditorViewSchema=z.strictObject({schema:z.literal('agent-access-editor-view-v1'),observedAt:TimestampSchema,mcpUrl:z.url(),projects:z.array(ProjectChoiceSchema),defaults:AgentAccessDraftSchema,
 scopes:z.array(z.strictObject({value:z.enum(['all','selected']),label:z.string()})),lifetimes:z.array(z.strictObject({value:AgentAccessDraftSchema.shape.lifetime,label:z.string()})),
 rows:z.array(z.strictObject({connection:AgentConnectionSchema,status:z.enum(['Active','Expired','Revoked']),scopeLabel:z.string(),canRevoke:z.boolean()})),
 setup:z.strictObject({http:z.string(),stdio:z.string()})});
export type AgentAccessEditorView=z.infer<typeof AgentAccessEditorViewSchema>;
export const AgentAccessRevokeRequestSchema=z.strictObject({schema:z.literal('agent-access-revoke-request-v1'),connectionId:IdSchema});
export const AgentAccessAttemptSchema=z.strictObject({schema:z.literal('agent-access-attempt-v1'),id:IdSchema,fingerprint:z.string().max(256000),request:AgentAccessCreateSchema}).refine(value=>value.id===value.request.clientRequestId,'The request belongs to another attempt.');
export type AgentAccessAttempt=z.infer<typeof AgentAccessAttemptSchema>;

export function agentAccessDefaults():AgentAccessDraft{return AgentAccessDraftSchema.parse({schema:'agent-access-draft-v1',label:'',scope:'all',selected:[],lifetime:'30'});}

export function agentAccessSetup(mcpUrl:string){
 const url=z.url().parse(mcpUrl);
 return {http:JSON.stringify({mcpServers:{jevellan:{url,headers:{Authorization:'Bearer <connection token>'}}}},null,2),
  stdio:JSON.stringify({mcpServers:{jevellan:{command:'jevellan',args:['mcp-server'],env:{JEVELLAN_MCP_URL:url,JEVELLAN_MCP_TOKEN:'<connection token>'}}}},null,2)};
}
export function agentAccessEditorView(raw:unknown):AgentAccessEditorView{
 const facts=AgentAccessEditorFactsSchema.parse(raw);
 return AgentAccessEditorViewSchema.parse({schema:'agent-access-editor-view-v1',observedAt:new Date(facts.now).toISOString(),mcpUrl:facts.mcpUrl,projects:facts.projects,
  defaults:agentAccessDefaults(),scopes:[{value:'all',label:'All projects and conversations'},{value:'selected',label:'Selected projects'}],
  lifetimes:[{value:'1',label:'In 1 day'},{value:'7',label:'In 7 days'},{value:'30',label:'In 30 days'},{value:'never',label:'No expiry'}],
  rows:facts.connections.map(connection=>{const status=connection.revokedAt?'Revoked':connection.expiresAt&&Date.parse(connection.expiresAt)<=facts.now?'Expired':'Active';return{connection,status,canRevoke:status==='Active',scopeLabel:connection.projectIds?.map(id=>facts.projects.find(project=>project.id===id)?.name??id).join(', ')??'All projects and conversations'};}),setup:agentAccessSetup(facts.mcpUrl)});
}
export function agentAccessViewConnections(view:AgentAccessEditorView,connections:z.infer<typeof AgentConnectionSchema>[],now:number):AgentAccessEditorView{
 return agentAccessEditorView({schema:'agent-access-editor-facts-v1',connections,projects:view.projects,mcpUrl:view.mcpUrl,now});
}
export function agentAccessForm(view:AgentAccessEditorView|null,raw:unknown,state:{busy:boolean;issued:boolean}){
 const draft=AgentAccessDraftSchema.parse(raw),canEdit=!state.busy&&!state.issued;
 return {canEdit,canCreate:!!view&&canEdit&&!!draft.label.trim()&&(draft.scope!=='selected'||draft.selected.length>0),showProjects:draft.scope==='selected',projectEmpty:'Add a project first.',canCopy:!!view&&!state.busy};
}
export function agentAccessAttempt(previous:AgentAccessAttempt|null,raw:unknown,candidateId:string):AgentAccessAttempt{
 const draft=AgentAccessDraftSchema.parse(raw),fingerprint=JSON.stringify({label:draft.label.trim(),scope:draft.scope,selected:draft.selected,lifetime:draft.lifetime});
 const prior=previous===null?null:AgentAccessAttemptSchema.parse(previous),id=prior?.fingerprint===fingerprint?prior.id:IdSchema.parse(candidateId);
 const request=AgentAccessCreateSchema.parse({schema:'agent-access-create-v1',clientRequestId:id,label:draft.label.trim(),...(draft.scope==='selected'?{projectIds:draft.selected}:{}),...(draft.lifetime==='never'?{}:{lifetimeDays:Number(draft.lifetime)})});
 return AgentAccessAttemptSchema.parse({schema:'agent-access-attempt-v1',id,fingerprint,request});
}
export function agentAccessCreatedMessage(raw:unknown):string|null{
 return AgentAccessCreatedSchema.parse(raw).created?null:'This connection was already created. Its token is shown only once. Revoke it and create a new connection if you did not save the token.';
}
export function agentAccessCreatedConnections(current:z.infer<typeof AgentConnectionSchema>[]|undefined,raw:unknown){
 const result=AgentAccessCreatedSchema.parse(raw);return[result.connection,...(current??[]).filter(row=>row.id!==result.connection.id)];
}
export function agentAccessRevokedConnections(current:z.infer<typeof AgentConnectionSchema>[]|undefined,raw:unknown){
 const connection=AgentConnectionSchema.parse(raw);return current?.map(row=>row.id===connection.id?connection:row);
}
export function agentAccessRevokeResult(connectionId:string,raw:unknown,issuedId?:string){
 const connection=AgentConnectionSchema.parse(raw);if(connection.id!==IdSchema.parse(connectionId))throw Error('The reply belongs to another connection.');if(!connection.revokedAt)throw Error('The connection was not revoked.');
 return{connection,clearIssued:issuedId===connection.id,message:'Connection revoked.'};
}
