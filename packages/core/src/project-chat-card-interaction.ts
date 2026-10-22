import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ProjectChatItemSchema} from './project-chat-schemas.js';
import {ProjectTaskCommandSchema} from './project-task-interaction-schemas.js';
import {ProjectChatCardContextSchema,ProjectChatCardInteractionSourceSchema,ProjectChatCardInteractionSchema,projectChatCardPolicy,type ProjectChatCardInteraction} from './project-chat-card-schemas.js';
import type {ProjectWorkTask} from './project-loop-schemas.js';
import type {ThreadIndex} from './project-schemas.js';
import type {ProjectWorkCard} from './project-card-schemas.js';

export const projectCardKey=(kind:ProjectWorkCard['kind'],id:string)=>`${kind}:${id}`;
export function projectCardPresentation(cards:ReadonlyMap<string,ProjectWorkCard>,threadId?:string,taskId?:string){return threadId!==undefined?cards.get(projectCardKey('thread',threadId)):taskId!==undefined?cards.get(projectCardKey('task',taskId)):undefined;}
export const startAllCards=(count:number)=>`Start all (${count})`;
/** One validated snapshot per live view; row interactions only query indexes, not full chat or task arrays. */
export class ProjectChatCardContext{
 readonly #projectId:string;readonly #tasks=new Map<string,ProjectWorkTask>();readonly #threads=new Map<string,ThreadIndex>();readonly #taskThreads=new Map<string,ProjectWorkTask>();readonly #cards=new Map<string,ProjectWorkCard>();
 constructor(raw:unknown){const source=ProjectChatCardContextSchema.parse(raw);this.#projectId=source.projectId;for(const task of source.tasks){if(!this.#tasks.has(task.id))this.#tasks.set(task.id,task);if(task.threadId&&!this.#taskThreads.has(task.threadId))this.#taskThreads.set(task.threadId,task);}for(const thread of source.threads)if(!this.#threads.has(thread.id))this.#threads.set(thread.id,thread);for(const card of source.cards)this.#cards.set(projectCardKey(card.kind,card.id),card);}
 #command(task:ProjectWorkTask|undefined,which:'taskStart'|'taskDismiss'){
  if(!task)return null;const request=this.#cards.get(projectCardKey('task',task.id))?.[which];if(!request)return null;
  const update=request.body.schema==='task-update-request-v1',path=`/api/projects/${this.#projectId}/tasks/${task.id}/${update?'edit':'action'}`;
  if(request.path!==path)throw Object.assign(new Error('This task operation belongs to another resource.'),{status:409});
  return ProjectTaskCommandSchema.parse({schema:'project-task-command-v1',projectId:this.#projectId,taskId:task.id,operation:update?'update':'action',body:request.body});
 }
 interaction(rawItem:unknown,rawStartAll:unknown):ProjectChatCardInteraction{
  const item=ProjectChatItemSchema.parse(rawItem),startAll=z.array(IdSchema).parse(rawStartAll);
  if(item.kind!=='routed'||item.taskIds===undefined&&!item.threadId)throw Object.assign(new Error('This is not a routed work card.'),{status:404});
  const refs=item.taskIds?.map(id=>{const task=this.#tasks.get(id);return{id,task,thread:task?.threadId?this.#threads.get(task.threadId):undefined};})??[{id:item.threadId!,task:this.#taskThreads.get(item.threadId!),thread:this.#threads.get(item.threadId!)}];
  const rows=refs.map(row=>({...row,task:row.task??null,thread:row.thread??null,card:projectCardPresentation(this.#cards,row.thread?.id,row.task?.id)??null,start:this.#command(row.task,'taskStart'),dismiss:this.#command(row.task,'taskDismiss')}));
  const commands=startAll.flatMap(id=>{const command=this.#command(this.#tasks.get(id),'taskStart');return command?[command]:[];});
  return ProjectChatCardInteractionSchema.parse({schema:'project-chat-card-interaction-v1',projectId:this.#projectId,itemId:item.id,policy:projectChatCardPolicy,messageText:item.message?projectChatCardPolicy.labels.message:null,rows,batch:startAll.length?{label:startAllCards(startAll.length),taskIds:startAll,commands}:null});
 }
}
export const projectChatCardContext=(raw:unknown)=>new ProjectChatCardContext(raw);
export function projectChatCardInteraction(raw:unknown):ProjectChatCardInteraction{const{schema:_schema,item,startAll,...source}=ProjectChatCardInteractionSourceSchema.parse(raw);void _schema;return projectChatCardContext({schema:'project-chat-card-context-v1',...source}).interaction(item,startAll);}
