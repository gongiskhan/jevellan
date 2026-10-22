import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {LIBRARY_FILE_LIMIT,ProjectLibraryItemSchema} from './library-schemas.js';
export const PROJECT_ATTACHMENT_LIMIT_MESSAGE='Attach up to 10 files per message.';
export const PROJECT_ATTACHMENT_SIZE_MESSAGE='Files up to 50 MB.';
export const PROJECT_ATTACHMENT_UPLOAD_FAILED='The file could not be uploaded.';
export const ProjectAttachmentPolicySchema=z.strictObject({schema:z.literal('project-attachment-policy-v1'),maximumFiles:z.literal(10),maximumFileBytes:z.literal(LIBRARY_FILE_LIMIT),defaultMime:z.literal('application/octet-stream'),labels:z.strictObject({count:z.literal(PROJECT_ATTACHMENT_LIMIT_MESSAGE),size:z.literal(PROJECT_ATTACHMENT_SIZE_MESSAGE),uploadFailed:z.literal(PROJECT_ATTACHMENT_UPLOAD_FAILED)})});
const attachmentPolicy=ProjectAttachmentPolicySchema.parse({schema:'project-attachment-policy-v1',maximumFiles:10,maximumFileBytes:LIBRARY_FILE_LIMIT,defaultMime:'application/octet-stream',labels:{count:PROJECT_ATTACHMENT_LIMIT_MESSAGE,size:PROJECT_ATTACHMENT_SIZE_MESSAGE,uploadFailed:PROJECT_ATTACHMENT_UPLOAD_FAILED}});
export const PROJECT_ATTACHMENT_POLICY=Object.freeze({...attachmentPolicy,labels:Object.freeze(attachmentPolicy.labels)});
export const ProjectAttachmentPolicyViewSchema=z.strictObject({schema:z.literal('project-attachment-policy-view-v1'),projectId:IdSchema,policy:ProjectAttachmentPolicySchema});
export const ProjectAttachmentAdmissionRequestSchema=z.strictObject({schema:z.literal('project-attachment-admission-request-v1'),existingCount:z.number().int().nonnegative(),files:z.array(z.strictObject({size:z.number().int().nonnegative()}))});
export const ProjectAttachmentAdmissionSchema=z.strictObject({schema:z.literal('project-attachment-admission-v1'),allowed:z.boolean(),refusal:z.string().nullable()});
export function projectAttachmentPolicy(projectId:string){return ProjectAttachmentPolicyViewSchema.parse({schema:'project-attachment-policy-view-v1',projectId,policy:PROJECT_ATTACHMENT_POLICY});}
export function projectAttachmentAdmission(raw:unknown){const input=ProjectAttachmentAdmissionRequestSchema.parse(raw),refusal=input.existingCount+input.files.length>PROJECT_ATTACHMENT_POLICY.maximumFiles?PROJECT_ATTACHMENT_LIMIT_MESSAGE:input.files.some(file=>file.size>LIBRARY_FILE_LIMIT)?PROJECT_ATTACHMENT_SIZE_MESSAGE:null;return ProjectAttachmentAdmissionSchema.parse({schema:'project-attachment-admission-v1',allowed:refusal===null,refusal});}
export const projectAttachmentFileSize=(size:number)=>size>=1024*1024?`${(size/1024/1024).toFixed(1)} MB`:size>=1024?`${(size/1024).toFixed(1)} KB`:`${size} B`;
const text=z.string().max(200000);
export const ProjectAttachmentRequestSchema=z.strictObject({schema:z.literal('project-attachment-request-v1'),text,itemIds:z.array(IdSchema).max(10)});
export const ProjectAttachmentViewSchema=z.strictObject({schema:z.literal('project-attachment-v1'),id:IdSchema,projectId:IdSchema,path:ProjectLibraryItemSchema.shape.path,name:ProjectLibraryItemSchema.shape.name,mime:ProjectLibraryItemSchema.shape.mime,size:ProjectLibraryItemSchema.shape.size,kind:z.enum(['image','file']),sizeLabel:z.string()});
export const ProjectAttachmentMessageSchema=z.strictObject({schema:z.literal('project-attachment-message-v1'),projectId:IdSchema,text,attachments:z.array(ProjectAttachmentViewSchema).max(10),policy:ProjectAttachmentPolicySchema});
export type ProjectAttachmentMessage=z.infer<typeof ProjectAttachmentMessageSchema>;
const attachmentText=(value:string,items:readonly {path:string;mime:string;size:number}[])=>`${value.trim()}${items.length?`\n\n${items.map(item=>`Attached file: library/${item.path} (${item.mime}, ${projectAttachmentFileSize(item.size)})`).join('\n')}`:''}`.trim();
export function projectAttachmentMessage(rawProjectId:string,value:string,rawItems:unknown[]):ProjectAttachmentMessage{
 const projectId=IdSchema.parse(rawProjectId),items=z.array(ProjectLibraryItemSchema).max(10).parse(rawItems);
 if(items.some(item=>item.projectId!==projectId))throw Object.assign(new Error('These attachments belong to another project.'),{status:409});
 return ProjectAttachmentMessageSchema.parse({schema:'project-attachment-message-v1',projectId,text:attachmentText(value,items),attachments:items.map(item=>({schema:'project-attachment-v1',id:item.id,projectId:item.projectId,path:item.path,name:item.name,mime:item.mime,size:item.size,kind:item.mime.startsWith('image/')?'image':'file',sizeLabel:projectAttachmentFileSize(item.size)})),policy:PROJECT_ATTACHMENT_POLICY});
}
export const ProjectAttachmentUploadRequestSchema=z.strictObject({schema:z.literal('project-attachment-upload-request-v1'),projectId:IdSchema,name:z.string(),mime:z.string(),size:z.number().int().nonnegative()});
export const ProjectAttachmentUploadSchema=z.strictObject({schema:z.literal('project-attachment-upload-v1'),path:z.string(),mime:z.string(),size:z.number().int().nonnegative()});
export function projectAttachmentUpload(raw:unknown){const input=ProjectAttachmentUploadRequestSchema.parse(raw);if(input.size>LIBRARY_FILE_LIMIT)throw new Error(PROJECT_ATTACHMENT_SIZE_MESSAGE);return ProjectAttachmentUploadSchema.parse({schema:'project-attachment-upload-v1',path:`/api/projects/${input.projectId}/library/uploads/${encodeURIComponent(input.name)}`,mime:input.mime||PROJECT_ATTACHMENT_POLICY.defaultMime,size:input.size});}
export const ProjectAttachmentContextSchema=z.strictObject({schema:z.literal('project-attachment-context-v1'),projectId:IdSchema,text,entries:z.array(z.strictObject({key:z.number().int().positive(),itemId:IdSchema})).max(10)});
const signature=(value:z.infer<typeof ProjectAttachmentContextSchema>)=>JSON.stringify({projectId:value.projectId,text:value.text.trim(),entries:value.entries});
/** Transport-owned loader; successful snapshots survive a lost message receipt until explicitly cleared. */
export function projectAttachmentPreparation(){
 let pending:{signature:string;promise:Promise<ProjectAttachmentMessage>}|undefined;
 return{
  async prepare(raw:unknown,load:(request:z.infer<typeof ProjectAttachmentRequestSchema>)=>Promise<unknown>):Promise<ProjectAttachmentMessage>{
   const context=ProjectAttachmentContextSchema.parse(raw),key=signature(context);
   if(pending?.signature!==key){
    const own={signature:key,promise:Promise.resolve().then(async()=>{
     const request=ProjectAttachmentRequestSchema.parse({schema:'project-attachment-request-v1',text:context.text,itemIds:context.entries.map(entry=>entry.itemId)}),message=ProjectAttachmentMessageSchema.parse(await load(request));
     if(message.projectId!==context.projectId||message.attachments.length!==context.entries.length||message.attachments.some((item,i)=>item.projectId!==context.projectId||item.id!==context.entries[i]!.itemId)||message.text!==attachmentText(context.text,message.attachments))throw Object.assign(new Error('The attachment preparation does not match this request.'),{status:502});
     return message;
    })};
    pending=own;void own.promise.catch(()=>{if(pending===own)pending=undefined;});
   }
   // Each caller gets a copy; mutation cannot change the next retry's captured body.
   return ProjectAttachmentMessageSchema.parse(await pending!.promise);
  },
  clear(raw:unknown){if(pending?.signature===signature(ProjectAttachmentContextSchema.parse(raw)))pending=undefined;},
 };
}
