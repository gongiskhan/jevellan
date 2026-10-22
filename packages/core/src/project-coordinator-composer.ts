import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {EmptySchema} from './client-schemas.js';
import {CoordinatorMessageRequestSchema} from './project-schemas.js';
import type {ProjectCoordinatorUiSchema} from './project-page-schemas.js';

export const ProjectRequestPolicySchema=z.strictObject({schema:z.literal('project-request-policy-v1'),retryIdentity:z.literal('payload-until-success'),cancelled:z.literal('ignore'),unauthorized:z.literal('global'),other:z.literal('local')});
export const PROJECT_REQUEST_POLICY=Object.freeze(ProjectRequestPolicySchema.parse({schema:'project-request-policy-v1',retryIdentity:'payload-until-success',cancelled:'ignore',unauthorized:'global',other:'local'}));
export const ProjectClientRequestStateSchema=z.strictObject({schema:z.literal('project-client-request-state-v1'),signature:z.string().optional(),id:IdSchema});
/** The generator is transport-owned. Preserve exact JSON signatures, including property order. */
export function projectClientIds(mint:()=>string){
 let pending:z.infer<typeof ProjectClientRequestStateSchema>|undefined;
 return{id(prefix:string,value:unknown){const signature=JSON.stringify(value);if(pending?.signature!==signature)pending=ProjectClientRequestStateSchema.parse({schema:'project-client-request-state-v1',signature,id:`${prefix}_${mint()}`});return pending!.id;},done(){pending=undefined;}};
}
export const projectFailureText=(failure:unknown)=>failure instanceof Error?failure.message:String(failure);
export const ProjectLocalFailureContextSchema=z.strictObject({schema:z.literal('project-local-failure-context-v1'),cancelled:z.boolean(),apiStatus:z.number().int().nonnegative().optional()});
export const ProjectLocalFailureSchema=z.strictObject({schema:z.literal('project-local-failure-v1'),route:z.enum(['ignore','global','local']),text:z.string().nullable()});
/** API instance identity stays with the transport; a plain object's status is not authentication evidence. */
export function projectLocalFailure(failure:unknown,raw:unknown){
 const context=ProjectLocalFailureContextSchema.parse(raw),route=context.cancelled?'ignore':context.apiStatus===401?'global':'local';
 return ProjectLocalFailureSchema.parse({schema:'project-local-failure-v1',route,text:route==='local'?projectFailureText(failure):null});
}
export const ProjectCoordinatorComposerContextSchema=z.strictObject({schema:z.literal('project-coordinator-composer-context-v1'),projectId:IdSchema,deviceId:IdSchema,working:z.boolean(),offline:z.boolean(),offlineText:z.string(),canFresh:z.boolean(),canMove:z.boolean(),moveEnabled:z.boolean(),moveRefusal:z.string().nullable()});
export const ProjectCoordinatorComposerSchema=ProjectCoordinatorComposerContextSchema.omit({schema:true}).extend({schema:z.literal('project-coordinator-composer-v1'),canSend:z.boolean(),canStop:z.boolean(),textLimit:z.number().int().positive(),requestPolicy:ProjectRequestPolicySchema});
export type ProjectCoordinatorComposer=z.infer<typeof ProjectCoordinatorComposerSchema>;
export const ProjectCoordinatorComposerInputSchema=z.strictObject({schema:z.literal('project-coordinator-composer-input-v1'),text:z.string(),attachmentCount:z.number().int().nonnegative(),sending:z.boolean(),stopping:z.boolean()});
export const ProjectCoordinatorComposerStateSchema=z.strictObject({schema:z.literal('project-coordinator-composer-state-v1'),canSend:z.boolean(),showStop:z.boolean(),canStop:z.boolean()});
export function projectCoordinatorComposer(raw:unknown):ProjectCoordinatorComposer{
 const {schema:_schema,...context}=ProjectCoordinatorComposerContextSchema.parse(raw);void _schema;
 return ProjectCoordinatorComposerSchema.parse({schema:'project-coordinator-composer-v1',...context,canSend:!context.offline,canStop:context.working,textLimit:CoordinatorMessageRequestSchema.shape.text.maxLength,requestPolicy:PROJECT_REQUEST_POLICY});
}
export function projectCoordinatorComposerFromUi(projectId:string,deviceId:string,ui:z.infer<typeof ProjectCoordinatorUiSchema>){return projectCoordinatorComposer({schema:'project-coordinator-composer-context-v1',projectId,deviceId,working:ui.working,offline:ui.offline,offlineText:ui.offlineNotice??'',canFresh:ui.controls.canFresh,canMove:ui.controls.canMove,moveEnabled:ui.controls.moveEnabled,moveRefusal:ui.controls.moveRefusal});}
export function projectCoordinatorComposerState(model:ProjectCoordinatorComposer,raw:unknown){const input=ProjectCoordinatorComposerInputSchema.parse(raw);return ProjectCoordinatorComposerStateSchema.parse({schema:'project-coordinator-composer-state-v1',canSend:model.canSend&&!input.sending&&(!!input.text.trim()||input.attachmentCount>0),showStop:model.canStop,canStop:model.canStop&&!input.stopping});}
export function projectCoordinatorClearedText(current:string,sent:string){return current===sent?'':current;}
const base={schema:z.literal('project-coordinator-command-v1'),projectId:IdSchema};
export const ProjectCoordinatorCommandSchema=z.discriminatedUnion('operation',[
 z.strictObject({...base,operation:z.literal('message'),body:CoordinatorMessageRequestSchema}),
 z.strictObject({...base,operation:z.enum(['stop','fresh','move']),body:EmptySchema}),
]);
export type ProjectCoordinatorCommand=z.infer<typeof ProjectCoordinatorCommandSchema>;
export const ProjectCoordinatorTransportSchema=z.strictObject({schema:z.literal('project-coordinator-transport-v1'),path:z.string(),target:z.enum(['local','coordinator']),waitForHub:z.boolean(),response:z.enum(['message','work']),status:z.union([z.literal(200),z.literal(202)])});
export function projectCoordinatorMessageCommand(projectId:string,clientMessageId:string,text:string){return ProjectCoordinatorCommandSchema.parse({schema:'project-coordinator-command-v1',projectId,operation:'message',body:{schema:'coordinator-message-request-v1',clientMessageId,text}});}
export function projectCoordinatorControlCommand(projectId:string,operation:'stop'|'fresh'|'move'){return ProjectCoordinatorCommandSchema.parse({schema:'project-coordinator-command-v1',projectId,operation,body:{schema:'empty-request-v1'}});}
export function projectCoordinatorTransport(raw:unknown){const command=ProjectCoordinatorCommandSchema.parse(raw),message=command.operation==='message',move=command.operation==='move';return ProjectCoordinatorTransportSchema.parse({schema:'project-coordinator-transport-v1',path:`/api/projects/${command.projectId}/coordinator/${message?'messages':command.operation}`,target:move?'local':'coordinator',waitForHub:message||move,response:message?'message':'work',status:move?200:202});}
