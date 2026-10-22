import {RiggingEditorReadSchema,RiggingEditorViewSchema,RiggingEditorActionSchema,RiggingEditorDetailReadSchema,RiggingEditorDetailSchema,RiggingEditorReceiptSchema,riggingEditorView,riggingAddInput,riggingToggleInput,riggingActionResult} from '@jevellan/core';
import type {Application} from './application.js';
import {projectDefinitionDeviceOperation} from './project-definition-device.js';
const fail=(message:string,status=409)=>Object.assign(Error(message),{status});
const runtimes=(app:Application)=>[...app.runtimes.values()].map(runtime=>({id:runtime.id,label:runtime.displayName,supportedKinds:runtime.riggingKinds}));
export async function readRiggingEditor(app:Application,raw:unknown={schema:'rigging-editor-read-v1'}){
 const query=RiggingEditorReadSchema.parse(raw),[accounts,projects,items]=await Promise.all([app.accounts.list(),app.state.projects.list(),app.rigging.list()]);
 return riggingEditorView({schema:'rigging-editor-facts-v1',deviceId:app.device.deviceId,runtimes:runtimes(app),projects:projects.map(row=>({id:row.project.id,name:row.project.name})),accounts:accounts.map(row=>({id:row.account.id,label:row.account.label,runtime:row.account.runtime})),items,application:app.riggingApplication(),disk:app.riggingDisk.list(accounts.map(row=>row.account))},query);
}
async function admit(app:Application,ref:{runtime:string;accountId:string}){if(!(await app.accounts.list()).some(row=>row.account.id===ref.accountId&&row.account.runtime===ref.runtime))throw fail('Account not found.',404);}
export async function localRiggingDetail(app:Application,raw:unknown){const input=RiggingEditorDetailReadSchema.parse(raw);if(input.deviceId!==app.device.deviceId)throw fail('These rigging files belong to another device.');await admit(app,input.ref);return RiggingEditorDetailSchema.parse({schema:'rigging-editor-detail-v1',deviceId:app.device.deviceId,detail:app.riggingDisk.detail(input.ref.runtime,input.ref.accountId,input.ref.id)});}
export async function localRiggingAction(app:Application,raw:unknown){
 const request=RiggingEditorActionSchema.parse(raw);if(request.deviceId!==app.device.deviceId)throw fail('These rigging settings belong to another device.');
 let result:unknown;
 if(request.operation==='apply')result=await app.applyRigging();
 else if(request.operation==='add'||request.operation==='update'||request.operation==='toggle'){
  const clientRequestId=request.clientRequestId??('input'in request?request.input.clientRequestId:undefined);
  if('input'in request&&request.clientRequestId&&request.input.clientRequestId&&request.clientRequestId!==request.input.clientRequestId)throw fail('Rigging request identities do not match.');
  let item;
  if(request.operation==='add')item=await app.rigging.add({...riggingAddInput(request.input,runtimes(app)),...(clientRequestId?{clientRequestId}:{})});
  else if(request.operation==='update')item=await app.rigging.update(request.id,{...request.input,...(clientRequestId?{clientRequestId}:{})});
  else{const current=request.captured;if(current.item.id!==request.id||current.revision!==request.revision)throw fail('The captured rigging item does not match this toggle.');item=await app.rigging.update(request.id,{...riggingToggleInput(current,request.runtime,request.enabled,runtimes(app)),...(clientRequestId?{clientRequestId}:{})});}
  result={schema:'rigging-save-v1',item,application:await app.applyRigging()};
 }else{
  const {runtime,accountId,id}=request.ref;await admit(app,request.ref);
  if(request.operation==='edit')result=await app.riggingDisk.edit(runtime,accountId,id,request.input);
  else if(request.operation==='move')result=await app.riggingDisk.transition(runtime,accountId,id,request.input);
  else if(request.operation==='cancel')result=await app.riggingDisk.cancel(runtime,accountId,id,request.input);
  else if(request.operation==='cancel-promotion')result=await app.riggingDisk.cancelPromotion(runtime,accountId,id,request.input);
  else{const item=await app.riggingDisk.promote(runtime,accountId,id,request.input,app.rigging);result={schema:'rigging-save-v1',item,application:await app.applyRigging()};}
 }
 return riggingActionResult(request,RiggingEditorReceiptSchema.parse({schema:'rigging-editor-receipt-v1',deviceId:app.device.deviceId,operation:request.operation,...('ref'in request?{ref:request.ref}:{}),result}));
}
export async function riggingDeviceOperation(app:Application,deviceId:string,operation:'view'|'detail'|'action',raw?:unknown){
 if(operation==='view'){const input=RiggingEditorReadSchema.parse(raw??{schema:'rigging-editor-read-v1'});return deviceId===app.device.deviceId?readRiggingEditor(app,input):projectDefinitionDeviceOperation(app,deviceId,{schema:'project-definition-peer-request-v1',operation:'rigging-view',input});}
 const input=operation==='detail'?RiggingEditorDetailReadSchema.parse(raw):RiggingEditorActionSchema.parse(raw);if(input.deviceId!==deviceId)throw fail('These rigging settings belong to another device.');
 return deviceId===app.device.deviceId?operation==='detail'?localRiggingDetail(app,input):localRiggingAction(app,input):projectDefinitionDeviceOperation(app,deviceId,{schema:'project-definition-peer-request-v1',operation:operation==='detail'?'rigging-detail':'rigging-action',input});
}
export {RiggingEditorViewSchema};
