import {ownerTool,ownerToolAction} from './owner-tool-catalog.js';
import {deviceMaintenanceAction} from './device-management.js';
import type {OwnerToolRequest} from './owner-tool-schemas.js';
/** Closed validated maintenance purposes acquire their canonical exclusive lease instead of a conflicting shared lease. */
export function ownerToolMaintenance(name:string,request:OwnerToolRequest):boolean{
 if(name!=='config')return false;
 const tool=ownerTool(name),action=tool?ownerToolAction(tool,request.args,request.action):undefined;
 if(action?.name!=='device_action')return false;
 const {action:_ignored,...args}=request.args;void _ignored;
 const parsed=action.input.safeParse(args);
 return parsed.success&&deviceMaintenanceAction((parsed.data as {request?:unknown}).request);
}
