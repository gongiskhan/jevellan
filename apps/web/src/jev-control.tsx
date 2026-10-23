import {useEffect,useState} from 'react';
import {JevControlReadSchema,type JevControlRead,JevControlResultSchema,type JevControlWorkspace,type JevControlOperation,type JevControlCommand,type JevControlResult,type JevRuleDraft} from '@jevellan/core/client';
import {api,isCancelled} from './api.js';
import {SectionHeading,useTask,type PageProps} from './components.js';

type Send=(command:JevControlOperation,accept?:(reply:JevControlResult)=>void)=>void;
type Action=JevControlWorkspace['rules'][number]['remove'];
function ActionButton({action,send,busy}:{action:Action;send:Send;busy:boolean}){return <button type="button" className="secondary" disabled={busy||action.disabled} onClick={()=>send(action.command)}>{action.label}</button>;}
function RuleForm({initial,view,send,busy}:{initial:JevRuleDraft;view:JevControlWorkspace;send:Send;busy:boolean}){
 const [draft,setDraft]=useState(initial);
 return <form onSubmit={event=>{event.preventDefault();send({kind:'rule_set',draft},reply=>{if(reply.ruleDraft)setDraft(reply.ruleDraft);});}}>
  <div className="form-grid">{view.ruleFields.map(field=><label key={field.key}>{field.kind==='checkbox'?<><input type="checkbox" checked={Boolean(draft[field.key])} disabled={busy} onChange={event=>setDraft({...draft,[field.key]:event.target.checked})}/>{field.label}</>:<>{field.label}{field.kind==='select'?<select value={String(draft[field.key])} disabled={busy} onChange={event=>setDraft({...draft,[field.key]:event.target.value})}>{field.options.map(row=><option key={row.value} value={row.value}>{row.label}</option>)}</select>:field.kind==='textarea'?<textarea value={String(draft[field.key])} maxLength={field.maxLength} disabled={busy} onChange={event=>setDraft({...draft,[field.key]:event.target.value})}/>:<input value={String(draft[field.key])} maxLength={field.maxLength} disabled={busy} onChange={event=>setDraft({...draft,[field.key]:event.target.value})}/>}</>}</label>)}</div><button disabled={busy}>{view.ruleSaveLabel}</button>
 </form>;
}
function PromptForm({row,send,busy,reset}:{row:JevControlWorkspace['prompts'][number];send:Send;busy:boolean;reset:string|undefined}){
 const [text,setText]=useState(row.text),[summary,setSummary]=useState('');
 useEffect(()=>{if(reset!==undefined)setText(reset);},[reset]);
 return <section className="card" aria-label={row.name}>
  <h3>{row.title}</h3><form onSubmit={event=>{event.preventDefault();send({...row.propose.command,text,summary} as JevControlOperation);}}>
   <label>{row.textLabel}<textarea rows={16} value={text} disabled={busy} onChange={event=>setText(event.target.value)}/></label>
   <label>{row.summaryLabel}<input value={summary} disabled={busy} onChange={event=>setSummary(event.target.value)}/></label><button disabled={busy||row.propose.disabled}>{row.propose.label}</button>
  </form>
  {row.proposals.map(proposal=><article key={proposal.id} aria-label={proposal.id}><h4>{proposal.title}</h4><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{proposal.diff}</pre><p style={{whiteSpace:'pre-wrap'}}>{proposal.replay}</p><div className="actions"><ActionButton action={proposal.replayAction} send={send} busy={busy}/><ActionButton action={proposal.apply} send={send} busy={busy}/></div></article>)}
  <details><summary>{row.historyLabel}</summary>{row.history.map(version=><div key={version.version}><p>{version.label}</p><ActionButton action={version.rollback} send={send} busy={busy}/></div>)}</details>
 </section>;
}
function LessonForm({row,send,busy}:{row:JevControlWorkspace['lessons'][number];send:Send;busy:boolean}){
 const [text,setText]=useState(row.text),[enabled,setEnabled]=useState(row.enabled);
 return <section className="card" aria-label={row.id}><h3>{row.title}</h3><p>{row.description}</p><form onSubmit={event=>{event.preventDefault();send({...row.edit.command,text,enabled} as JevControlOperation);}}><label>{row.textLabel}<textarea value={text} disabled={busy} onChange={event=>setText(event.target.value)}/></label><label><input type="checkbox" checked={enabled} disabled={busy} onChange={event=>setEnabled(event.target.checked)}/>{row.enabledLabel}</label><button disabled={busy||row.edit.disabled}>{row.edit.label}</button></form><div className="actions"><ActionButton action={row.replay} send={send} busy={busy}/><ActionButton action={row.remove} send={send} busy={busy}/></div></section>;
}
function Workspace({initial,props}:{initial:JevControlWorkspace;props:PageProps}){
 const [view,setView]=useState(initial),[notice,setNotice]=useState(''),[promptDrafts,setPromptDrafts]=useState<Array<{name:string;text:string}>>([]),task=useTask(props.onError);
 const send:Send=(command,accept)=>{void task.run(async signal=>{const request:JevControlCommand={schema:'jev-control-command-v1',projectId:view.projectId,command};const reply=await api(view.endpoint,JevControlResultSchema,view.method,request,{signal});setView(reply.view);setNotice(reply.notice);if(reply.promptDrafts)setPromptDrafts(reply.promptDrafts);accept?.(reply);});};
 return <><p className="intro">{view.intro}</p>{notice&&<p role="status" aria-label={view.resultLabel} className="notice" style={{whiteSpace:'pre-wrap'}}>{notice}</p>}
  <section className="card"><h2>{view.rulesTitle}</h2>{!view.rules.length&&<p>{view.emptyRules}</p>}{view.rules.map(rule=><details key={rule.id}><summary>{rule.title}</summary><p>{rule.description}</p><RuleForm initial={rule.draft} view={view} send={send} busy={task.busy}/><ActionButton action={rule.remove} send={send} busy={task.busy}/></details>)}<details><summary>{view.newRuleLabel}</summary><RuleForm initial={view.ruleDraft} view={view} send={send} busy={task.busy}/></details></section>
  <h2>{view.promptsTitle}</h2>{view.prompts.map(row=><PromptForm key={row.name} row={row} send={send} busy={task.busy} reset={promptDrafts.find(draft=>draft.name===row.name)?.text}/>)}
  <h2>{view.lessonsTitle}</h2>{!view.lessons.length&&<p>{view.emptyLessons}</p>}{view.lessons.map(row=><LessonForm key={row.id} row={row} send={send} busy={task.busy}/>)}</>;
}
export function JevControlPage(props:PageProps){
 const [project,setProject]=useState(''),[view,setView]=useState<JevControlRead>();
 useEffect(()=>{const controller=new AbortController();setView(undefined);void api('/api/jev/control'+(project?'?project='+encodeURIComponent(project):''),JevControlReadSchema,'GET',undefined,{signal:controller.signal,waitForHub:true}).then(setView).catch(error=>{if(!isCancelled(error))props.onError(error);});return()=>controller.abort();},[project,props.onError]);
 return <><SectionHeading title={view?.title??'Jev'}/>{!view?<p>Loading Jev control…</p>:view.schema==='jev-control-empty-v1'?<p>{view.emptyText}</p>:<><label>{view.projectLabel}<select value={view.projectId} onChange={event=>setProject(event.target.value)}>{view.projects.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><Workspace key={view.projectId} initial={view} props={props}/></>}</>;
}
