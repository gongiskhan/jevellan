import{ProjectSetupWaitRequestSchema,waitForProjectSetupViews,type ProjectSetupView}from'@jevellan/core';
import type{Application}from'./application.js';
/** A caller's bounded wait is a read; timeout returns the last truthful state rather than claiming completion. */
export async function waitProjectSetupView(app:Application,projectId:string,deviceId=app.device.deviceId,raw:unknown={schema:'project-setup-wait-request-v1'}){
 const input=ProjectSetupWaitRequestSchema.parse(raw);
 if(!input.waitSeconds)return app.projectSetupView(projectId,deviceId);
 const signal=AbortSignal.timeout(input.waitSeconds*1000);let last:ProjectSetupView|undefined;
 try{return await waitForProjectSetupViews(async signal=>{last=await app.projectSetupView(projectId,deviceId,signal);return last;},signal);}
 catch(error){if(last&&(signal.aborted||last.state==='blocked'))return last;throw error;}
}
