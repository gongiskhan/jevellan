import {z} from 'zod';
import {IdSchema,ProjectSchema} from './schemas.js';
import {ContextPanelSchema,ContextOperationSchema,ContextRequestSchema,ContextContinueSchema,ContextReviewSchema,ContextFileSchema} from './context-schemas.js';
export const ContextEditorFactsSchema=z.strictObject({schema:z.literal('context-editor-facts-v1'),deviceId:IdSchema,project:ProjectSchema,panel:ContextPanelSchema,models:z.array(z.strictObject({id:IdSchema,label:z.string(),enabled:z.boolean()}))}).refine(row=>row.project.id===row.panel.context.projectId&&row.panel.operations.every(op=>op.projectId===row.project.id),'The context facts belong to another project.');
export const ContextEditorRequestSchema=z.strictObject({schema:z.literal('context-editor-request-v1'),modelId:z.union([IdSchema,z.literal('')]),busy:z.boolean(),review:ContextReviewSchema.nullable()});
export const ContextEditorPolicySchema=z.strictObject({schema:z.literal('context-editor-policy-v1'),pollMs:z.literal(1000),loading:z.string(),draftModelLabel:z.string(),defaultModelLabel:z.string(),draftNotice:z.string(),reviewNotice:z.string(),currentFilesLabel:z.string(),operationLabel:z.string(),mergeDiffLabel:z.string(),reviewLabel:z.string(),reviewDiffLabel:z.string()});
export function contextEditorPolicy(){return ContextEditorPolicySchema.parse({schema:'context-editor-policy-v1',pollMs:1000,loading:'Loading context…',draftModelLabel:'Draft model',defaultModelLabel:'First eligible model',draftNotice:'The draft ran read-only. Apply replaces AGENTS.md with this text and links CLAUDE.md to it.',reviewNotice:'Continue accepts all the files shown above as this work’s checkpoint, then verifies them before publication.',currentFilesLabel:'Current instruction files',operationLabel:'Context operation',mergeDiffLabel:'Context merge diff',reviewLabel:'Review context changes',reviewDiffLabel:'Current context checkout changes'});}
const control=z.strictObject({visible:z.boolean(),enabled:z.boolean(),label:z.string()});
export const ContextEditorSchema=z.strictObject({schema:z.literal('context-editor-v1'),projectId:IdSchema,deviceId:IdSchema,facts:ContextEditorFactsSchema,fields:z.strictObject({modelId:z.union([IdSchema,z.literal('')])}),review:ContextReviewSchema.nullable(),policy:ContextEditorPolicySchema,title:z.string(),intro:z.string(),notices:z.array(z.string()),noticeRows:z.array(z.strictObject({text:z.string(),tone:z.enum(['muted','notice'])})),activityNotice:z.string().nullable(),status:z.string().nullable(),operation:ContextOperationSchema.nullable(),active:z.boolean(),busy:z.boolean(),separate:z.boolean(),models:z.array(z.strictObject({id:IdSchema,label:z.string()})),modelVisible:z.boolean(),modelAfterChoice:ContextRequestSchema.shape.choice.nullable(),modelEnabled:z.boolean(),choices:z.array(z.strictObject({choice:ContextRequestSchema.shape.choice,label:z.string(),enabled:z.boolean()})),actions:z.strictObject({apply:control,cancel:control,retry:control,review:control,accept:control,openWork:control.extend({path:z.string().nullable()})}),draftFiles:z.array(z.strictObject({name:z.string(),beforeLines:z.array(z.string()),afterLines:z.array(z.string())})),currentFiles:z.array(z.strictObject({file:ContextFileSchema,summary:z.string()})),paths:z.strictObject({editor:z.string(),prepare:z.string(),command:z.string(),review:z.string()})}).refine(row=>row.projectId===row.facts.project.id&&row.deviceId===row.facts.deviceId,'The context editor belongs to another device or project.');
export const ContextEditorPreviewSchema=z.strictObject({schema:z.literal('context-editor-preview-v1'),facts:ContextEditorFactsSchema,request:ContextEditorRequestSchema});
export const ContextEditorIntentSchema=z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('context-editor-intent-v1'),kind:z.literal('choose'),choice:ContextRequestSchema.shape.choice}),
 z.strictObject({schema:z.literal('context-editor-intent-v1'),kind:z.literal('continue'),action:ContextContinueSchema.shape.action}),
]);
const scope={schema:z.literal('context-editor-command-v1'),projectId:IdSchema,deviceId:IdSchema};
export const ContextEditorCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({...scope,kind:z.literal('choose'),body:ContextRequestSchema}),z.strictObject({...scope,kind:z.literal('continue'),body:ContextContinueSchema}),
]);
type Command=z.infer<typeof ContextEditorCommandSchema>;
const paths=(projectId:string)=>{const root=`/api/projects/${projectId}/context`;return{editor:`${root}/editor`,prepare:`${root}/prepare`,command:`${root}/commands`,review:`${root}/editor/review`};};
function signature(command:Command){const{clientRequestId,...body}=command.body;void clientRequestId;return JSON.stringify({deviceId:command.deviceId,projectId:command.projectId,kind:command.kind,body});}
export const ContextEditorAttemptSchema=z.strictObject({schema:z.literal('context-editor-attempt-v1'),signature:z.string(),path:z.string(),command:ContextEditorCommandSchema}).refine(row=>row.signature===signature(row.command)&&row.path===paths(row.command.projectId).command,'The context attempt does not match its captured command.');
export const ContextEditorPrepareSchema=z.strictObject({schema:z.literal('context-editor-prepare-v1'),editor:ContextEditorSchema,previous:ContextEditorAttemptSchema.nullable(),intent:ContextEditorIntentSchema,candidateId:IdSchema});
export const ContextEditorReceiptSchema=z.strictObject({schema:z.literal('context-editor-receipt-v1'),projectId:IdSchema,deviceId:IdSchema,kind:z.enum(['choose','continue']),clientRequestId:IdSchema,editor:ContextEditorSchema}).refine(row=>row.projectId===row.editor.projectId&&row.deviceId===row.editor.deviceId,'The context receipt belongs to another device or project.');
export const ContextEditorReviewRequestSchema=z.strictObject({schema:z.literal('context-editor-review-request-v1'),operationId:IdSchema});
export const ContextEditorReviewSchema=z.strictObject({schema:z.literal('context-editor-review-v1'),projectId:IdSchema,deviceId:IdSchema,review:ContextReviewSchema});

export function contextEditor(rawFacts:unknown,rawRequest?:unknown){
 const facts=ContextEditorFactsSchema.parse(rawFacts),request=ContextEditorRequestSchema.parse(rawRequest??{schema:'context-editor-request-v1',modelId:'',busy:false,review:null}),{panel,project}=facts,context=panel.context;
 const operation=panel.operations.find(row=>!['completed','cancelled'].includes(row.status))??panel.operations.at(-1)??null,active=!!operation&&!['completed','cancelled'].includes(operation.status),busy=request.busy||panel.busy,separate=context.files.every(file=>file.kind==='file'),external=project.branchPolicy==='external';
 const review=request.review&&request.review.operationId===operation?.id&&request.review.generation===operation.generation?request.review:null,notices:string[]=[];
 if(context.state==='left-as-is')notices.push('Both files are being kept as they are.');
 if(!active&&separate&&external)notices.push('This project follows its own git rules. Only untracked files can become local links.');
 const choices:Array<{choice:z.infer<typeof ContextRequestSchema>['choice'];label:string;enabled:boolean}>=[];
 if(!active){if(separate)choices.push({choice:'keep-agents',label:'Keep AGENTS.md and link CLAUDE.md to it',enabled:!busy&&!(external&&context.files.find(file=>file.name==='CLAUDE.md')?.tracked)},{choice:'keep-claude',label:'Keep CLAUDE.md and link AGENTS.md to it',enabled:!busy&&!(external&&context.files.find(file=>file.name==='AGENTS.md')?.tracked)},{choice:'merge',label:'Merge them into AGENTS.md',enabled:!busy&&!external},{choice:'leave',label:'Leave both as they are',enabled:!busy});else if(context.state==='none')choices.push({choice:context.primary?'link':'create',label:context.primary?'Link the instruction files':'Create AGENTS.md',enabled:!busy});}
 const draft=operation?.status==='draft-ready'&&!!operation.draft,blocked=operation?.status==='blocked',outside=blocked&&!!operation.activityReason;
 const button=(visible:boolean,label:string)=>({visible,enabled:visible&&!busy,label});
 const status=!operation?null:panel.busy?operation.status==='drafting'?'Drafting a merge…':'Applying and verifying the context change…':operation.status==='completed'?'Context change completed.':operation.status==='cancelled'?'Context change cancelled.':operation.status==='draft-ready'?'Review the proposed changes before applying.':operation.reason??operation.status;
 return ContextEditorSchema.parse({schema:'context-editor-v1',projectId:project.id,deviceId:facts.deviceId,facts,fields:{modelId:request.modelId},review,policy:contextEditorPolicy(),title:`Context · ${project.name}`,intro:context.state==='linked'?`Linked: ${context.files.find(file=>file.kind==='link')?.name??'Claude Code'} → ${context.primary}`:separate?`${project.name} has both AGENTS.md and CLAUDE.md. Agents should read one file.`:'Choose the instructions your agents read in this project.',notices,noticeRows:notices.map(text=>({text,tone:context.state==='left-as-is'&&text==='Both files are being kept as they are.'?'muted':'notice'})),activityNotice:outside&&operation.reason!==operation.activityReason?operation.activityReason??null:null,status,operation,active,busy,separate,models:facts.models.filter(row=>row.enabled).map(({id,label})=>({id,label})),modelVisible:!active&&separate,modelAfterChoice:!active&&separate?'keep-claude':null,modelEnabled:!busy&&!external,choices,
  actions:{apply:button(draft,'Apply'),cancel:button(draft||blocked&&!outside&&!operation.applied,'Cancel'),retry:button(blocked&&!outside,'Retry'),review:button(!!outside,review?'Refresh changes':'Review changes'),accept:button(!!outside&&!!review,'Continue'),openWork:{visible:!!operation,enabled:!!operation,label:'Open work',path:operation?`/conversations/${operation.conversationId}`:null}},
  draftFiles:draft?operation.before.files.map(file=>({name:file.name,beforeLines:file.content.split('\n').map(line=>'− '+line),afterLines:(file.name==='AGENTS.md'?operation.draft!:'Symlink → AGENTS.md').split('\n').map(line=>'+ '+line)})):[],currentFiles:context.files.map(file=>({file,summary:`${file.kind}${file.target?' → '+file.target:''}${file.tracked?' · tracked':''}`})),paths:paths(project.id)});
}
export function contextEditorWithUi(raw:unknown,request:unknown){const model=ContextEditorSchema.parse(raw);return contextEditor(model.facts,request);}
export function contextEditorAttempt(rawPrevious:unknown,rawModel:unknown,rawIntent:unknown,candidateId:string){
 const parsed=ContextEditorSchema.parse(rawModel),model=contextEditor(parsed.facts,{schema:'context-editor-request-v1',modelId:parsed.fields.modelId,busy:parsed.busy,review:parsed.review}),intent=ContextEditorIntentSchema.parse(rawIntent);
 let body:unknown;
 if(intent.kind==='choose'){
  if(!model.choices.some(row=>row.choice===intent.choice&&row.enabled))throw new Error('This context choice is not available.');
  body={schema:'context-request-v1',clientRequestId:candidateId,revision:model.facts.panel.revision,fingerprint:model.facts.panel.context.fingerprint,choice:intent.choice,...(intent.choice==='merge'&&model.fields.modelId?{modelId:model.fields.modelId}:{})};
 }else{
  const key={apply:'apply',cancel:'cancel',retry:'retry','accept-changes':'accept'}as const,action=model.actions[key[intent.action]];
  if(!model.operation||!action.visible||!action.enabled)throw new Error('This context continuation is not available.');
  body={schema:'context-continue-v1',clientRequestId:candidateId,operationId:model.operation.id,generation:intent.action==='accept-changes'?model.review!.generation:model.operation.generation,action:intent.action,...(intent.action==='accept-changes'?{fingerprint:model.review!.fingerprint}:{})};
 }
 const command=ContextEditorCommandSchema.parse({schema:'context-editor-command-v1',deviceId:model.deviceId,projectId:model.projectId,kind:intent.kind,body}),previous=rawPrevious===null?null:ContextEditorAttemptSchema.parse(rawPrevious),next=signature(command);
 return previous?.signature===next?previous:ContextEditorAttemptSchema.parse({schema:'context-editor-attempt-v1',signature:next,path:model.paths.command,command});
}
export function contextEditorReceipt(rawCommand:unknown,rawEditor:unknown){
 const command=ContextEditorCommandSchema.parse(rawCommand),editor=ContextEditorSchema.parse(rawEditor),records=editor.facts.panel.operations;
 const accepted=command.kind==='choose'?records.some(row=>row.id===command.body.clientRequestId&&JSON.stringify(row.request)===JSON.stringify(command.body)):records.some(row=>row.id===command.body.operationId&&row.continuations.some(input=>JSON.stringify(input)===JSON.stringify(command.body)));
 if(!accepted)throw new Error('The context receipt does not contain the accepted canonical request.');
 return ContextEditorReceiptSchema.parse({schema:'context-editor-receipt-v1',projectId:command.projectId,deviceId:command.deviceId,kind:command.kind,clientRequestId:command.body.clientRequestId,editor});
}
export function contextEditorAccepted(rawAttempt:unknown,rawReceipt:unknown,current:{deviceId:string;projectId:string}){
 const attempt=ContextEditorAttemptSchema.parse(rawAttempt),receipt=ContextEditorReceiptSchema.parse(rawReceipt),command=attempt.command;
 if(current.deviceId!==command.deviceId||current.projectId!==command.projectId||receipt.deviceId!==command.deviceId||receipt.projectId!==command.projectId||receipt.kind!==command.kind||receipt.clientRequestId!==command.body.clientRequestId)throw new Error('The context receipt belongs to another request.');
 return contextEditorReceipt(command,receipt.editor).editor;
}
export const ContextEditorDeviceRequestSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('project-definition-peer-request-v1'),operation:z.literal('context-editor'),projectId:IdSchema,deviceId:IdSchema,request:ContextEditorRequestSchema.optional()}),
 z.strictObject({schema:z.literal('project-definition-peer-request-v1'),operation:z.literal('context-preview'),projectId:IdSchema,deviceId:IdSchema,request:ContextEditorPreviewSchema}),
 z.strictObject({schema:z.literal('project-definition-peer-request-v1'),operation:z.literal('context-prepare'),projectId:IdSchema,deviceId:IdSchema,request:ContextEditorPrepareSchema}),
 z.strictObject({schema:z.literal('project-definition-peer-request-v1'),operation:z.literal('context-action'),projectId:IdSchema,deviceId:IdSchema,request:ContextEditorCommandSchema}),
 z.strictObject({schema:z.literal('project-definition-peer-request-v1'),operation:z.literal('context-review'),projectId:IdSchema,deviceId:IdSchema,request:ContextEditorReviewRequestSchema}),
]);
export function contextEditorDeviceResult(rawInput:unknown,rawReply:unknown){
 const input=ContextEditorDeviceRequestSchema.parse(rawInput);
 if(input.operation==='context-prepare'){const result=ContextEditorAttemptSchema.parse(rawReply);if(result.command.projectId!==input.projectId||result.command.deviceId!==input.deviceId)throw new Error('The returned context attempt belongs to another device or project.');return result;}
 if(input.operation==='context-action'){const result=ContextEditorReceiptSchema.parse(rawReply);if(result.projectId!==input.projectId||result.deviceId!==input.deviceId||result.clientRequestId!==input.request.body.clientRequestId||result.kind!==input.request.kind)throw new Error('The returned context receipt belongs to another request.');contextEditorReceipt(input.request,result.editor);return result;}
 if(input.operation==='context-review'){const result=ContextEditorReviewSchema.parse(rawReply);if(result.projectId!==input.projectId||result.deviceId!==input.deviceId||result.review.operationId!==input.request.operationId)throw new Error('The returned context review belongs to another request.');return result;}
 const result=ContextEditorSchema.parse(rawReply);if(result.projectId!==input.projectId||result.deviceId!==input.deviceId)throw new Error('The returned context editor belongs to another device or project.');return result;
}
