import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ProjectLibraryItemSchema,type ProjectLibraryItem} from './library-schemas.js';
import {ProjectAttachmentViewSchema} from './project-attachments.js';
import {ProjectLibraryViewSchema} from './project-library-view.js';

export const ProjectLibraryMessagePolicySchema=z.strictObject({schema:z.literal('project-library-message-policy-v1'),libraryReadFailure:z.literal('retain'),imageScope:z.literal('project')});
export const PROJECT_LIBRARY_MESSAGE_POLICY=Object.freeze(ProjectLibraryMessagePolicySchema.parse({schema:'project-library-message-policy-v1',libraryReadFailure:'retain',imageScope:'project'}));
export const ProjectLibraryMessageInputSchema=z.strictObject({schema:z.literal('project-library-message-input-v1'),projectId:IdSchema,text:z.string()});
export const ProjectLibraryMessageRequestSchema=z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('project-library-message-request-v1'),kind:z.literal('coordinator'),itemId:z.number().int().positive(),deviceId:IdSchema.optional()}),
 z.strictObject({schema:z.literal('project-library-message-request-v1'),kind:z.literal('thread-report'),threadId:IdSchema,turn:z.number().int().positive()}),
 z.strictObject({schema:z.literal('project-library-message-request-v1'),kind:z.literal('thread-queued'),threadId:IdSchema,messageId:IdSchema}),
]);
export const ProjectLibraryMessageAttachmentSchema=ProjectAttachmentViewSchema.extend({contentPath:z.string()}).superRefine((item,ctx)=>{
 if(item.contentPath!==`/api/projects/${item.projectId}/library/${item.id}/content`)ctx.addIssue({code:'custom',message:'This attachment belongs to another file.'});
});
export const ProjectLibraryMessageViewSchema=z.strictObject({schema:z.literal('project-library-message-view-v1'),projectId:IdSchema,text:z.string(),attachments:z.array(ProjectLibraryMessageAttachmentSchema),imageScope:z.literal('project')}).superRefine((view,ctx)=>{
 if(view.attachments.some(item=>item.projectId!==view.projectId))ctx.addIssue({code:'custom',message:'These attachments belong to another project.'});
});
export type ProjectLibraryMessageView=z.infer<typeof ProjectLibraryMessageViewSchema>;
export const ProjectLibraryImageReferenceSchema=z.discriminatedUnion('kind',[
 z.strictObject({schema:z.literal('project-library-image-reference-v1'),kind:z.literal('library'),item:ProjectLibraryItemSchema}),
 z.strictObject({schema:z.literal('project-library-image-reference-v1'),kind:z.literal('external'),ref:z.string()}),
 z.strictObject({schema:z.literal('project-library-image-reference-v1'),kind:z.literal('unavailable')}),
]);
function immutable<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}
class LibraryMessageContext{
 readonly schema='project-library-message-context-v1';
 readonly projectId:string;
 readonly images:ProjectLibraryItem[];
 readonly #rows:Array<{ref:string;attachment:z.infer<typeof ProjectLibraryMessageAttachmentSchema>}>;
 readonly #byRef=new Map<string,ProjectLibraryItem>();
 constructor(raw:unknown){
  const view=ProjectLibraryViewSchema.parse(raw);if(view.source!=='all')throw Object.assign(new Error('Read the complete library before presenting a message.'),{status:409});
  this.projectId=view.projectId;this.images=immutable(view.images);
  this.#rows=view.rows.map(row=>{const item=row.item,ref=`library/${item.path}`;if(!this.#byRef.has(ref))this.#byRef.set(ref,immutable(item));return{ref,attachment:immutable(ProjectLibraryMessageAttachmentSchema.parse({schema:'project-attachment-v1',id:item.id,projectId:item.projectId,path:item.path,name:item.name,mime:item.mime,size:item.size,kind:row.kind,sizeLabel:row.sizeLabel,contentPath:row.contentPath}))};});
  Object.freeze(this);
 }
 message(raw:unknown):ProjectLibraryMessageView{
  const input=ProjectLibraryMessageInputSchema.parse(raw);if(input.projectId!==this.projectId)throw Object.assign(new Error('This message belongs to another project.'),{status:409});
  // Preserve legacy reference association and ordering; only known protocol markers are hidden.
  const attached=this.#rows.filter(row=>input.text.includes(row.ref)),short=new Set(attached.map(row=>`Attached file: ${row.ref}`)),long=attached.map(row=>`Attached file: ${row.ref} (`);
  const text=input.text.split('\n').filter(line=>!short.has(line)&&!long.some(prefix=>line.startsWith(prefix))).join('\n');
  return ProjectLibraryMessageViewSchema.parse({schema:'project-library-message-view-v1',projectId:this.projectId,text,attachments:attached.map(row=>row.attachment),imageScope:PROJECT_LIBRARY_MESSAGE_POLICY.imageScope});
 }
 image(raw:unknown){const ref=z.string().parse(raw),item=this.#byRef.get(ref);return ProjectLibraryImageReferenceSchema.parse(item?{schema:'project-library-image-reference-v1',kind:'library',item}:ref.startsWith('library/')?{schema:'project-library-image-reference-v1',kind:'unavailable'}:{schema:'project-library-image-reference-v1',kind:'external',ref});}
}
export type ProjectLibraryMessageContext=LibraryMessageContext;
const contexts=new WeakMap<object,LibraryMessageContext>();
/** Index one captured library snapshot, rather than parse and clone its whole list for each message. */
export function projectLibraryMessageContext(raw:unknown):ProjectLibraryMessageContext{const key=raw!==null&&typeof raw==='object'?raw:undefined,known=key&&contexts.get(key);if(known)return known;const context=new LibraryMessageContext(raw);if(key)contexts.set(key,context);return context;}
export function projectLibraryMessage(context:ProjectLibraryMessageContext,raw:unknown){return context.message(raw);}
export function projectLibraryMessageImage(context:ProjectLibraryMessageContext,raw:unknown){return context.image(raw);}
export function projectLibraryMessageReadNeeded(raw:unknown){return z.string().parse(raw).includes('library/');}
/** Metadata hydration is best effort; a failed or foreign read keeps the captured project snapshot. */
export async function projectLibraryMessageRead(context:ProjectLibraryMessageContext,load:()=>Promise<unknown>):Promise<ProjectLibraryMessageContext>{try{const next=projectLibraryMessageContext(await load());if(next.projectId!==context.projectId)throw Object.assign(new Error('These message files belong to another project.'),{status:502});return next;}catch{return context;}}
