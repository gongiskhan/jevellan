import {JevControlCommandSchema,JevControlResultSchema,JevControlReadSchema} from '@jevellan/core';
import type {Application} from './application.js';

/** UI and members enter through the same authenticated, project-bound owner action as MCP. */
export async function ownerJevControl(app:Application,project:string|undefined,raw?:unknown){
 const input=raw===undefined?undefined:JevControlCommandSchema.parse(raw);
 const selected=input?.projectId??project??(await app.state.projects.list()).map(row=>row.project).sort((a,b)=>a.name.localeCompare(b.name))[0]?.id;
 const request={schema:'owner-tool-request-v1' as const,caller:'ui',action:input?'control_command':'control_workspace',args:{...(selected?{project:selected}:{}),...(input?{request:input}:{})}};
 const result=app.member?await app.member.ownerTool({schema:'owner-tool-forward-v1',name:'jev',request}):await app.ownerTools.call('jev',request);
 if(!result.ok){const status=({hub_unavailable:503,project_unknown:404,project_mismatch:403,invalid_arguments:400,invalid_rule:400,invalid_prompt:400,rule_not_found:404,lesson_not_found:404,proposal_not_found:404,proposal_not_open:409,no_change:409} as Record<string,number>)[result.error.code]??400;throw Object.assign(new Error(result.error.text),{status});}
 return input?JevControlResultSchema.parse(result.data):JevControlReadSchema.parse(result.data);
}
