import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ProjectLibraryItemSchema} from './library-schemas.js';
import {projectAttachmentFileSize} from './project-attachments.js';
export const ProjectLibraryFilterSchema=z.enum(['all','owner','thread','job']);
export type ProjectLibraryFilter=z.infer<typeof ProjectLibraryFilterSchema>;
export const ProjectLibraryPolicySchema=z.strictObject({schema:z.literal('project-library-policy-v1'),cacheMs:z.literal(2000),pollMs:z.literal(15000),initialFailure:z.literal('surface'),pollFailure:z.literal('retain'),refreshBypassesCache:z.literal(true)});
export const PROJECT_LIBRARY_POLICY=Object.freeze(ProjectLibraryPolicySchema.parse({schema:'project-library-policy-v1',cacheMs:2000,pollMs:15000,initialFailure:'surface',pollFailure:'retain',refreshBypassesCache:true}));
export const ProjectLibraryReadFailureContextSchema=z.strictObject({schema:z.literal('project-library-read-failure-context-v1'),phase:z.enum(['initial','poll'])});
export const ProjectLibraryReadFailureSchema=z.strictObject({schema:z.literal('project-library-read-failure-v1'),route:z.enum(['surface','retain'])});
export function projectLibraryReadFailure(raw:unknown){const context=ProjectLibraryReadFailureContextSchema.parse(raw);return ProjectLibraryReadFailureSchema.parse({schema:'project-library-read-failure-v1',route:context.phase==='initial'?PROJECT_LIBRARY_POLICY.initialFailure:PROJECT_LIBRARY_POLICY.pollFailure});}
export const ProjectLibraryViewRequestSchema=z.strictObject({schema:z.literal('project-library-view-request-v1'),source:ProjectLibraryFilterSchema.default('all')});
export const ProjectLibrarySourceSchema=z.strictObject({schema:z.literal('project-library-source-v1'),projectId:IdSchema,items:z.array(ProjectLibraryItemSchema),threads:z.array(z.strictObject({id:IdSchema,title:z.string()}))}).superRefine((source,ctx)=>{if(source.items.some(item=>item.projectId!==source.projectId))ctx.addIssue({code:'custom',message:'These library files belong to another project.'});});
export const ProjectLibraryDeleteSchema=z.strictObject({schema:z.literal('project-library-delete-v1'),projectId:IdSchema,itemId:IdSchema});
export function projectLibraryDelete(projectId:string,itemId:string){return ProjectLibraryDeleteSchema.parse({schema:'project-library-delete-v1',projectId,itemId});}
export const ProjectLibraryRowSchema=z.strictObject({item:ProjectLibraryItemSchema,kind:z.enum(['image','file']),sizeLabel:z.string(),originLabel:z.string(),openLabel:z.string(),deleteTitle:z.string(),contentPath:z.string(),downloadPath:z.string(),deletePath:z.string(),commandPath:z.string(),deleteCommand:ProjectLibraryDeleteSchema}).superRefine((row,ctx)=>{
 const base=`/api/projects/${row.item.projectId}/library/${row.item.id}`;if(row.contentPath!==base+'/content'||row.downloadPath!==base+'/content?download'||row.deletePath!==base||row.commandPath!==`/api/projects/${row.item.projectId}/library/command`||row.deleteCommand.projectId!==row.item.projectId||row.deleteCommand.itemId!==row.item.id)ctx.addIssue({code:'custom',message:'This library action belongs to another file.'});
});
export const ProjectLibraryViewSchema=z.strictObject({schema:z.literal('project-library-view-v1'),projectId:IdSchema,source:ProjectLibraryFilterSchema,total:z.number().int().nonnegative(),bytes:z.number().int().nonnegative(),isEmpty:z.boolean(),policy:ProjectLibraryPolicySchema,filters:z.array(z.strictObject({value:ProjectLibraryFilterSchema,label:z.string()})).length(4),labels:z.strictObject({title:z.string(),upload:z.string(),empty:z.string(),open:z.string(),download:z.string(),delete:z.string()}),rows:z.array(ProjectLibraryRowSchema),images:z.array(ProjectLibraryItemSchema)}).superRefine((view,ctx)=>{
 if(view.rows.some(row=>row.item.projectId!==view.projectId||view.source!=='all'&&row.item.source!==view.source)||view.images.some(item=>item.projectId!==view.projectId))ctx.addIssue({code:'custom',message:'This library view includes another source.'});
});
export type ProjectLibraryView=z.infer<typeof ProjectLibraryViewSchema>;
export function projectLibraryRequest(raw?:unknown){return ProjectLibraryViewRequestSchema.parse(raw??{schema:'project-library-view-request-v1'});}
export function projectLibraryView(rawSource:unknown,rawRequest?:unknown):ProjectLibraryView{
 const source=ProjectLibrarySourceSchema.parse(rawSource),request=projectLibraryRequest(rawRequest),titles=new Map(source.threads.map(thread=>[thread.id,thread.title]));
 const rows=source.items.map(item=>{const base=`/api/projects/${source.projectId}/library/${item.id}`,threadName=item.threadId===undefined?'undefined':titles.get(item.threadId)??item.threadId;return{item,kind:item.mime.startsWith('image/')?'image' as const:'file' as const,sizeLabel:projectAttachmentFileSize(item.size),originLabel:item.source==='owner'?'From you':item.source==='job'?'From a job':`From "${threadName}"`,openLabel:`Open ${item.name}`,deleteTitle:`Delete ${item.name} from the library?`,contentPath:base+'/content',downloadPath:base+'/content?download',deletePath:base,commandPath:`/api/projects/${source.projectId}/library/command`,deleteCommand:projectLibraryDelete(source.projectId,item.id)};});
 return ProjectLibraryViewSchema.parse({schema:'project-library-view-v1',projectId:source.projectId,source:request.source,total:source.items.length,bytes:source.items.reduce((sum,item)=>sum+item.size,0),isEmpty:source.items.length===0,policy:PROJECT_LIBRARY_POLICY,filters:[{value:'all',label:'All'},{value:'owner',label:'Uploads'},{value:'thread',label:'From threads'},{value:'job',label:'From jobs'}],labels:{title:'Library',upload:'Upload',empty:'Nothing in the library yet. Attach files to a message or upload them here.',open:'Open',download:'Download',delete:'Delete'},rows:rows.filter(row=>request.source==='all'||row.item.source===request.source),images:source.items.filter(item=>item.mime.startsWith('image/'))});
}
/** Selects from one captured all-source snapshot without reparsing the full list on each render. */
export function projectLibraryFilter(view:ProjectLibraryView,raw:unknown):ProjectLibraryView{const selected=ProjectLibraryFilterSchema.parse(raw);if(view.source!=='all')throw Object.assign(new Error('Read the complete library before changing its source filter.'),{status:409});return{...view,source:selected,rows:view.rows.filter(row=>selected==='all'||row.item.source===selected)};}
function immutable<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}
/** Per-viewer transport cache; old failures cannot discard a newer read, and expiry starts with the request. */
export function projectLibraryReadCache(now:()=>number=Date.now){
 const entries=new Map<string,{at:number;promise:Promise<ProjectLibraryView>}>();
 return{
  read(rawProjectId:string,load:()=>Promise<unknown>,reload=false):Promise<ProjectLibraryView>{
   const projectId=IdSchema.parse(rawProjectId);if(reload)entries.delete(projectId);const cached=entries.get(projectId);if(cached&&now()-cached.at<PROJECT_LIBRARY_POLICY.cacheMs)return cached.promise;
   const own={at:now(),promise:Promise.resolve().then(async()=>{const view=ProjectLibraryViewSchema.parse(await load());if(view.projectId!==projectId||view.source!=='all')throw Object.assign(new Error('The library read belongs to another project or source.'),{status:502});return immutable(view);})};entries.set(projectId,own);void own.promise.catch(()=>{if(entries.get(projectId)===own)entries.delete(projectId);});return own.promise;
  },
  invalidate(projectId:string){entries.delete(IdSchema.parse(projectId));},
 };
}
