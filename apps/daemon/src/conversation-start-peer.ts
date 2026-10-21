import type{IncomingMessage,ServerResponse}from'node:http';
import{ConversationStartRequestSchema,ConversationStartResultSchema,DeviceOriginSchema,ErrorDocumentSchema,PeerLoginSessionInputSchema}from'@jevellan/core';
import{UiAuth}from'@jevellan/mesh';
import type{Application}from'./application.js';
import{json,requestBody}from'./http.js';
import{OWNER_REQUEST_TIMEOUT_MS}from'./owner-proxy.js';
const path='/api/mesh/conversation-start';
const refuse=(message:string,status:number)=>Object.assign(new Error(message),{status});
export async function handleConversationStartPeer(app:Application,request:IncomingMessage,response:ServerResponse){
 if(request.method!=='POST')throw refuse('Unsupported creation operation.',405);
 if(request.headers.origin||request.headers['sec-fetch-site'])throw refuse('Use the device connection for this request.',403);
 const authorization=request.headers.authorization,caller=PeerLoginSessionInputSchema.safeParse({schema:'peer-login-session-input-v1',sourceDeviceId:request.headers['x-jevellan-source-device'],token:authorization?.startsWith('Bearer ')?authorization.slice(7):undefined});
 if(!caller.success||!await app.peerLoginAuthenticated(caller.data))throw refuse('Sign in to Jevellan.',401);
 app.redactor.add(caller.data.token);const input=ConversationStartRequestSchema.parse(await requestBody(request));
 const known=await app.conversations.location(input.start.id).catch(error=>{if((error as{status?:number}).status===404)return undefined;throw error;});
 if((known?.ownerDeviceId??input.deviceId)!==app.device.deviceId)throw refuse('The conversation is already owned by another device.',409);
 json(response,app.redactor.document(await app.startConversation(input)));
}
export async function conversationStartDeviceOperation(app:Application,deviceId:string,raw:unknown,signal?:AbortSignal,ownerToken?:string){
 const input=ConversationStartRequestSchema.parse(raw),target=(await app.roster()).devices.find(row=>row.device.id===deviceId);
 if(!target||target.revoked)throw refuse('The creation device is no longer available in this mesh.',409);
 if(target.status==='offline')throw refuse(`${target.device.name} is offline. Its work remains there.`,409);
 signal?.throwIfAborted();const auth=app.auth instanceof UiAuth?app.auth:undefined;
 if(!ownerToken&&!auth)throw refuse('Owner tools must run on the state point.',409);
 const token=ownerToken??auth!.issue();app.redactor.add(token);
 try{
  const url=new URL(DeviceOriginSchema.parse(target.device.url));url.pathname=path;
  const timeout=AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS+input.waitSeconds*1000);let response:Response;
  try{response=await fetch(url,{method:'POST',redirect:'manual',signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{Authorization:`Bearer ${token}`,'X-Jevellan-Source-Device':app.device.deviceId,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)});}
  catch{throw refuse(`Can't reach ${target.device.name}. Its work remains there.`,502);}
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw refuse('The creation device returned an unexpected redirect.',502);}
  const reply:unknown=await response.json().catch(()=>null);
  if(!response.ok){const error=ErrorDocumentSchema.safeParse(reply);throw refuse(error.success?error.data.message:'The creation device could not complete the request.',error.success?response.status:502);}
  const result=ConversationStartResultSchema.parse(reply);
  if(result.setup&&(result.setup.deviceId!==deviceId||result.setup.projectId!==input.start.projectId)||result.view&&(result.view.conversation.id!==input.start.id||result.view.conversation.projectId!==input.start.projectId||result.view.conversation.ownerDeviceId!==deviceId))throw refuse('The returned creation belongs to another device or project.',502);
  return result;
 }finally{if(!ownerToken)auth!.logout(token);}
}
