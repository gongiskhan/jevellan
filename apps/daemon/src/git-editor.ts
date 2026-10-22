import {GitSettings,GitCheckRequestSchema,GitEditorCommandSchema,GitEditorSavedSchema,GitEditorCheckedSchema,GitTokenCommandSchema,GitTokenReadRequestSchema,gitEditorView,gitCheckPresentation,gitTokenView,gitTokenCommandResult} from '@jevellan/core';
import type {Application} from './application.js';
import {projectDefinitionDeviceOperation} from './project-definition-device.js';
const fail=(message:string,status=409)=>Object.assign(Error(message),{status});
export async function readGitEditor(app:Application){
 const [roster,projects]=await Promise.all([app.roster(),app.state.projects.list()]);
 return gitEditorView({schema:'git-editor-facts-v1',device:{id:app.device.deviceId,name:roster.devices.find(row=>row.device.id===app.device.deviceId)?.device.name??'this device'},settings:new GitSettings(app.homes).get(),projects:projects.map(row=>row.project)});
}
export async function checkGitProject(app:Application,raw:unknown){
 const input=GitCheckRequestSchema.parse(raw),project=(await app.conversations.projects()).projects.find(row=>row.project.id===input.projectId)?.project;
 if(!project)throw fail('Project not found.',404);
 const check=await new GitSettings(app.homes).check(project,app.device.deviceId,app.redactor,input.githubTransport);
 return {...check,presentation:gitCheckPresentation(check)};
}
export async function localGitEditorCommand(app:Application,raw:unknown){
 const request=GitEditorCommandSchema.parse(raw);if(request.deviceId!==app.device.deviceId)throw fail('These Git settings belong to another device.');
 if(request.operation==='save'){const view=await readGitEditor(app),settings=new GitSettings(app.homes).save(request.settings);return GitEditorSavedSchema.parse({schema:'git-editor-saved-v1',deviceId:app.device.deviceId,settings,message:view.saveMessage});}
 const check=await checkGitProject(app,request.input);return GitEditorCheckedSchema.parse({schema:'git-editor-checked-v1',deviceId:app.device.deviceId,check,presentation:gitCheckPresentation(check)});
}
export async function gitEditorDeviceOperation(app:Application,deviceId:string,raw?:unknown){
 if(raw===undefined)return deviceId===app.device.deviceId?readGitEditor(app):projectDefinitionDeviceOperation(app,deviceId,{schema:'project-definition-peer-request-v1',operation:'git-view'});
 const request=GitEditorCommandSchema.parse(raw);if(request.deviceId!==deviceId)throw fail('These Git settings belong to another device.');
 return deviceId===app.device.deviceId?localGitEditorCommand(app,request):projectDefinitionDeviceOperation(app,deviceId,{schema:'project-definition-peer-request-v1',operation:'git-command',input:request});
}
export async function readGitTokenEditor(app:Application,raw:unknown={schema:'github-token-read-v1'}){
 const input=GitTokenReadRequestSchema.parse(raw);return gitTokenView(await app.state.github.summary(input.projectId),input.projectId);
}
export async function applyGitTokenEditor(app:Application,raw:unknown){
 const request=GitTokenCommandSchema.parse(raw),state=request.operation==='save'?await app.state.github.put(request.input.value,request.input.clientRequestId,request.projectId):await app.state.github.remove(undefined,request.projectId);
 return gitTokenCommandResult(request,gitTokenView(state,request.projectId));
}
