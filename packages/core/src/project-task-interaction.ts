import {TaskActionRequestSchema,TaskUpdateRequestSchema,TaskTypeSchema,type ProjectWorkTask} from './project-loop-schemas.js';
import type {ProjectTaskQueueView} from './project-goal-view-schemas.js';
import {ProjectTaskContextSchema,ProjectTaskQueueRequestSchema,ProjectTaskQueueInteractionSchema,ProjectTaskEditViewSchema,ProjectTaskIntentRequestSchema,ProjectTaskDraftSchema,type ProjectTaskContext,type ProjectTaskQueueInteraction} from './project-task-interaction-schemas.js';

const refuse=(message:string)=>Object.assign(new Error(message),{status:409});
export function projectTaskContext(task:ProjectWorkTask){return ProjectTaskContextSchema.parse({schema:'project-task-context-v1',projectId:task.projectId,taskId:task.id,revision:task.revision,title:task.title,state:task.state,now:task.now,held:!!task.held,threadId:task.threadId,dispatching:!!task.dispatchText});}
const queued=(context:ProjectTaskContext)=>context.state==='draft'||context.state==='queued';
const editable=(context:ProjectTaskContext)=>queued(context)&&!context.threadId&&!context.dispatching;
export function projectTaskQueueRequest(raw:unknown={schema:'project-task-queue-request-v1'}){return ProjectTaskQueueRequestSchema.parse(raw);}

function actions(task:ProjectWorkTask,index:number,order:readonly string[]){
 const context=projectTaskContext(task),rows:ProjectTaskQueueInteraction['rows'][number]['actions']=[];
 const add=(id:typeof rows[number]['id'],label:string,intent:typeof rows[number]['intent'],enabled=true,ariaLabel:string|null=null)=>rows.push({id,kind:'command',label,primary:id==='approve',enabled,busyDisabled:true,ariaLabel,intent,confirmation:null});
 if(context.state==='draft'){
  add('approve','Approve',{kind:'action',action:'approve'});add('reject','Reject',{kind:'action',action:'reject'});
  Object.assign(rows.at(-1)!,{kind:'confirm',confirmation:{title:`Reject "${task.title}"?`,action:'Reject',consequence:'Rejected tasks stay in the project history.',danger:true}});
 }
 if(queued(context)){
  const later=context.now&&!context.held;add('now',later?'Later':'Start now',{kind:'action',action:later?'later':'now'});
  if(editable(context))rows.push({id:'edit',kind:'edit',label:'Edit',primary:false,enabled:true,busyDisabled:false,ariaLabel:null,intent:null,confirmation:null});
  add('cancel','Cancel',{kind:'action',action:'cancel'},!context.dispatching||!!context.threadId);
  add('top','Move to top',{kind:'move',position:'top'});add('bottom','Move to bottom',{kind:'move',position:'bottom'});
  add('earlier','↑',index>0?{kind:'move',position:{before:order[index-1]!}}:null,index>0,`Move ${task.title} earlier`);
  add('later','↓',index<order.length-1?{kind:'move',position:{after:order[index+1]!}}:null,index<order.length-1,`Move ${task.title} later`);
 }
 return rows;
}

export function projectTaskQueueInteraction(facts:{projectId:string;tasks:readonly ProjectWorkTask[];queue:ProjectTaskQueueView},raw?:unknown){
 const request=projectTaskQueueRequest(raw),selected=facts.queue.scopes[request.scope],byId=new Map<string,ProjectWorkTask>();for(const task of facts.tasks)if(!byId.has(task.id))byId.set(task.id,task);
 const tasks=selected.order.flatMap(id=>{const task=byId.get(id);if(task&&task.projectId!==facts.projectId)throw refuse('This task belongs to another project.');return task?[task]:[];}),order=tasks.map(task=>task.id),available=new Set(order);
 const groups=request.grouped&&request.grouping==='goals'?selected.groups.map(group=>({label:group.label,taskIds:group.taskIds.filter(id=>available.has(id))})):[{label:'',taskIds:order}];
 return ProjectTaskQueueInteractionSchema.parse({schema:'project-task-queue-interaction-v1',projectId:facts.projectId,request,order,groups,showGrouping:request.grouped,groupChoices:[{value:'order',label:'Order',selected:request.grouping==='order'},{value:'goals',label:'Goals',selected:request.grouping==='goals'}],emptyText:'Nothing in the queue. Ask the coordinator or add a task.',groupEmptyText:'Nothing open for this goal.',rows:tasks.map((task,index)=>({taskId:task.id,context:projectTaskContext(task),dragEligible:queued(projectTaskContext(task)),taskLink:{label:'Open task',href:`/projects/${facts.projectId}/tasks/${task.id}`},threadLink:task.threadId?{label:'Open thread',href:`/projects/${facts.projectId}/threads/${task.threadId}`}:null,needsLine:task.needs.length?`Needs: ${task.needs.join(', ')}`:null,endNote:task.endNote||null,actions:actions(task,index,order)}))});
}

export function projectTaskEditView(task:ProjectWorkTask,goals:readonly{goal:{id:string;name:string}}[]){
 return ProjectTaskEditViewSchema.parse({schema:'project-task-edit-view-v1',projectId:task.projectId,taskId:task.id,context:projectTaskContext(task),defaults:{title:task.title,brief:task.brief,type:task.type,goalId:task.goalId??''},types:TaskTypeSchema.options,goals:[{id:'',label:'Asks'},...goals.map(({goal})=>({id:goal.id,label:goal.name}))],limits:{title:TaskUpdateRequestSchema.shape.title.unwrap().maxLength!,brief:TaskUpdateRequestSchema.shape.brief.unwrap().maxLength!},labels:{title:'Edit task',titleField:'Title',briefField:'Brief',typeField:'Type',goalField:'Goal',save:'Save',cancel:'Cancel'}});
}

export function projectTaskDraft(projectId:string,taskId:string,raw:unknown){
 const {context,intent}=ProjectTaskIntentRequestSchema.parse(raw);if(context.projectId!==projectId||context.taskId!==taskId)throw refuse('This task context belongs to another task or project.');
 if(intent.kind==='edit'){
  if(!editable(context))throw refuse('This task cannot be edited from the queue.');
  return ProjectTaskDraftSchema.parse({schema:'project-task-draft-v1',command:{schema:'project-task-command-v1',projectId,taskId,operation:'update',body:TaskUpdateRequestSchema.parse({schema:'task-update-request-v1',expectedRevision:context.revision,...intent.fields,goalId:intent.fields.goalId||null})}});
 }
 if(!queued(context))throw refuse('This task action is unavailable.');
 if(intent.kind==='move')return ProjectTaskDraftSchema.parse({schema:'project-task-draft-v1',command:{schema:'project-task-command-v1',projectId,taskId,operation:'update',body:TaskUpdateRequestSchema.parse({schema:'task-update-request-v1',expectedRevision:context.revision,position:intent.position})}});
 const action=intent.action,allowed=action==='approve'||action==='reject'?context.state==='draft':action==='cancel'?!context.dispatching||!!context.threadId:action===(context.now&&!context.held?'later':'now');
 if(!allowed)throw refuse('This task action is unavailable.');
 return ProjectTaskDraftSchema.parse({schema:'project-task-draft-v1',command:{schema:'project-task-command-v1',projectId,taskId,operation:'action',body:TaskActionRequestSchema.parse({schema:'task-action-request-v1',expectedRevision:context.revision,action})}});
}

export function projectTaskQueueDrop(view:ProjectTaskQueueInteraction,id:string,target:string,after:boolean){
 const row=view.rows.find(row=>row.taskId===id);if(!row?.dragEligible||!view.order.includes(target))return null;
 return ProjectTaskIntentRequestSchema.parse({schema:'project-task-intent-v1',context:row.context,intent:{kind:'move',position:after?{after:target}:{before:target}}});
}
