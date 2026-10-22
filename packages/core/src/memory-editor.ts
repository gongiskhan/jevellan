import {z} from 'zod';
import {IdSchema,ProjectSchema} from './schemas.js';
import {ProjectWorkSettingsSchema,ProjectWorkSettingsRequestSchema,ProjectWorkSettingsViewSchema} from './project-schemas.js';
import {ProjectMemoryViewSchema,ProjectMemoryResultSchema,MemoryDreamStateSchema,MemoryNoteSchema,MemoryWriteSchema} from './project-memory-schemas.js';
export const MemoryEditorFactsSchema=z.strictObject({schema:z.literal('memory-editor-facts-v1'),project:ProjectSchema,view:ProjectMemoryViewSchema.nullable(),settings:ProjectWorkSettingsSchema.nullable()}).refine(row=>row.project.memory.mode==='hub'?row.view?.projectId===row.project.id&&row.settings?.projectId===row.project.id:row.view===null&&row.settings===null,'The memory facts do not match the project and memory mode.');
export const MemoryEditorFieldsSchema=z.strictObject({title:z.string().max(40000),content:z.string().max(400000)});
export const MemoryEditorUiSchema=z.strictObject({schema:z.literal('memory-editor-ui-v1'),busy:z.boolean()});
export const MemoryEditorEventSchema=z.discriminatedUnion('field',[z.strictObject({schema:z.literal('memory-editor-event-v1'),field:z.literal('title'),value:MemoryEditorFieldsSchema.shape.title}),z.strictObject({schema:z.literal('memory-editor-event-v1'),field:z.literal('content'),value:MemoryEditorFieldsSchema.shape.content})]);
export const MemoryEditorPolicySchema=z.strictObject({schema:z.literal('memory-editor-policy-v1'),pollMs:z.literal(10000).nullable(),loading:z.string(),sharedIntro:z.string(),captureLabel:z.string(),dreamModeLabel:z.string(),dreamModes:z.array(z.strictObject({value:z.enum(['apply','suggest']),label:z.string()})),dreamTitle:z.string(),noDream:z.string(),inboxTitle:z.string(),noInbox:z.string(),notesTitle:z.string(),moreNotes:z.string(),changesLabel:z.string(),addNoteLabel:z.string(),titleLabel:z.string(),contentLabel:z.string(),saveNoteLabel:z.string(),notRunNotice:z.string(),noteTitleMax:z.number().int().positive(),noteContentMax:z.number().int().positive()});
export function memoryEditorPolicy(mode:z.infer<typeof ProjectSchema>['memory']['mode']){return MemoryEditorPolicySchema.parse({schema:'memory-editor-policy-v1',pollMs:mode==='hub'?10000:null,loading:'Loading memory…',sharedIntro:'Shared by Claude and Codex on every project device. History stays on the hub.',captureLabel:'Capture durable knowledge from sessions',dreamModeLabel:'Nightly dream',dreamModes:[{value:'apply',label:'Apply and tell me'},{value:'suggest',label:'Suggest only'}],dreamTitle:"Last night's dream",noDream:'No dream recorded yet.',inboxTitle:'Inbox (from today)',noInbox:'No inbox notes.',notesTitle:'Project notes',moreNotes:'More notes are available through Search memory.',changesLabel:'Memory changes',addNoteLabel:'Add an owner note',titleLabel:'Title',contentLabel:'Note',saveNoteLabel:'Save owner note',notRunNotice:'Memory dream: not run.',noteTitleMax:MemoryWriteSchema.shape.title.maxLength!,noteContentMax:MemoryWriteSchema.shape.content.maxLength!});}
export const MemoryNotePresentationSchema=z.strictObject({schema:z.literal('memory-note-presentation-v1'),note:MemoryNoteSchema,label:z.string()});
export function memoryNotePresentation(raw:unknown,kind:'shared'|'search'){const note=MemoryNoteSchema.parse(raw);return MemoryNotePresentationSchema.parse({schema:'memory-note-presentation-v1',note,label:note.title+(kind==='search'&&note.unresolved?' (conflicting versions, unresolved)':'')});}
const button=z.strictObject({visible:z.boolean(),enabled:z.boolean(),label:z.string()});
export const MemoryEditorSchema=z.strictObject({schema:z.literal('memory-editor-v1'),projectId:IdSchema,facts:MemoryEditorFactsSchema,fields:MemoryEditorFieldsSchema,ui:MemoryEditorUiSchema,policy:MemoryEditorPolicySchema,supported:z.boolean(),memory:z.strictObject({capture:z.boolean(),dreamMode:z.enum(['apply','suggest'])}).nullable(),notice:z.string().nullable(),dream:z.strictObject({stateLine:z.string(),summary:z.string().nullable(),countsLine:z.string().nullable(),diff:z.string()}).nullable(),inbox:z.array(MemoryNotePresentationSchema),notes:z.array(MemoryNotePresentationSchema),truncatedLine:z.string().nullable(),actions:z.strictObject({settingsEnabled:z.boolean(),noteEnabled:z.boolean(),run:button,apply:button,discard:button,undo:button}),paths:z.strictObject({editor:z.string(),prepare:z.string(),command:z.string()})}).refine(row=>row.projectId===row.facts.project.id,'The memory editor belongs to another project.');
const dreamOperation=z.enum(['dream-run','dream-apply','dream-undo','dream-discard']);
export const MemoryEditorIntentSchema=z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('memory-editor-intent-v1'),kind:z.literal('capture'),value:z.boolean()}),z.strictObject({schema:z.literal('memory-editor-intent-v1'),kind:z.literal('dream-mode'),value:z.enum(['apply','suggest'])}),z.strictObject({schema:z.literal('memory-editor-intent-v1'),kind:z.literal('dream'),operation:dreamOperation}),z.strictObject({schema:z.literal('memory-editor-intent-v1'),kind:z.literal('note')}),
]);
export const MemoryEditorOwnerRequestSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('memory-editor-owner-request-v1'),operation:z.literal('write'),requestId:IdSchema,input:MemoryWriteSchema}),z.strictObject({schema:z.literal('memory-editor-owner-request-v1'),operation:dreamOperation,requestId:IdSchema}),
]);
export const MemoryEditorCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('memory-editor-command-v1'),projectId:IdSchema,kind:z.literal('settings'),body:ProjectWorkSettingsRequestSchema.extend({clientRequestId:IdSchema})}),z.strictObject({schema:z.literal('memory-editor-command-v1'),projectId:IdSchema,kind:z.literal('memory'),body:MemoryEditorOwnerRequestSchema}),
]);
type Command=z.infer<typeof MemoryEditorCommandSchema>;
const paths=(projectId:string)=>{const root=`/api/projects/${projectId}/memory`;return{editor:`${root}/editor`,prepare:`${root}/prepare`,command:`${root}/commands`};};
function signature(command:Command){if(command.kind==='settings'){const{clientRequestId,...body}=command.body;void clientRequestId;return JSON.stringify({projectId:command.projectId,kind:command.kind,body});}const{requestId,...body}=command.body;void requestId;return JSON.stringify({projectId:command.projectId,kind:command.kind,body});}
export const MemoryEditorAttemptSchema=z.strictObject({schema:z.literal('memory-editor-attempt-v1'),signature:z.string(),path:z.string(),command:MemoryEditorCommandSchema}).refine(row=>row.signature===signature(row.command)&&row.path===paths(row.command.projectId).command,'The memory attempt does not match its canonical payload.');
export const MemoryEditorPrepareSchema=z.strictObject({schema:z.literal('memory-editor-prepare-v1'),editor:MemoryEditorSchema,previous:MemoryEditorAttemptSchema.nullable(),intent:MemoryEditorIntentSchema,candidateId:IdSchema});
export const MemoryEditorReadRequestSchema=z.strictObject({schema:z.literal('memory-editor-read-request-v1'),fields:MemoryEditorFieldsSchema,ui:MemoryEditorUiSchema});
export const MemoryEditorReceiptSchema=z.strictObject({schema:z.literal('memory-editor-receipt-v1'),projectId:IdSchema,kind:z.enum(['settings','memory']),operation:z.enum(['settings','write','dream-run','dream-apply','dream-undo','dream-discard']),requestId:IdSchema,result:z.union([ProjectWorkSettingsViewSchema,ProjectMemoryResultSchema]),editor:MemoryEditorSchema}).refine(row=>row.projectId===row.editor.projectId,'The memory receipt belongs to another project.');
export const MemoryEditorAcceptedSchema=z.strictObject({schema:z.literal('memory-editor-accepted-v1'),editor:MemoryEditorSchema,clearNote:z.boolean()});
export function memoryEditor(rawFacts:unknown,rawFields?:unknown,rawUi?:unknown){
 const facts=MemoryEditorFactsSchema.parse(rawFacts),fields=MemoryEditorFieldsSchema.parse(rawFields??{title:'',content:''}),ui=MemoryEditorUiSchema.parse(rawUi??{schema:'memory-editor-ui-v1',busy:false}),policy=memoryEditorPolicy(facts.project.memory.mode),supported=facts.project.memory.mode==='hub',view=facts.view,dream=view?.dream;
 const action=(visible:boolean,label:string,allowed=true)=>({visible,enabled:visible&&!ui.busy&&allowed,label});
 return MemoryEditorSchema.parse({schema:'memory-editor-v1',projectId:facts.project.id,facts,fields,ui,policy,supported,memory:facts.settings?{capture:facts.settings.memory.capture,dreamMode:facts.settings.memory.dreamMode}:null,notice:view?.notice&&view.notice!==policy.notRunNotice?view.notice:null,dream:dream?{stateLine:dream.state+(dream.reason?': '+dream.reason:''),summary:dream.report?.summary??null,countsLine:dream.report?Object.entries(dream.report.counts).map(([name,count])=>`${name}: ${count}`).join(' · '):null,diff:dream.diff}:null,inbox:(view?.inbox??[]).map(note=>memoryNotePresentation(note,'shared')),notes:(view?.notes??[]).map(note=>memoryNotePresentation(note,'shared')),truncatedLine:view?.truncated?policy.moreNotes:null,actions:{settingsEnabled:supported&&!ui.busy,noteEnabled:supported&&!ui.busy&&MemoryWriteSchema.safeParse(fields).success,run:action(supported,'Run now',dream?.state!=='running'),apply:action(supported&&dream?.state==='suggested','Apply'),discard:action(supported&&dream?.state==='suggested','Discard suggestion'),undo:action(supported&&dream?.state==='applied','Undo')},paths:paths(facts.project.id)});
}
export function memoryEditorEdit(raw:unknown,rawEvent:unknown){const model=MemoryEditorSchema.parse(raw),event=MemoryEditorEventSchema.parse(rawEvent);if(model.facts.project.memory.mode!=='hub')throw new Error('This project does not use hub memory.');return memoryEditor(model.facts,{...model.fields,[event.field]:event.value},model.ui);}
export function memoryEditorUi(raw:unknown,ui:unknown){const model=MemoryEditorSchema.parse(raw);return memoryEditor(model.facts,model.fields,ui);}
export function memoryEditorWithUi(raw:unknown,fields:unknown,ui:unknown){const model=MemoryEditorSchema.parse(raw);return memoryEditor(model.facts,fields,ui);}
export function memoryEditorAttempt(rawPrevious:unknown,rawModel:unknown,rawIntent:unknown,candidateId:string){
 const parsed=MemoryEditorSchema.parse(rawModel),model=memoryEditor(parsed.facts,parsed.fields,parsed.ui),intent=MemoryEditorIntentSchema.parse(rawIntent);let rawCommand:unknown;
 if(intent.kind==='capture'||intent.kind==='dream-mode'){
  if(!model.actions.settingsEnabled||!model.facts.settings)throw new Error('Memory settings cannot be changed now.');
  const{schema,projectId,revision,...fields}=model.facts.settings;void schema;void projectId;
  const memory={mode:'hub',capture:intent.kind==='capture'?intent.value:model.facts.settings.memory.capture,dreamMode:intent.kind==='dream-mode'?intent.value:model.facts.settings.memory.dreamMode};
  rawCommand={schema:'memory-editor-command-v1',projectId:model.projectId,kind:'settings',body:{schema:'project-work-settings-request-v1',clientRequestId:candidateId,revision,settings:{...fields,memory}}};
 }else{
  if(intent.kind==='note'){
   if(!model.actions.noteEnabled)throw new Error('Fill in the owner note before saving.');
   rawCommand={schema:'memory-editor-command-v1',projectId:model.projectId,kind:'memory',body:{schema:'memory-editor-owner-request-v1',operation:'write',requestId:candidateId,input:MemoryWriteSchema.parse(model.fields)}};
  }else{
   const key={'dream-run':'run','dream-apply':'apply','dream-undo':'undo','dream-discard':'discard'}as const,action=model.actions[key[intent.operation]];
   if(!action.visible||!action.enabled)throw new Error('This memory dream action is not available.');
   rawCommand={schema:'memory-editor-command-v1',projectId:model.projectId,kind:'memory',body:{schema:'memory-editor-owner-request-v1',operation:intent.operation,requestId:candidateId}};
  }
 }
 const command=MemoryEditorCommandSchema.parse(rawCommand),previous=rawPrevious===null?null:MemoryEditorAttemptSchema.parse(rawPrevious),next=signature(command);
 return previous?.signature===next?previous:MemoryEditorAttemptSchema.parse({schema:'memory-editor-attempt-v1',signature:next,path:model.paths.command,command});
}
export function memoryEditorReceipt(rawCommand:unknown,rawResult:unknown,rawEditor:unknown){
 const command=MemoryEditorCommandSchema.parse(rawCommand),editor=MemoryEditorSchema.parse(rawEditor);let result:z.infer<typeof MemoryEditorReceiptSchema>['result'];
 if(command.kind==='settings'){
  result=ProjectWorkSettingsViewSchema.parse(rawResult);if(result.settings.projectId!==command.projectId)throw new Error('The returned memory settings belong to another project.');
 }else if(command.body.operation==='write')result=MemoryNoteSchema.parse(rawResult);
 else if(command.body.operation==='dream-run'||command.body.operation==='dream-discard'){
  result=ProjectMemoryResultSchema.parse(rawResult);if(result.schema!=='memory-operation-v1')throw new Error('Expected an accepted memory operation.');
 }else{result=MemoryDreamStateSchema.parse(rawResult);if(result.projectId!==command.projectId)throw new Error('The returned memory dream belongs to another project.');}
 return MemoryEditorReceiptSchema.parse({schema:'memory-editor-receipt-v1',projectId:command.projectId,kind:command.kind,operation:command.kind==='settings'?'settings':command.body.operation,requestId:command.kind==='settings'?command.body.clientRequestId:command.body.requestId,result,editor});
}
export function memoryEditorAccepted(rawAttempt:unknown,rawReceipt:unknown,current:{projectId:string},rawCurrentFields?:unknown){
 const attempt=MemoryEditorAttemptSchema.parse(rawAttempt),receipt=MemoryEditorReceiptSchema.parse(rawReceipt),command=attempt.command,operation=command.kind==='settings'?'settings':command.body.operation,id=command.kind==='settings'?command.body.clientRequestId:command.body.requestId;
 if(current.projectId!==command.projectId||receipt.projectId!==command.projectId||receipt.kind!==command.kind||receipt.operation!==operation||receipt.requestId!==id)throw new Error('The memory receipt belongs to another request.');
 memoryEditorReceipt(command,receipt.result,receipt.editor);
 const submitted=command.kind==='memory'&&command.body.operation==='write'?command.body.input:null,fields=MemoryEditorFieldsSchema.parse(rawCurrentFields??submitted??receipt.editor.fields),clearNote=!!submitted&&fields.title===submitted.title&&fields.content===submitted.content;
 return MemoryEditorAcceptedSchema.parse({schema:'memory-editor-accepted-v1',editor:memoryEditor(receipt.editor.facts,clearNote?{title:'',content:''}:fields,{schema:'memory-editor-ui-v1',busy:false}),clearNote});
}
