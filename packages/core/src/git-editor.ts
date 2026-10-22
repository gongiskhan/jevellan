import {z} from 'zod';
import {IdSchema,ProjectSchema} from './schemas.js';
import {GitSettingsSchema,GitCheckSchema,GitCheckRequestSchema,GitCheckPresentationSchema} from './git-settings-schemas.js';
export const GitEditorDraftSchema=z.strictObject({schema:z.literal('git-editor-draft-v1'),transport:GitSettingsSchema.shape.githubTransport,projectId:z.string(),tokenScope:z.string()});
export type GitEditorDraft=z.infer<typeof GitEditorDraftSchema>;
export const GitEditorFactsSchema=z.strictObject({schema:z.literal('git-editor-facts-v1'),device:z.strictObject({id:IdSchema,name:z.string()}),settings:GitSettingsSchema,projects:z.array(ProjectSchema)});
const ProjectChoiceSchema=z.strictObject({id:IdSchema,name:z.string()});
export const GitEditorViewSchema=z.strictObject({schema:z.literal('git-editor-view-v1'),deviceId:IdSchema,deviceName:z.string(),settings:GitSettingsSchema,defaults:GitEditorDraftSchema,projects:z.array(ProjectChoiceSchema),tokenScopes:z.array(z.strictObject({value:z.string(),label:z.string()})),methods:z.array(z.strictObject({value:GitSettingsSchema.shape.githubTransport,label:z.string(),description:z.string()})),localNotice:z.string(),saveMessage:z.string()});
export type GitEditorView=z.infer<typeof GitEditorViewSchema>;
export const GIT_CONNECTION_METHODS=[{value:'machine' as const,label:"Use this machine's Git configuration",description:'Use the credential helper or SSH configuration already set up on this device. HTTPS credentials must be available without an interactive prompt.'},{value:'ssh' as const,label:'Use SSH for GitHub',description:'Use an existing GitHub SSH key available on this device. HTTPS GitHub remotes are connected over SSH for Jevellan’s Git operations.'}];
export const GIT_DEFAULT_TOKEN_SCOPE={value:'',label:'Default for existing projects'};
export const GitEditorCommandSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('git-editor-command-v1'),operation:z.literal('save'),deviceId:IdSchema,settings:GitSettingsSchema}),
 z.strictObject({schema:z.literal('git-editor-command-v1'),operation:z.literal('check'),deviceId:IdSchema,input:GitCheckRequestSchema}),
]);
export const GitEditorSavedSchema=z.strictObject({schema:z.literal('git-editor-saved-v1'),deviceId:IdSchema,settings:GitSettingsSchema,message:z.string()});
export const GitEditorCheckedSchema=z.strictObject({schema:z.literal('git-editor-checked-v1'),deviceId:IdSchema,check:GitCheckSchema,presentation:GitCheckPresentationSchema});
export function gitEditorDefaults(transport:z.infer<typeof GitSettingsSchema>['githubTransport']='machine'):GitEditorDraft{return GitEditorDraftSchema.parse({schema:'git-editor-draft-v1',transport,projectId:'',tokenScope:''});}
export function gitEditorView(raw:unknown):GitEditorView{
 const facts=GitEditorFactsSchema.parse(raw),{id,name}=facts.device;
 return GitEditorViewSchema.parse({schema:'git-editor-view-v1',deviceId:id,deviceName:name,settings:facts.settings,defaults:gitEditorDefaults(facts.settings.githubTransport),
  projects:facts.projects.filter(project=>project.paths[id]&&(!project.allowedDevices||project.allowedDevices.includes(id))).map(project=>({id:project.id,name:project.name})),
  tokenScopes:[GIT_DEFAULT_TOKEN_SCOPE,...facts.projects.map(project=>({value:project.id,label:project.name}))],methods:GIT_CONNECTION_METHODS,
  localNotice:`This choice is saved only in Jevellan on ${name}. Repository URLs, global Git settings and native logins are left unchanged.`,saveMessage:`Git settings saved on ${name}. Check your project, then retry the blocked operation.`});
}
export function gitEditorForm(view:GitEditorView|null,raw:unknown,busy:boolean){
 const draft=GitEditorDraftSchema.parse(raw),selectedProjectId=draft.projectId||view?.projects[0]?.id||'',changed=!!view&&draft.transport!==view.settings.githubTransport;
 return{selectedProjectId,canChooseTransport:!!view&&!busy,canSave:!!view&&!busy&&changed,canCheck:!!view&&!busy&&!changed&&view.projects.some(project=>project.id===selectedProjectId),saveFirstNotice:changed?'Save the connection method before checking.':null,description:GIT_CONNECTION_METHODS.find(method=>method.value===draft.transport)!.description};
}
export function gitEditorMergeSettings(view:GitEditorView,raw:unknown):GitEditorView{const settings=GitSettingsSchema.parse(raw);return GitEditorViewSchema.parse({...view,settings,defaults:{...view.defaults,transport:settings.githubTransport}});}
export function gitSaveCommand(view:GitEditorView,raw:unknown){
 const draft=GitEditorDraftSchema.parse(raw);return GitEditorCommandSchema.options[0].parse({schema:'git-editor-command-v1',operation:'save',deviceId:view.deviceId,settings:{...view.settings,githubTransport:draft.transport}});
}
export function gitCheckCommand(view:GitEditorView,raw:unknown){
 const draft=GitEditorDraftSchema.parse(raw),form=gitEditorForm(view,draft,false);if(form.saveFirstNotice)throw Error(form.saveFirstNotice);if(!form.canCheck)throw Error('Choose a project checked out and allowed on this device.');
 return GitEditorCommandSchema.options[1].parse({schema:'git-editor-command-v1',operation:'check',deviceId:view.deviceId,input:{schema:'git-check-request-v1',projectId:form.selectedProjectId,githubTransport:draft.transport}});
}
export function gitCheckPresentation(raw:unknown):z.infer<typeof GitCheckPresentationSchema>{
 const check=GitCheckSchema.parse(raw);return{heading:check.status==='ready'?'Connected':check.status==='local'?'Local checkout':'Connection needs attention',hint:check.status==='failed'?"For SSH, the existing key must be available to this device and registered with GitHub. For HTTPS, finish signing in to the machine's credential helper, then check again.":null};
}
export function gitEditorCommandResult(raw:unknown,result:unknown){
 const request=GitEditorCommandSchema.parse(raw),reply=request.operation==='save'?GitEditorSavedSchema.parse(result):GitEditorCheckedSchema.parse(result);
 if(reply.deviceId!==request.deviceId||request.operation==='check'&&'check'in reply&&reply.check.projectId!==request.input.projectId)throw Error('The Git reply belongs to another device or project.');return reply;
}
