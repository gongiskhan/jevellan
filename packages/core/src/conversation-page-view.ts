import {z} from 'zod';
import type {ConversationPublicSchema} from './conversation-schemas.js';
import {ActionSchema, TimestampSchema} from './schemas.js';
import {ConversationNoticeSchema} from './conversation-notice-schemas.js';
export const MANUAL_PICK_NOTICE='Pick the next step, model and effort.';

const stateLabels:Record<string,string>={'waiting-for-you':'Waiting for you',running:'Running',done:'Done',cancelled:'Cancelled',blocked:'Blocked',idle:'Ready'};
export const conversationStateLabel = (state:string) => stateLabels[state] ?? state;
export const conversationActionLabel = (action:string) => action==='ask-you'?'Ask you':action.split('-').map(word=>word[0]!.toUpperCase()+word.slice(1)).join(' ');
const stages={
 preparing:['Preparing your request','Checking the project and available accounts.'],
 deciding:['Jev is choosing the next step','Classifying the request and selecting a model and effort.'],
 memory:['Preparing context','Selecting relevant project memory for this step.'],
 starting:['Starting the agent','The step is selected. Waiting for its first response.'],
 running:['Agent is working','Responses and tool activity appear below as they arrive.'],
 saving:['Saving this step','Checking changes and recording the handoff.'],
 verifying:['Checking the result','Validating the work before marking it complete.'],
 publishing:['Verifying and publishing','Running the final checks and saving the result.'],
} as const;
export const ConversationProgressPhaseSchema=z.enum(['preparing','deciding','memory','starting','running','saving','verifying','publishing']);
export function conversationProgressPresentation(phase:z.infer<typeof ConversationProgressPhaseSchema>){const [title,description]=stages[phase];return {title,description};}
export const ConversationPagePresentationSchema=z.strictObject({schema:z.literal('conversation-page-presentation-v1'),lastNoticeId:z.number().int().positive().nullable(),stateLabel:z.string(),actionLabels:z.record(ActionSchema,z.string()),
 activity:z.strictObject({phase:ConversationProgressPhaseSchema,title:z.string(),description:z.string(),since:TimestampSchema}),
 picker:z.strictObject({shown:z.boolean(),heading:z.string().nullable()}),pause:z.strictObject({kind:z.enum(['none','manual-pick','other']),notice:z.string().nullable()}),
});
export type ConversationPagePresentation=z.infer<typeof ConversationPagePresentationSchema>;
type Facts=Pick<z.infer<typeof ConversationPublicSchema>,'conversation'|'closedWorks'|'stretches'|'busy'|'checkpointBlocks'|'finishes'|'pause'|'progress'|'openQuestion'>;
/** Policy over recorded server pause facts; it never interprets or routes a new owner message. */
export function conversationPagePresentation(view:Facts,lastNotice?:string,lastNoticeId:number|null=null):ConversationPagePresentation{
 const running=view.busy||view.conversation.state==='running',step=view.stretches.findLast(entry=>entry.status==='running');
 const phase=view.progress?.phase??(step?'running':'preparing'),activity=conversationProgressPresentation(phase),since=view.progress?.since??step?.startedAt??view.conversation.updatedAt;
 const target=view.conversation.work??view.closedWorks.at(-1),block=view.checkpointBlocks.filter(entry=>entry.workId===target?.id).at(-1),finishing=view.finishes.find(entry=>entry.status!=='completed');
 const reason=view.pause?.reason,suffixed=reason?.endsWith('Pick the next step:')??false,manual=suffixed||reason===MANUAL_PICK_NOTICE;
 const shown=!!(!running&&!finishing&&view.conversation.work&&!view.pause?.guard&&!block&&manual);
 const notice=reason!==undefined&&!(suffixed&&(shown||running))&&reason!==lastNotice&&reason!==view.openQuestion?.text?reason.replace(/\s*Pick the next step:$/,''):null;
 return ConversationPagePresentationSchema.parse({schema:'conversation-page-presentation-v1',lastNoticeId,stateLabel:conversationStateLabel(view.conversation.state),actionLabels:Object.fromEntries(ActionSchema.options.map(action=>[action,conversationActionLabel(action)])),activity:{phase,...activity,since},picker:{shown,heading:suffixed?reason:null},pause:{kind:reason===undefined?'none':manual?'manual-pick':'other',notice}});
}


type NoticeSource={id:number;data:unknown};
/** Reverse traversal avoids hydrating old transcript payloads when the newest notice is already known. */
export function latestConversationNotice<T extends NoticeSource>(events:readonly T[],read:(event:T)=>unknown=event=>event.data):{id:number;text:string}|undefined{
 for(let index=events.length-1;index>=0;index--){const event=events[index]!,parsed=ConversationNoticeSchema.safeParse(read(event));if(parsed.success)return {id:event.id,text:parsed.data.text};}
 return undefined;
}
/** A newer live notice uses the same policy until the normal root read catches up. */
export function conversationPagePresentationForStream(view:z.infer<typeof ConversationPublicSchema>,events:readonly NoticeSource[]):ConversationPagePresentation{
 const notice=latestConversationNotice(events),prepared=view.presentation;
 if(prepared&&(!notice||notice.id<=(prepared.lastNoticeId??0)))return prepared;
 return conversationPagePresentation(view,notice?.text,notice?.id??null);
}
