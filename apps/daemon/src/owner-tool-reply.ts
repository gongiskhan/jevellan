import {AgentAccessCreateSchema,AgentAccessCreatedSchema,AgentAccessEditorViewSchema,ownerTool,ownerToolAction,type OwnerToolResult} from '@jevellan/core';
import type {Application} from './application.js';
import {deviceToolReply} from './device-management.js';
import {agentAccessEditorReply} from './agent-access-editor.js';

/** Credential delivery is restricted to the existing authenticated first-issuance response. */
export function ownerToolReply(app:Application,name:string,args:Record<string,unknown>,result:OwnerToolResult,explicitAction?:string):OwnerToolResult{
 const tool=ownerTool(name),action=tool?ownerToolAction(tool,args,explicitAction):undefined,{action:_ignored,...rest}=args;void _ignored;
 const input=action?.input.safeParse(rest),request=input?.success?AgentAccessCreateSchema.safeParse((input.data as {request?:unknown}).request):null;
 const created=result.ok?AgentAccessCreatedSchema.safeParse(result.data):null;
 const token=name==='config'&&action?.name==='agent_access_create'&&request?.success&&created?.success&&created.data.created&&created.data.token&&new RegExp('^jva_'+created.data.connection.id+'\\.[A-Za-z0-9_-]{43}$','u').test(created.data.token)?created.data.token:undefined;
 if(token)app.redactor.add(token);
 const safe=deviceToolReply(app,name,args,result,explicitAction);
 const view=name==='config'&&action?.name==='agent_access_view'&&input?.success&&safe.ok?AgentAccessEditorViewSchema.safeParse(safe.data):null;
 if(view?.success&&safe.ok)return{...safe,data:agentAccessEditorReply(app,view.data)};
 return token&&safe.ok&&safe.data&&typeof safe.data==='object'&&!Array.isArray(safe.data)?{...safe,data:{...safe.data,token}}:safe;
}
