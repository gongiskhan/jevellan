import type {z} from 'zod';
import type {LedgerEvent} from './schemas.js';
import type {ConversationChangesSchema,ConversationPublicSchema} from './conversation-schemas.js';
import type {ConversationTranscriptView} from './conversation-transcript-view-schemas.js';
import {ConversationNoticeSchema} from './conversation-notice-schemas.js';
import {conversationPagePresentation} from './conversation-page-view.js';
import {conversationNoticeHidden} from './conversation-transcript-view.js';
import {conversationStepDetails} from './conversation-result-policy.js';
import {ConversationActivityReadingSchema,ConversationStepReadingSchema,ConversationNoticeReadingSchema,ConversationChangesReadingSchema,ConversationTranscriptReadingSchema} from './conversation-reading-policy-schemas.js';

type View=z.infer<typeof ConversationPublicSchema>;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const scope=(view:Pick<View,'conversation'>)=>({schema:'conversation-reading-view-v1',projectId:view.conversation.projectId,conversationId:view.conversation.id});
const failure=(message:string,status=409)=>Object.assign(new Error(message),{status});

export function conversationActivityReading(view:View,events:readonly LedgerEvent[]){
 const step=view.stretches.findLast(entry=>entry.status==='running'),activity=(view.presentation??conversationPagePresentation(view)).activity;
 const latest=step&&events.findLast(event=>event.stretch===step.n&&event.type==='tool-start'),tool=latest&&object(latest.data);
 // Preserve the existing global end-id match, rather than narrowing it to one step.
 const pending=tool&&!events.some(event=>event.type==='tool-end'&&object(event.data).id===tool.id),toolLabel=activity.phase==='running'&&pending?String(tool.name):null;
 return ConversationActivityReadingSchema.parse({...scope(view),kind:'activity',...activity,description:toolLabel===null?activity.description:`Using ${toolLabel}…`,toolLabel});
}

export function conversationTranscriptReading(view:ConversationTranscriptView,recordedAnswer:boolean){
 const knownTurns=new Set(view.turns.map(turn=>turn.id)),answers=new Set(view.answerIds.filter(id=>knownTurns.has(id)));
 return ConversationTranscriptReadingSchema.parse({schema:'conversation-transcript-reading-v1',visibleActivityIds:view.activity.filter(row=>!recordedAnswer||row.kind!=='response'||!answers.has(row.id)).map(row=>row.id),showFallback:!recordedAnswer&&!!view.fallbackAnswer,showStreamedReply:recordedAnswer&&view.turns.some(turn=>answers.has(turn.id))});
}

export function conversationStepReading(view:View,n:number,events:readonly LedgerEvent[],transcript?:ConversationTranscriptView){
 const step=view.stretches.find(entry=>entry.n===n);if(!step)throw failure('Step not found.',404);
 if(transcript&&(transcript.projectId!==view.conversation.projectId||transcript.conversationId!==view.conversation.id||transcript.step!==n))throw failure('This transcript belongs to another step, conversation or project.');
 const handoff=view.handoffs.find(entry=>entry.stretch===n),actionable=!!view.conversation.work&&view.stretches.findLast(entry=>entry.workId===view.conversation.work!.id&&entry.status!=='undone')?.n===n;
 const editable=step.status!=='undone'&&[view.conversation.work?.id,view.closedWorks.at(-1)?.id].includes(step.workId);
 const findings=[...events.filter(event=>event.type==='finding').map(event=>({claim:String(object(event.data).claim??''),pointer:String(object(event.data).pointer??'')})),...(handoff?.findings??[])].filter((finding,index,all)=>all.findIndex(entry=>entry.claim===finding.claim&&entry.pointer===finding.pointer)===index);
 const recordedAnswer=handoff?.result?.type==='answer'?{ref:handoff.result.ref,fallback:handoff.summary}:null;
 return ConversationStepReadingSchema.parse({...scope(view),kind:'step',step:n,actionable,editable,findings,blockers:actionable?handoff?.blockers??[]:[],question:actionable&&handoff?.question&&view.openQuestion?.stretch!==n?handoff.question:null,recordedAnswer,fullResult:handoff?.result&&handoff.result.type!=='plan'?handoff.result.ref:null,planResult:handoff?.result?.type==='plan'?handoff.result.ref:null,transcript:transcript?conversationTranscriptReading(transcript,recordedAnswer!==null):null,details:conversationStepDetails(step)});
}

export function conversationNoticeReading(view:View,event:LedgerEvent,events:readonly LedgerEvent[],transcripts:Readonly<Record<number,ConversationTranscriptView|undefined>>={}){
 const parsed=ConversationNoticeSchema.safeParse(event.data);let notice:z.infer<typeof ConversationNoticeReadingSchema>['notice']=null;
 if(parsed.success){
  const step=event.stretch??view.stretches.at(-1)?.n??0,hidden=parsed.data.kind==='closing'&&conversationNoticeHidden(transcripts[step],event,{projectId:view.conversation.projectId,conversationId:view.conversation.id,step,head:events.at(-1)?.id??0,running:view.stretches.find(entry=>entry.n===step)?.status==='running',events:events.filter(entry=>entry.stretch===step),summaries:view.handoffs.map(row=>row.summary),summary:view.handoffs.find(row=>row.stretch===step)?.summary});
  notice={shown:!hidden,tone:parsed.data.kind==='error'?'error':'notice',text:parsed.data.text};
 }
 return ConversationNoticeReadingSchema.parse({...scope(view),kind:'notice',eventId:event.id,notice});
}

/** Compact display metadata over the existing canonical changes document; no diff is posted back. */
export function conversationChangesReading(view:Pick<View,'conversation'>,changes:z.infer<typeof ConversationChangesSchema>){
 if(changes.projectId!==undefined&&changes.projectId!==view.conversation.projectId||changes.conversationId!==undefined&&changes.conversationId!==view.conversation.id)throw failure('These changes belong to another conversation or project.');
 return ConversationChangesReadingSchema.parse({...scope(view),kind:'changes',step:changes.stretch,showAcceptance:!!changes.recovery,showUncommitted:!!changes.uncommitted,hasEvidence:changes.evidence.length>0,noVerifications:changes.verifications.length===0,fileSourceLabels:changes.files.map(file=>file.source==='step'?'Recorded step':'Working copy'),evidenceFileFlags:changes.evidence.map(item=>item.kind==='file'||item.kind==='screenshot'),verificationVerdicts:changes.verifications.map(receipt=>({id:receipt.id,label:receipt.passed&&receipt.headStable&&(receipt.treeClean||receipt.worktreeBefore===receipt.worktreeAfter&&!!receipt.worktreeBefore)?'Passed':'Failed'}))});
}
