import {appShellView} from '@jevellan/core';
import type {Application} from './application.js';
import {projectDefinitionDeviceOperation} from './project-definition-device.js';
/** Normal state reads only: never checks, signs in or changes an account. */
export async function readAppShell(app:Application){
 const [roster,auth]=await Promise.all([app.roster(),app.auth.state(undefined)]);
 return appShellView(roster,auth);
}
export async function appShellDeviceView(app:Application,deviceId:string){
 return deviceId===app.device.deviceId?readAppShell(app):projectDefinitionDeviceOperation(app,deviceId,{schema:'project-definition-peer-request-v1',operation:'app-view'});
}
