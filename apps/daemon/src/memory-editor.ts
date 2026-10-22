import type {IncomingMessage,ServerResponse} from 'node:http';
import {IdSchema,MemoryEditorFactsSchema,MemoryEditorReadRequestSchema,MemoryEditorPrepareSchema,MemoryEditorCommandSchema,ProjectMemoryViewSchema,memoryEditor,memoryEditorAttempt,memoryEditorReceipt,boundedRedaction,type ProjectMemoryResult} from '@jevellan/core';
import {UiAuth} from '@jevellan/mesh';
import type {Application} from './application.js';
import {json,requestBody} from './http.js';
const refuse=(message:string,status=400)=>Object.assign(new Error(message),{status});
type OwnerMemory=(input:unknown)=>Promise<ProjectMemoryResult>;
/** Owner HTTP requests retain their verified session. Internal owner tools revoke only their own temporary session. */
async function withOwnerMemory<T>(app:Application,ownerSession:string|undefined,run:(read:OwnerMemory)=>Promise<T>):Promise<T>{
 if(ownerSession!==undefined)return run(input=>app.ownerProjectMemory(input,ownerSession));
 const auth=app.auth;if(!(auth instanceof UiAuth))throw refuse('Owner tools must run on the state point.',409);
 const temporary=auth.issue();app.redactor.add(temporary);
 try{return await run(input=>app.ownerProjectMemory(input,temporary));}finally{auth.logout(temporary);}
}
async function facts(app:Application,projectId:string,read:OwnerMemory){
 await app.projectWork.ready;const row=await app.state.projects.get(projectId);if(!row)throw refuse('Project not found.',404);
 if(row.project.memory.mode!=='hub')return MemoryEditorFactsSchema.parse({schema:'memory-editor-facts-v1',project:row.project,settings:null,view:null});
 const[settings,result]=await Promise.all([app.projectWork.settingsView(projectId),read({schema:'project-memory-request-v1',projectId,operation:'view'})]);
 return MemoryEditorFactsSchema.parse({schema:'memory-editor-facts-v1',project:row.project,settings:settings.settings,view:ProjectMemoryViewSchema.parse(result)});
}
export async function readMemoryEditor(app:Application,projectId:string,raw?:unknown,ownerSession?:string){
 IdSchema.parse(projectId);const input=raw===undefined?undefined:MemoryEditorReadRequestSchema.parse(raw);
 return withOwnerMemory(app,ownerSession,async read=>memoryEditor(await facts(app,projectId,read),input?.fields,input?.ui));
}
export async function prepareMemoryEditor(app:Application,projectId:string,raw:unknown){
 const input=MemoryEditorPrepareSchema.parse(raw);if(input.editor.projectId!==projectId)throw refuse('The memory draft belongs to another project.');
 if(!await app.state.projects.get(projectId))throw refuse('Project not found.',404);
 return memoryEditorAttempt(input.previous,input.editor,input.intent,input.candidateId);
}
export async function runMemoryEditorCommand(app:Application,projectId:string,raw:unknown,ownerSession?:string){
 const command=MemoryEditorCommandSchema.parse(raw);if(command.projectId!==projectId)throw refuse('The memory command belongs to another project.');
 if(command.kind==='settings'){
  // Keep the existing durable writer before fresh presentation reads.
  const result=await app.projectWork.putSettings(projectId,command.body);
  return memoryEditorReceipt(command,result,await readMemoryEditor(app,projectId,undefined,ownerSession));
 }
 return withOwnerMemory(app,ownerSession,async read=>{
  const{schema,...input}=command.body;void schema;
  const result=await read({schema:'project-memory-request-v1',projectId,...input});
  return memoryEditorReceipt(command,result,memoryEditor(await facts(app,projectId,read)));
 });
}
export async function handleMemoryEditorApi(app:Application,request:IncomingMessage,response:ServerResponse,url:URL,ownerSession:string){
 const match=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/memory\/(editor|prepare|commands)$/);if(!match)return false;
 if(url.search)throw refuse('Unsupported memory editor query.');
 const projectId=IdSchema.parse(match[1]),part=match[2],method=request.method??'GET';
 if(part==='editor'?method!=='GET'&&method!=='POST':method!=='POST')throw refuse('Unsupported memory editor method.',405);
 const result=part==='editor'?await readMemoryEditor(app,projectId,method==='POST'?await requestBody(request):undefined,ownerSession):part==='prepare'?await prepareMemoryEditor(app,projectId,await requestBody(request)):await runMemoryEditorCommand(app,projectId,await requestBody(request),ownerSession);
 json(response,boundedRedaction(app.redactor,result));return true;
}
