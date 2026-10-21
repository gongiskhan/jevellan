import {z} from 'zod';
import {IdSchema,ProjectSchema} from './schemas.js';
const Device=z.strictObject({id:IdSchema,name:z.string()});
const Project=z.strictObject({id:IdSchema,name:z.string(),available:z.boolean()});
export const ConversationNewSourceRequestSchema=z.strictObject({schema:z.literal('conversation-new-source-request-v1')});
export const ConversationNewFactsSchema=z.strictObject({schema:z.literal('conversation-new-facts-v1'),projects:z.array(ProjectSchema),device:Device,accountCount:z.number().int().nonnegative(),jevSaved:z.boolean()});
export const ConversationNewSourceSchema=z.strictObject({schema:z.literal('conversation-new-source-v1'),device:Device,projects:z.array(Project),defaultProjectId:z.union([IdSchema,z.literal('')]),accountCount:z.number().int().nonnegative(),jevSaved:z.boolean()});
export const ConversationNewRequestSchema=z.strictObject({schema:z.literal('conversation-new-request-v1'),projectId:z.union([IdSchema,z.literal('')]).optional(),message:z.string().default(''),busy:z.boolean().default(false),previousProjectIds:z.array(IdSchema).optional()});
const Notice=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('account'),text:z.string(),route:z.literal('/settings/runtimes'),buttonLabel:z.string()}),
 z.strictObject({kind:z.literal('jev'),text:z.string()}),
]);
export const ConversationNewViewSchema=z.strictObject({schema:z.literal('conversation-new-view-v1'),source:ConversationNewSourceSchema,selectedProjectId:z.union([IdSchema,z.literal('')]),addedProjectId:IdSchema.optional(),
 deviceOptions:z.array(z.strictObject({value:z.enum(['here','automatic']),label:z.string(),disabled:z.boolean()})),deviceHint:z.string(),projectPlaceholder:z.string(),notices:z.array(Notice),unavailableNotice:z.string().nullable(),canStart:z.boolean(),refusal:z.string().nullable(),startLabel:z.string()});
export type ConversationNewSource=z.infer<typeof ConversationNewSourceSchema>;
export type ConversationNewView=z.infer<typeof ConversationNewViewSchema>;

/** Same current-device resource policy as the existing new-conversation form; admission remains canonical. */
export function conversationNewSource(raw:unknown):ConversationNewSource{
 const facts=ConversationNewFactsSchema.parse(raw);
 return ConversationNewSourceSchema.parse({schema:'conversation-new-source-v1',device:facts.device,accountCount:facts.accountCount,jevSaved:facts.jevSaved,defaultProjectId:facts.projects[0]?.id??'',projects:facts.projects.map(project=>({id:project.id,name:project.name,available:!!project.paths[facts.device.id]&&(!project.allowedDevices||project.allowedDevices.includes(facts.device.id))}))});
}
export function conversationNewView(raw:unknown,request:unknown={schema:'conversation-new-request-v1'}):ConversationNewView{
 const source=ConversationNewSourceSchema.parse(raw),input=ConversationNewRequestSchema.parse(request),selectedProjectId=input.projectId??source.defaultProjectId,project=source.projects.find(row=>row.id===selectedProjectId);
 const notices:z.infer<typeof Notice>[]=[];
 if(!source.accountCount)notices.push({kind:'account',text:'Add an account to Claude Code or Codex first.',route:'/settings/runtimes',buttonLabel:'Open Runtimes →'});
 if(!source.jevSaved)notices.push({kind:'jev',text:'Add your Jev key in Settings → Decisions. Until then you pick each step yourself.'});
 const unavailableNotice=project&&!project.available?`${project.name} isn’t set up on ${source.device.name}. Add its path in Settings → Projects, or switch device.`:null;
 const refusal=input.busy?'Starting…':!project?'Choose a project.':unavailableNotice??(!source.accountCount?'Add an account to Claude Code or Codex first.':!input.message.trim()?'Write a message.':null);
 const added=input.previousProjectIds?source.projects.find(row=>!input.previousProjectIds!.includes(row.id)):undefined;
 return ConversationNewViewSchema.parse({schema:'conversation-new-view-v1',source,selectedProjectId,...(added?{addedProjectId:added.id}:{}),
  deviceOptions:[{value:'here',label:`This device: ${source.device.name}`,disabled:false},{value:'automatic',label:'Choose automatically',disabled:true}],deviceHint:'Coming later: Jevellan will pick a free machine and avoid ones where other agents are working.',projectPlaceholder:source.projects.length?'Choose a project':'Add a project first',notices,unavailableNotice,canStart:refusal===null,refusal,startLabel:input.busy?'Starting…':'Start'});
}
