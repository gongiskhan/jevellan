import {z} from 'zod';
import type {Stretch} from './schemas.js';

export const ConversationStepDetailsSchema=z.strictObject({schema:z.literal('conversation-step-details-v1'),effortLabel:z.string(),tokens:z.number().int().nonnegative(),usageLabel:z.string().nullable()});
export const ConversationResultInputSchema=z.strictObject({schema:z.literal('conversation-result-input-v1'),kind:z.enum(['plan','answer']),fallback:z.string().optional(),content:z.unknown().optional()});
export const ConversationResultPresentationSchema=z.strictObject({schema:z.literal('conversation-result-presentation-v1'),kind:z.enum(['plan','answer']),contentText:z.string(),text:z.string(),source:z.enum(['content','fallback','loading']),className:z.enum(['plan-result','answer-result'])});

const compactNumber=(value:number)=>value<1000?String(value):value<1_000_000?`${(value/1000).toFixed(value<10_000?1:0)}k`:`${(value/1_000_000).toFixed(1)}M`;
export function conversationStepDetails(step:Pick<Stretch,'effortRequested'|'effortEffective'|'usage'>){
 const tokens=step.usage.inputTokens+step.usage.outputTokens,cost=step.usage.costUsd;
 const usageLabel=tokens>0||cost!==undefined?`${tokens>0?`${compactNumber(tokens)} tokens`:''}${cost!==undefined?`${tokens>0?' · ':''}$${cost.toFixed(3)}${step.usage.costSource==='estimated'?' est.':''}`:''}`:null;
 return ConversationStepDetailsSchema.parse({schema:'conversation-step-details-v1',effortLabel:step.effortRequested===step.effortEffective?step.effortEffective:`${step.effortRequested} → ${step.effortEffective}`,tokens,usageLabel});
}

export function conversationResultPresentation(raw:unknown){
 const input=ConversationResultInputSchema.parse(raw),contentText=typeof input.content==='string'?input.content:JSON.stringify(input.content,null,2)??'';
 return ConversationResultPresentationSchema.parse({schema:'conversation-result-presentation-v1',kind:input.kind,contentText,text:contentText||input.fallback||`Loading the full ${input.kind}…`,source:contentText?'content':input.fallback?'fallback':'loading',className:input.kind==='plan'?'plan-result':'answer-result'});
}
