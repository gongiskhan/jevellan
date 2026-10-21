import {z} from 'zod';
import {IdSchema,ConversationStateSchema} from './schemas.js';
import {CheckpointBlockSchema,FinishOutsideOperationSchema,RedoOperationSchema,type ConversationPublicSchema} from './conversation-schemas.js';
import {conversationStateLabel} from './conversation-page-view.js';
// Lazy references keep the public conversation document's optional projection backward compatible.
const finish=z.lazy(()=>FinishOutsideOperationSchema),checkpoint=z.lazy(()=>CheckpointBlockSchema.extend({eventId:z.number().int().positive()}));
export const ConversationControlsViewSchema=z.strictObject({
 schema:z.literal('conversation-controls-view-v1'),running:z.boolean(),state:ConversationStateSchema,stateLabel:z.string(),
 settlement:z.strictObject({target:z.strictObject({id:IdSchema}).nullable(),available:z.boolean(),kept:z.boolean(),shown:z.boolean(),label:z.string()}),
 finishing:finish.nullable(),blockedFinish:finish.nullable(),canFinishOutside:z.boolean(),checkpointBlock:checkpoint.nullable(),
 messageActions:z.strictObject({canEdit:z.boolean(),canRetry:z.boolean()}),
 recovery:z.strictObject({externalRetry:z.boolean(),decision:z.boolean(),accountIds:z.array(IdSchema),checkpoint:checkpoint.nullable(),redos:z.array(z.lazy(()=>RedoOperationSchema))}),
 question:z.strictObject({stretch:z.number().int().positive(),text:z.string(),options:z.array(z.strictObject({index:z.number().int().nonnegative(),label:z.string(),detail:z.string().optional(),primary:z.boolean()}))}).nullable(),
});
type Facts=Pick<z.infer<typeof ConversationPublicSchema>,'conversation'|'closedWorks'|'settlements'|'busy'|'finishes'|'checkpointBlocks'|'pause'|'decisionWait'|'externalWait'|'redos'|'openQuestion'>;
/** Projects recorded state; admission and all mutations remain in the canonical writer. */
export function conversationControlsView(view:Facts){
 const running=view.busy||view.conversation.state==='running',target=view.conversation.work??view.closedWorks.at(-1),last=view.settlements.filter(row=>row.workId===target?.id).at(-1);
 const available=!!target&&target.closedAs!=='done'&&(!!view.conversation.work||!last||last.status!=='completed'||!!last.retained),kept=!view.conversation.work&&available;
 const finishing=view.finishes.find(row=>row.status!=='completed')??null,block=view.checkpointBlocks.filter(row=>row.workId===target?.id).at(-1)??null;
 const canEdit=!running&&!kept&&!finishing&&!block,decision=!!(!running&&view.decisionWait&&!view.pause?.guard&&!block),question=view.openQuestion;
 return ConversationControlsViewSchema.parse({schema:'conversation-controls-view-v1',running,state:running?'running':view.conversation.state,stateLabel:running?'Working':conversationStateLabel(view.conversation.state),
  settlement:{target:target?{id:target.id}:null,available,kept,shown:!running&&!finishing&&available,label:view.conversation.work?'Close this work':'Settle kept changes'},
  finishing,blockedFinish:finishing?.status==='blocked'?finishing:null,canFinishOutside:!finishing&&!view.conversation.outcome,checkpointBlock:block,
  messageActions:{canEdit,canRetry:canEdit&&!view.pause?.guard},
  recovery:{externalRetry:!!(!running&&view.externalWait&&!block&&!finishing),decision,accountIds:decision?[...new Set(view.decisionWait!.reasons.flatMap(reason=>reason.accountIds))]:[],checkpoint:running?null:block,
   redos:running?[]:view.redos.filter(row=>row.status==='blocked'&&(row.workId===target?.id||!!(row.followingWorkId&&row.followingWorkId===view.conversation.work?.id&&row.workId===view.closedWorks.at(-1)?.id)))},
  question:question&&question.options.length?{stretch:question.stretch,text:question.text,options:question.options.map((option,index)=>({...option,index,primary:index===0}))}:null,
 });
}
