import {expect,test} from 'vitest';
import * as C from '../packages/core/dist/index.js';
const now=Date.parse('2026-10-22T12:00:00Z');
const connection=(id='agent_active')=>C.AgentConnectionSchema.parse({schema:'agent-connection-v1',id,label:'Fixture connection',createdAt:new Date(now-1000).toISOString(),tokenSuffix:'test'});
const facts=()=>({schema:'agent-access-editor-facts-v1' as const,connections:[connection()],projects:[{id:'alpha',name:'Alpha'}],mcpUrl:'https://fixture.test/mcp',now});
test('agent editor owns defaults choices and create refusal until loaded and acknowledged',()=>{
 const view=C.agentAccessEditorView(facts()),draft=view.defaults;
 expect(draft).toEqual({schema:'agent-access-draft-v1',label:'',scope:'all',selected:[],lifetime:'30'});
 expect(view.lifetimes).toEqual([{value:'1',label:'In 1 day'},{value:'7',label:'In 7 days'},{value:'30',label:'In 30 days'},{value:'never',label:'No expiry'}]);
 expect(C.agentAccessForm(null,{...draft,label:'Named'},{busy:false,issued:false}).canCreate).toBe(false);
 expect(C.agentAccessForm(view,draft,{busy:false,issued:false}).canCreate).toBe(false);
 const named={...draft,label:' Named '};expect(C.agentAccessForm(view,named,{busy:false,issued:false}).canCreate).toBe(true);
 expect(C.agentAccessForm(view,named,{busy:true,issued:false}).canEdit).toBe(false);expect(C.agentAccessForm(view,named,{busy:false,issued:true}).canCreate).toBe(false);
 expect(C.agentAccessForm(view,{...named,scope:'selected',selected:[]},{busy:false,issued:false}).canCreate).toBe(false);
});
test('agent create retries retain one identity and relative lifetime without a browser expiry clock',()=>{
 const draft={...C.agentAccessEditorView(facts()).defaults,label:' Named ',scope:'selected' as const,selected:['alpha'],lifetime:'7' as const};
 const first=C.agentAccessAttempt(null,draft,'create_one'),repeat=C.agentAccessAttempt(first,{...draft,label:'Named'},'unused_candidate');
 expect(repeat).toEqual(first);expect(first.request).toEqual({schema:'agent-access-create-v1',clientRequestId:'create_one',label:'Named',projectIds:['alpha'],lifetimeDays:7});
 const changed=C.agentAccessAttempt(first,{...draft,lifetime:'never'},'create_two');expect(changed.id).toBe('create_two');expect(changed.request.expiresAt).toBeUndefined();expect(changed.request.lifetimeDays).toBeUndefined();
 expect(C.agentAccessAttempt(null,{...draft,scope:'all'},'create_all').request.projectIds).toBeUndefined();
});
test('agent rows share revoked precedence expiry boundary and project-name fallback without credentials',()=>{
 const rows=[{...connection('agent_expired'),expiresAt:new Date(now).toISOString(),projectIds:['alpha','missing']},{...connection('agent_revoked'),revokedAt:new Date(now-100).toISOString(),expiresAt:new Date(now-1000).toISOString()},connection()];
 const view=C.agentAccessEditorView({...facts(),connections:rows});
 expect(view.rows.map(row=>[row.status,row.canRevoke,row.scopeLabel])).toEqual([['Expired',false,'Alpha, missing'],['Revoked',false,'All projects and conversations'],['Active',true,'All projects and conversations']]);
 expect(JSON.stringify(view).includes('Bearer <connection token>')).toBe(true);expect(Object.keys(view.rows[0]!).includes('token')).toBe(false);
});
test('agent list merge and captured revoke preserve independent connections and reject another target',()=>{
 const first=connection(),other=connection('agent_other'),created=C.AgentAccessCreatedSchema.parse({schema:'agent-access-created-v1',created:false,connection:{...first,label:'Updated'}});
 expect(C.agentAccessCreatedConnections([other,first],created)).toEqual([created.connection,other]);
 const revoked={...first,revokedAt:new Date(now).toISOString()};expect(C.agentAccessRevokedConnections([other,first],revoked)).toEqual([other,revoked]);
 expect(C.agentAccessRevokeResult(first.id,revoked,other.id)).toMatchObject({clearIssued:false,message:'Connection revoked.'});expect(C.agentAccessRevokeResult(first.id,revoked,first.id).clearIssued).toBe(true);
 expect(()=>C.agentAccessRevokeResult(other.id,revoked,first.id)).toThrow('another connection');
});
test('agent setup templates share canonical HTTP and stdio capability names with placeholders only',()=>{
 const setup=C.agentAccessEditorView(facts()).setup;
 expect(JSON.parse(setup.http)).toEqual({mcpServers:{jevellan:{url:'https://fixture.test/mcp',headers:{Authorization:'Bearer <connection token>'}}}});
 expect(JSON.parse(setup.stdio)).toEqual({mcpServers:{jevellan:{command:'jevellan',args:['mcp-server'],env:{JEVELLAN_MCP_URL:'https://fixture.test/mcp',JEVELLAN_MCP_TOKEN:'<connection token>'}}}});
});
test('agent editor rejects unknown draft fields duplicate scope and unsupported lifetime',()=>{
 const draft={...C.agentAccessEditorView(facts()).defaults,label:'Fixture'};
 expect(()=>C.agentAccessAttempt(null,{...draft,lifetime:'2'},'bad_lifetime')).toThrow();expect(()=>C.agentAccessAttempt(null,{...draft,scope:'selected',selected:['alpha','alpha']},'bad_scope')).toThrow();expect(()=>C.agentAccessAttempt(null,{...draft,token:'not-a-credential'},'bad_field')).toThrow();
});
test('agent repeated creation retains exact one-time guidance without inventing a token',()=>{
 const repeated=C.AgentAccessCreatedSchema.parse({schema:'agent-access-created-v1',created:false,connection:connection()});
 expect(C.agentAccessCreatedMessage(repeated)).toBe('This connection was already created. Its token is shown only once. Revoke it and create a new connection if you did not save the token.');
 expect(C.agentAccessCreatedMessage({...repeated,created:true,token:'nonfunctional-fixture-marker'})).toBeNull();
});
