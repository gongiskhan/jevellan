import {IdSchema,conversationNewSource,conversationNewView} from '@jevellan/core';
import type {Application} from './application.js';

/** The same project/account/Jev/device readers used by the normal workspace; no eligibility or meaning inference. */
export async function readConversationNewSource(app:Application,deviceId=app.device.deviceId){
 const selected=IdSchema.parse(deviceId);await app.conversations.ready;
 const [projects,accounts,roster,jev]=await Promise.all([app.conversations.projects(),app.accounts.list(),app.roster(),app.state.jev.summary()]);
 const row=roster.devices.find(row=>row.device.id===selected);
 if(!row||row.revoked)throw Object.assign(new Error('This device is no longer available.'),{status:409});
 return conversationNewSource(app.redactor.document({schema:'conversation-new-facts-v1',projects:projects.projects.map(row=>row.project),device:{id:row.device.id,name:row.device.name},accountCount:accounts.length,jevSaved:jev.saved}));
}
export async function readConversationNewView(app:Application,request?:unknown,deviceId=app.device.deviceId){return conversationNewView(await readConversationNewSource(app,deviceId),request);}
