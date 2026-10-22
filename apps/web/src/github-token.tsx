import {useEffect,useState} from 'react';
import {GitHubTokenStateSchema,GitTokenViewSchema,gitTokenView,gitTokenReadResult,gitTokenSummary,gitTokenSaveCommand,gitTokenRemoveCommand,gitTokenCanSubmit,type GitHubTokenState,type GitTokenView} from '@jevellan/core/client';
import {api} from './api.js';
import {Confirm,Modal,useSettingsSave,useTask,type PageProps} from './components.js';
import * as copy from './project-work-copy.js';
import {afterDialogs,useLocalError} from './project-work.js';
import {dateOnly,timeStamp} from './time.js';

/** The engine returns only masked state. The password field is transient and cleared after every save attempt. */
export function GitHubToken({onError,message,projectId}:Pick<PageProps,'onError'|'message'>&{projectId?:string|undefined}){
 const [state,setState]=useState<GitHubTokenState|null>(null),[dialog,setDialog]=useState<'save'|'remove'>();
 const view=gitTokenView(state,projectId),readPath=view.readPath;
 useEffect(()=>{
  const controller=new AbortController();
  void api(readPath,GitTokenViewSchema,'GET',undefined,{signal:controller.signal,waitForHub:true}).then(value=>setState(gitTokenReadResult(projectId,value).state)).catch(onError);
  return()=>controller.abort();
 },[onError,readPath,projectId]);
 return <section className="card pw-token">
  <h2>{view.label}</h2>
  <p className="saved-secret pw-token-summary">{view.summaryAt?<time dateTime={view.summaryAt} title={timeStamp(view.summaryAt)?.title}>{gitTokenSummary(view,dateOnly(view.summaryAt))}</time>:gitTokenSummary(view,'')}</p>
  <p className="muted pw-token-help">{view.help}</p>
  <div className="actions pw-token-actions">
   <button type="button" className="secondary" disabled={!view.canSave} onClick={()=>setDialog('save')}>{view.saveLabel}</button>
   {view.canRemove&&<button type="button" className="secondary" onClick={()=>setDialog('remove')}>{view.removeLabel}</button>}
  </div>
  {dialog==='save'&&<SaveToken view={view} onError={onError} close={()=>setDialog(undefined)} saved={next=>{setState(next);setDialog(undefined);afterDialogs(message,view.savedMessage);}} />}
  {dialog==='remove'&&<RemoveToken view={view} onError={onError} close={()=>setDialog(undefined)} removed={next=>{setState(next);setDialog(undefined);afterDialogs(message,view.removedMessage);}} />}
 </section>;
}
function SaveToken({view,close,saved,onError}:{view:GitTokenView;close():void;saved(state:GitHubTokenState):void;onError(error:unknown):void}){
 const save=useSettingsSave(),{error,setError,fail}=useLocalError(onError),task=useTask(fail),[value,setValue]=useState('');
 return <Modal title={view.saveTitle} close={close}><form onSubmit={event=>{
  event.preventDefault();void task.run(async signal=>{
   setError('');try{saved(await save(view.endpoint,GitHubTokenStateSchema,'PUT',gitTokenSaveCommand(view.projectId??undefined,value).input,signal));}finally{setValue('');}
  });
 }}>
  <label>{view.label}<input ref={element=>element?.setAttribute('autofocus','')} type="password" autoComplete="off" spellCheck={false} required value={value} onChange={event=>setValue(event.target.value)} /></label>
  {view.saveNote&&<p className="muted">{view.saveNote}</p>}{error&&<p className="error">{error}</p>}
  <div className="form-actions"><button type="button" className="secondary" onClick={close}>{copy.CANCEL}</button><button disabled={!gitTokenCanSubmit(value,task.busy)}>{task.busy?copy.SAVING:view.saveButton}</button></div>
 </form></Modal>;
}
function RemoveToken({view,close,removed,onError}:{view:GitTokenView;close():void;removed(state:GitHubTokenState):void;onError(error:unknown):void}){
 const {error,setError,fail}=useLocalError(onError),task=useTask(fail);
 return <Confirm title={view.removeTitle} action={view.removeLabel} danger busy={task.busy} close={close} confirm={()=>void task.run(async signal=>{
  setError('');removed(await api(view.endpoint,GitHubTokenStateSchema,'DELETE',gitTokenRemoveCommand(view.projectId??undefined).input,{signal,waitForHub:true}));
 })}><p className="pw-confirm-body">{view.removeBody}</p>{error&&<p className="error">{error}</p>}</Confirm>;
}
