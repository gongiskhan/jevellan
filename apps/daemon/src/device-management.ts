import {prepareDeviceAction,ownerTool,ownerToolAction,type OwnerToolResult,DeviceReadRequestSchema,deviceWorktreeView,deviceCleanupView,DeviceActionSchema,DeviceActionReceiptSchema,DeviceOriginSchema,DeviceViewSchema,CleanupStateSchema,WorktreeDiskSchema,ErrorDocumentSchema,deviceManagementView,deviceInvitationView} from '@jevellan/core';
import {UiAuth} from '@jevellan/mesh';
import type {Application} from './application.js';
import {localDeviceCleanup} from './device-cleanup-api.js';
import {localDeviceWorktrees} from './device-worktrees-api.js';
const fail=(message:string,status=409)=>Object.assign(new Error(message),{status});
export async function readDeviceManagement(app:Application,deviceId=app.device.deviceId){
 const roster=await app.roster();if(!roster.devices.some(row=>row.device.id===deviceId&&!row.revoked))throw fail('The requesting device is no longer available.');
 return deviceManagementView({schema:'device-management-facts-v1',roster:{...roster,currentDeviceId:deviceId},now:Date.now()});
}
async function withOwnerSession<T>(app:Application,run:(token:string)=>Promise<T>):Promise<T>{
 const auth=app.auth;if(!(auth instanceof UiAuth))throw fail('Owner tools must run on the state point.');
 const token=auth.issue();app.redactor.add(token);try{return await run(token);}finally{auth.logout(token);}
}
async function maintenanceOperation(app:Application,deviceId:string,kind:'cleanup'|'worktrees',method:'GET'|'POST',body?:unknown){
 if(deviceId===app.device.deviceId)return kind==='cleanup'?localDeviceCleanup(app,method,body):localDeviceWorktrees(app,method,body);
 const target=(await app.roster()).devices.find(row=>row.device.id===deviceId&&!row.revoked);if(!target||target.status==='offline')throw fail('This device is offline.');
 return withOwnerSession(app,async token=>{
  const url=new URL(DeviceOriginSchema.parse(target.device.url));url.pathname=`/api/mesh/devices/${deviceId}/${kind}`;
  let response:Response;try{response=await fetch(url,{method,redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${token}`,'X-Jevellan-Source-Device':app.device.deviceId,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw fail(`Can't reach ${target.device.name}.`,502);}
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw fail('The selected device returned an unexpected redirect.',502);}
  const raw:unknown=await response.json().catch(()=>null);if(!response.ok){const error=ErrorDocumentSchema.safeParse(raw);throw fail(error.success?error.data.message:'The selected device could not complete the request.',error.success?response.status:502);}
  const result=kind==='cleanup'?CleanupStateSchema.parse(raw):WorktreeDiskSchema.parse(raw);if(result.deviceId!==deviceId)throw fail('The reply belongs to another device.',502);return result;
 });
}
export async function createDeviceInvitation(app:Application){
 const roster=await app.roster(),hub=roster.devices.find(row=>row.device.role==='hub');if(!hub)throw fail('The hub is no longer available.');
 return deviceInvitationView(await app.inviteDevice(),hub.device.url);
}
export async function performDeviceAction(app:Application,raw:unknown,options:{ownerSession?:string;gatewayDeviceId?:string}={}){
 const action=DeviceActionSchema.parse(raw);
 if(action.operation==='invite')return DeviceActionReceiptSchema.parse({schema:'device-action-receipt-v1',operation:'invite',result:await createDeviceInvitation(app)});
 prepareDeviceAction(await readDeviceManagement(app,options.gatewayDeviceId??app.device.deviceId),action);
 const deviceId=action.input.deviceId;
 const session=<T>(run:(token:string)=>Promise<T>)=>options.ownerSession?run(options.ownerSession):withOwnerSession(app,run);
 const result=action.operation==='tags'?DeviceViewSchema.parse(await session(token=>app.updateDeviceTags(action.input,token))):action.operation==='paths'?DeviceViewSchema.parse(await session(token=>app.updateDeviceSettings(action.input,token))):action.operation==='clean'?await maintenanceOperation(app,deviceId,'cleanup','POST',{schema:'empty-request-v1'}):await maintenanceOperation(app,deviceId,'worktrees','POST',action.input.selection);
 return DeviceActionReceiptSchema.parse({schema:'device-action-receipt-v1',operation:action.operation,deviceId,result});
}

export async function readDevicePurpose(app:Application,kind:'cleanup'|'worktrees',raw:unknown,gatewayDeviceId=app.device.deviceId){
 const input=DeviceReadRequestSchema.parse(raw),management=await readDeviceManagement(app,gatewayDeviceId),result=await maintenanceOperation(app,input.deviceId,kind,'GET');
 return kind==='cleanup'?deviceCleanupView(management,input.deviceId,CleanupStateSchema.parse(result)):deviceWorktreeView(management,input.deviceId,WorktreeDiskSchema.parse(result));
}

/** A normal owner-authenticated issuance response may deliver its new one-use credential; other replies stay redacted. */
export function deviceToolReply(app:Application,name:string,args:Record<string,unknown>,result:OwnerToolResult,explicitAction?:string):OwnerToolResult{
 const tool=ownerTool(name),action=tool?ownerToolAction(tool,args,explicitAction):undefined,{action:_ignored,...rest}=args;void _ignored;
 const input=action?.input.safeParse(rest),request=input?.success?DeviceActionSchema.safeParse((input.data as {request?:unknown}).request):null;
 const receipt=result.ok?DeviceActionReceiptSchema.safeParse(result.data):null;
 const invitation=name==='config'&&action?.name==='device_action'&&request?.success&&request.data.operation==='invite'&&receipt?.success&&receipt.data.operation==='invite'?receipt.data.result:null;
 if(invitation)app.redactor.add(invitation.code);
 const safe=app.redactor.document(result);
 return invitation&&safe.ok?{...safe,data:{schema:'device-action-receipt-v1',operation:'invite',result:invitation}}:safe;
}
