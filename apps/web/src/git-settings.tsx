import {useEffect,useState} from 'react';
import {GitCheckSchema,GitSettingsSchema,GitEditorViewSchema,gitEditorDefaults,gitEditorForm,gitSaveCommand,gitCheckCommand,gitCheckPresentation,gitEditorMergeSettings,gitTokenScope,GIT_CONNECTION_METHODS,GIT_DEFAULT_TOKEN_SCOPE,type GitEditorView,type GitEditorDraft} from '@jevellan/core/client';
import type {z} from 'zod';
import {api} from './api.js';
import {SectionHeading,useTask,type PageProps} from './components.js';
import {GitHubToken} from './github-token.js';

export function GitPage(props:PageProps){
 const [view,setView]=useState<GitEditorView>();
 const [draft,setDraft]=useState<GitEditorDraft>(gitEditorDefaults);
 const [result,setResult]=useState<z.infer<typeof GitCheckSchema>>();
 const task=useTask(props.onError),deviceId=props.data.devices.currentDeviceId;
 useEffect(()=>{
  const controller=new AbortController();
  void api('/api/git/view',GitEditorViewSchema,'GET',undefined,{signal:controller.signal})
   .then(value=>{setView(value);setDraft(current=>({...current,transport:value.defaults.transport}));}).catch(props.onError);
  return()=>controller.abort();
 },[deviceId,props.onError]);
 const form=gitEditorForm(view??null,draft,task.busy),projects=view?.projects??[],device=view?.deviceName??'this device';
 const presentation=result?gitCheckPresentation(result):null;
 return <>
  <SectionHeading title="Git" />
  <p className="intro">Connect project repositories on {device}. Agent accounts and Git authentication are separate.</p>
  <section className="card"><h2>GitHub connection</h2>
   <p>Jevellan runs Git in the background. A login that needs a terminal prompt or a locked macOS Keychain cannot complete there.</p>
   <form onSubmit={event=>{event.preventDefault();void task.run(async signal=>{
    if(!view)return;const command=gitSaveCommand(view,draft);
    const saved=await api('/api/git/settings',GitSettingsSchema,'PUT',command.settings,{signal});
    setView(current=>current?gitEditorMergeSettings(current,saved):current);setResult(undefined);props.message(view.saveMessage);
   });}}>
    <label>Connection method<select disabled={!form.canChooseTransport} value={draft.transport} onChange={event=>{setDraft(current=>({...current,transport:event.target.value as GitEditorDraft['transport']}));setResult(undefined);}}>
     {(view?.methods??GIT_CONNECTION_METHODS).map(method=><option key={method.value} value={method.value}>{method.label}</option>)}
    </select></label>
    <p className="muted">{form.description}</p>
    <p className="muted small-text">{view?.localNotice}</p>
    <button disabled={!form.canSave}>{task.busy?'Working…':'Save Git settings'}</button>
   </form>
  </section>
  <label>GitHub token scope<select value={draft.tokenScope} onChange={event=>setDraft(current=>({...current,tokenScope:event.target.value}))}>
   {(view?.tokenScopes??[GIT_DEFAULT_TOKEN_SCOPE]).map(scope=><option key={scope.value} value={scope.value}>{scope.label}</option>)}
  </select></label>
  <GitHubToken key={draft.tokenScope} projectId={gitTokenScope(draft.tokenScope)} onError={props.onError} message={props.message} />
  <section className="card"><h2>Check a project</h2>
   <p>Test read access using the saved connection method. This check does not fetch, commit or push.</p>
   {projects.length?<>
    <label>Project<select value={form.selectedProjectId} disabled={task.busy} onChange={event=>{setDraft(current=>({...current,projectId:event.target.value}));setResult(undefined);}}>
     {projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
    </select></label>
    <button className="secondary" disabled={!form.canCheck} onClick={()=>void task.run(async signal=>{
     if(!view)return;setResult(undefined);setResult(await api('/api/git/check',GitCheckSchema,'POST',gitCheckCommand(view,draft).input,{signal}));
    })}>{task.busy?'Checking…':'Check connection'}</button>
    {form.saveFirstNotice&&<p className="muted">{form.saveFirstNotice}</p>}
   </>:<p>Add a project with a checkout on this device in{' '}<button className="text-button" onClick={()=>props.navigate('/settings/projects')}>Projects</button>.</p>}
   {result&&presentation&&<div className="git-check-result" role="status"><h3>{presentation.heading}</h3>
    {result.remote&&<p><code style={{overflowWrap:'anywhere'}}>{result.remote}</code></p>}
    <p>{result.message}</p>{presentation.hint&&<p className="muted">{presentation.hint}</p>}
   </div>}
  </section>
 </>;
}
