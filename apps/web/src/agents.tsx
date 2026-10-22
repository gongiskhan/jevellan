import {useEffect,useRef,useState} from 'react';
import {AgentAccessCreatedSchema,AgentAccessEditorViewSchema,AgentConnectionSchema,agentAccessDefaults,agentAccessForm,agentAccessAttempt,agentAccessCreatedMessage,agentAccessCreatedConnections,agentAccessRevokedConnections,agentAccessRevokeResult,agentAccessViewConnections,type AgentConnection,type AgentAccessDraft,type AgentAccessEditorView,type AgentAccessAttempt} from '@jevellan/core/client';
import {api,empty,isCancelled} from './api.js';
import {clientId} from './client-id.js';
import {Confirm,SectionHeading,dateTime,useTask,type PageProps} from './components.js';
import {Icon} from './icons.js';

export function AgentsPage(props:PageProps){
 const [view,setView]=useState<AgentAccessEditorView>();
 const [connections,setConnections]=useState<AgentConnection[]>();
 const [draft,setDraft]=useState<AgentAccessDraft>(agentAccessDefaults);
 const [issued,setIssued]=useState<{id:string;label:string;token:string}>();
 const [revoke,setRevoke]=useState<AgentConnection>();
 const request=useRef<AgentAccessAttempt|null>(null),task=useTask(props.onError);
 useEffect(()=>{
  const controller=new AbortController();
  void api('/api/agent-access/view',AgentAccessEditorViewSchema,'GET',undefined,{signal:controller.signal,waitForHub:true})
   .then(value=>{setView(value);setConnections(value.rows.map(row=>row.connection));})
   .catch(error=>{if(!isCancelled(error))props.onError(error);});
  return()=>controller.abort();
 },[props.onError]);
 const form=agentAccessForm(connections?view??null:null,draft,{busy:task.busy,issued:!!issued});
 const rows=view?agentAccessViewConnections(view,connections??[],Date.now()).rows:[];
 const setup=view?.setup.http??'',stdio=view?.setup.stdio??'',mcpUrl=view?.mcpUrl??'';
 const copy=(text:string,message:string)=>{void task.run(async()=>{await navigator.clipboard.writeText(text);props.message(message);});};
 return <>
  <SectionHeading title="Agents" />
  <p className="intro">Connect another agent to Jevellan through MCP. It can start and steer work, follow project messages, and receive organized live output.</p>
  <section className="card">
   <h2>New connection</h2>
   <p>Give each agent its own connection. Choose the projects it can work with and how long access lasts.</p>
   <form onSubmit={event=>{
    event.preventDefault();void task.run(async signal=>{
     request.current=agentAccessAttempt(request.current,draft,clientId());
     const result=await api('/api/agent-access',AgentAccessCreatedSchema,'POST',request.current.request,{signal,waitForHub:true});
     if(result.created&&result.token)setIssued({id:result.connection.id,label:result.connection.label,token:result.token});
     const message=agentAccessCreatedMessage(result);if(message)props.message(message);
     setConnections(current=>agentAccessCreatedConnections(current,result));setDraft(current=>({...current,label:''}));request.current=null;
    });
   }}>
    <label>Name<input value={draft.label} maxLength={120} required placeholder="For example, my coding agent" disabled={!form.canEdit}
     onChange={event=>setDraft(current=>({...current,label:event.target.value}))} /></label>
    <div className="form-grid">
     <label><span>Access</span><select aria-label="Access" value={draft.scope} disabled={!form.canEdit} onChange={event=>setDraft(current=>({...current,scope:event.target.value as AgentAccessDraft['scope']}))}>
      {view?.scopes.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}
     </select></label>
     <label><span>Expires</span><select aria-label="Expires" value={draft.lifetime} disabled={!form.canEdit} onChange={event=>setDraft(current=>({...current,lifetime:event.target.value as AgentAccessDraft['lifetime']}))}>
      {view?.lifetimes.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}
     </select></label>
    </div>
    {form.showProjects&&<fieldset className="agent-projects"><legend>Projects</legend>
     {!view?.projects.length&&<p className="muted">{form.projectEmpty}</p>}
     {view?.projects.map(project=><label className="checkbox-label" key={project.id}>
      <input type="checkbox" checked={draft.selected.includes(project.id)} disabled={!form.canEdit}
       onChange={event=>setDraft(current=>({...current,selected:event.target.checked?[...current.selected,project.id]:current.selected.filter(id=>id!==project.id)}))} />
      {project.name}
     </label>)}
    </fieldset>}
    <button disabled={!form.canCreate}>{task.busy?'Working…':'Create connection'}</button>
   </form>
   {issued&&<div className="agent-issued" role="status">
    <h3>Token for {issued.label}</h3><p>Copy this token now. Jevellan will not show it again.</p>
    <label>Connection token<input type="password" autoComplete="off" readOnly value={issued.token} /></label>
    <div className="form-actions">
     <button type="button" disabled={task.busy} onClick={()=>copy(issued.token,'Connection token copied.')}><Icon name="copy" /> Copy token</button>
     <button type="button" className="secondary" onClick={()=>setIssued(undefined)}>I saved it</button>
    </div>
   </div>}
  </section>
  <section className="card"><h2>Connections</h2>
   {!connections?<p className="muted">Loading connections…</p>:!connections.length?<p className="muted">No agents connected yet.</p>:
    <ul className="agent-connections">{rows.map(row=>{const connection=row.connection;return <li key={connection.id}>
     <div><strong>{connection.label}</strong><span className="chip">{row.status}</span>
      <p className="muted">{row.scopeLabel} · token ends in {connection.tokenSuffix}</p>
      <p className="muted small-text">Created {dateTime(connection.createdAt)}{connection.expiresAt&&` · Expires ${dateTime(connection.expiresAt)}`}</p>
     </div>
     {row.canRevoke&&<button type="button" className="secondary" disabled={task.busy} onClick={()=>setRevoke(connection)}>Revoke</button>}
    </li>;})}</ul>}
  </section>
  <section className="card"><h2>Connect your agent</h2>
   <p>Use the HTTP configuration below in a client that supports MCP. Replace the placeholder with your connection token.</p>
   <label>MCP address<input readOnly value={mcpUrl} /></label>
   <pre className="agent-config"><code>{setup}</code></pre>
   <button type="button" className="secondary" disabled={!form.canCopy} onClick={()=>copy(setup,'MCP configuration copied.')}><Icon name="copy" /> Copy configuration</button>
   <details className="agent-stdio"><summary>For clients that require a local command</summary>
    <p>With Jevellan installed on the agent’s machine, use this configuration.</p>
    <pre className="agent-config"><code>{stdio}</code></pre>
    <button type="button" className="secondary" disabled={!form.canCopy} onClick={()=>copy(stdio,'Local MCP configuration copied.')}><Icon name="copy" /> Copy local configuration</button>
   </details>
   <p className="muted">Work can use Auto choices or select a provider, account, model and effort. The agent can discover available choices and follow messages from jobs, threads and coordinators.</p>
  </section>
  {revoke&&<Confirm title={`Revoke ${revoke.label}?`} action="Revoke connection" danger busy={task.busy} close={()=>setRevoke(undefined)}
   confirm={()=>{void task.run(async signal=>{
    const result=await api(`/api/agent-access/${encodeURIComponent(revoke.id)}/revoke`,AgentConnectionSchema,'POST',empty,{signal,waitForHub:true});
    const outcome=agentAccessRevokeResult(revoke.id,result,issued?.id);
    setConnections(current=>agentAccessRevokedConnections(current,outcome.connection));if(outcome.clearIssued)setIssued(undefined);
    setRevoke(undefined);props.message(outcome.message);
   });}}><p>This agent will lose access. Work it already started keeps running.</p>
  </Confirm>}
 </>;
}
