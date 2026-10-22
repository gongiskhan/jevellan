import type {IncomingMessage,ServerResponse} from 'node:http';
import {ContextEditorFactsSchema,ContextEditorDeviceRequestSchema,ContextEditorPreviewSchema,ContextEditorPrepareSchema,ContextEditorCommandSchema,ContextEditorReviewSchema,contextEditor,contextEditorAttempt,contextEditorReceipt,contextEditorDeviceResult,boundedRedaction} from '@jevellan/core';
import type {Application} from './application.js';
import {json,requestBody} from './http.js';
import {projectDefinitionDeviceOperation} from './project-definition-device.js';
const refuse=(message:string,status=400)=>Object.assign(new Error(message),{status});
async function facts(app:Application,projectId:string,panel?:unknown){
 await app.conversations.ready;const [row,configuration]=await Promise.all([app.state.projects.get(projectId),app.configuration()]);
 if(!row)throw refuse('Project not found.',404);
 return ContextEditorFactsSchema.parse({schema:'context-editor-facts-v1',deviceId:app.device.deviceId,project:row.project,panel:panel??await app.conversations.contextPanel(projectId),models:configuration.configuration['x-jevellan'].menu.map(({id,label,enabled})=>({id,label,enabled}))});
}
export async function localContextEditorOperation(app:Application,raw:unknown){
 const input=ContextEditorDeviceRequestSchema.parse(raw);if(input.deviceId!==app.device.deviceId)throw refuse('The context operation belongs to another device.');
 const projectId=input.projectId;
 if(input.operation==='context-editor')return contextEditor(await facts(app,projectId),input.request);
 if(input.operation==='context-preview'){
  const value=ContextEditorPreviewSchema.parse(input.request);if(value.facts.project.id!==projectId||value.facts.deviceId!==app.device.deviceId)throw refuse('The context draft belongs to another device or project.');
  await app.conversations.contextPanel(projectId);return contextEditor(value.facts,value.request);
 }
 if(input.operation==='context-prepare'){
  const value=ContextEditorPrepareSchema.parse(input.request);if(value.editor.projectId!==projectId||value.editor.deviceId!==app.device.deviceId)throw refuse('The context draft belongs to another device or project.');
  await app.conversations.contextPanel(projectId);return contextEditorAttempt(value.previous,value.editor,value.intent,value.candidateId);
 }
 if(input.operation==='context-review')return ContextEditorReviewSchema.parse({schema:'context-editor-review-v1',projectId,deviceId:app.device.deviceId,review:await app.conversations.reviewContext(projectId,input.request.operationId)});
 const command=ContextEditorCommandSchema.parse(input.request);if(command.projectId!==projectId||command.deviceId!==app.device.deviceId)throw refuse('The context command belongs to another device or project.');
 // The existing writer owns durable replay and admission; presentation reads follow it.
 const panel=command.kind==='choose'?await app.conversations.configureContext(projectId,command.body):await app.conversations.continueContext(projectId,command.body);
 return contextEditorReceipt(command,contextEditor(await facts(app,projectId,panel)));
}
export async function contextDeviceOperation(app:Application,raw:unknown){
 const input=ContextEditorDeviceRequestSchema.parse(raw);
 const result=input.deviceId===app.device.deviceId?await localContextEditorOperation(app,input):await projectDefinitionDeviceOperation(app,input.deviceId,input);
 return contextEditorDeviceResult(input,result);
}
export async function handleContextEditorApi(app:Application,request:IncomingMessage,response:ServerResponse,url:URL){
 const match=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/context\/(editor|prepare|commands|editor\/review)$/);if(!match)return false;
 if(url.search)throw refuse('Unsupported context editor query.');
 const projectId=match[1]!,deviceId=app.device.deviceId,method=request.method??'GET',part=match[2];
 if(part==='editor'?method!=='GET'&&method!=='POST':method!=='POST')throw refuse('Unsupported context editor method.',405);
 const operation=part==='editor'?(method==='GET'?'context-editor':'context-preview'):part==='prepare'?'context-prepare':part==='commands'?'context-action':'context-review';
 const input={schema:'project-definition-peer-request-v1',projectId,deviceId,operation,...(method==='GET'?{}:{request:await requestBody(request)})};
 json(response,boundedRedaction(app.redactor,await localContextEditorOperation(app,input)),operation==='context-action'?202:200);return true;
}
