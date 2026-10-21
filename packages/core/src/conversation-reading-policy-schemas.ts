import {z} from 'zod';
import {IdSchema,TimestampSchema} from './schemas.js';
import {ConversationProgressPhaseSchema} from './conversation-page-view.js';
import {ConversationStepDetailsSchema,ConversationResultPresentationSchema} from './conversation-result-policy.js';

const scope={schema:z.literal('conversation-reading-view-v1'),projectId:IdSchema,conversationId:IdSchema};
export const ConversationTranscriptReadingSchema=z.strictObject({schema:z.literal('conversation-transcript-reading-v1'),visibleActivityIds:z.array(z.string()),showFallback:z.boolean(),showStreamedReply:z.boolean()});
export const ConversationActivityReadingSchema=z.strictObject({...scope,kind:z.literal('activity'),phase:ConversationProgressPhaseSchema,title:z.string(),description:z.string(),since:TimestampSchema,toolLabel:z.string().nullable()});
export const ConversationStepReadingSchema=z.strictObject({...scope,kind:z.literal('step'),step:z.number().int().positive(),actionable:z.boolean(),editable:z.boolean(),findings:z.array(z.strictObject({claim:z.string(),pointer:z.string()})),blockers:z.array(z.string()),question:z.string().nullable(),recordedAnswer:z.strictObject({ref:z.string(),fallback:z.string()}).nullable(),fullResult:z.string().nullable(),planResult:z.string().nullable(),transcript:ConversationTranscriptReadingSchema.nullable(),details:ConversationStepDetailsSchema.optional()});
export const ConversationNoticeReadingSchema=z.strictObject({...scope,kind:z.literal('notice'),eventId:z.number().int().positive(),notice:z.strictObject({shown:z.boolean(),tone:z.enum(['error','notice']),text:z.string()}).nullable()});
export const ConversationChangesReadingSchema=z.strictObject({...scope,kind:z.literal('changes'),step:z.number().int().positive(),showAcceptance:z.boolean(),showUncommitted:z.boolean(),hasEvidence:z.boolean(),noVerifications:z.boolean(),fileSourceLabels:z.array(z.string()),evidenceFileFlags:z.array(z.boolean()),verificationVerdicts:z.array(z.strictObject({id:IdSchema,label:z.enum(['Passed','Failed'])}))});
export const ConversationResultReadingSchema=z.strictObject({...scope,kind:z.literal('result'),pointer:z.string().min(1),presentation:ConversationResultPresentationSchema});
export const ConversationReadingViewSchema=z.discriminatedUnion('kind',[ConversationActivityReadingSchema,ConversationStepReadingSchema,ConversationNoticeReadingSchema,ConversationChangesReadingSchema,ConversationResultReadingSchema]);
export const ConversationReadingRequestSchema=z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('conversation-reading-request-v1'),kind:z.literal('activity')}),
 z.strictObject({schema:z.literal('conversation-reading-request-v1'),kind:z.literal('step'),step:z.number().int().positive()}),
 z.strictObject({schema:z.literal('conversation-reading-request-v1'),kind:z.literal('notice'),eventId:z.number().int().positive()}),
 z.strictObject({schema:z.literal('conversation-reading-request-v1'),kind:z.literal('changes'),step:z.number().int().positive()}),
 z.strictObject({schema:z.literal('conversation-reading-request-v1'),kind:z.literal('result'),pointer:z.string().min(1),displayKind:z.enum(['plan','answer']),fallback:z.string().optional()}),
]);
