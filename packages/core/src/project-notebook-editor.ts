import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {NotebookRequestSchema,ProjectNotebookSchema,ProjectNotebookViewSchema} from './project-schemas.js';
export const PROJECT_NOTEBOOK_CHANGED='The coordinator changed the notebook. Reload to see its version.';
export const ProjectNotebookPolicySchema=z.strictObject({schema:z.literal('project-notebook-policy-v1'),contentMax:z.number().int().positive(),readWhileEditing:z.literal(false),readOnRevisionChange:z.literal(true)});
export const ProjectNotebookEditorSchema=z.strictObject({schema:z.literal('project-notebook-editor-v1'),projectId:IdSchema,revision:NotebookRequestSchema.shape.expectedRevision,content:NotebookRequestSchema.shape.content,hasContent:z.boolean(),updatedAt:ProjectNotebookSchema.shape.updatedAt.nullable(),updatedBy:ProjectNotebookSchema.shape.updatedBy.nullable(),policy:ProjectNotebookPolicySchema,paths:z.strictObject({read:z.string(),save:z.string()}),labels:z.strictObject({title:z.string(),content:z.string(),conflict:z.string(),empty:z.string()})});
export type ProjectNotebookEditor=z.infer<typeof ProjectNotebookEditorSchema>;
export const ProjectNotebookCommandSchema=z.strictObject({schema:z.literal('project-notebook-command-v1'),projectId:IdSchema,body:NotebookRequestSchema});
export const ProjectNotebookFailureContextSchema=z.strictObject({schema:z.literal('project-notebook-failure-context-v1'),apiStatus:z.number().int().nonnegative().optional(),apiCode:z.string().optional()});
export const ProjectNotebookFailureSchema=z.strictObject({schema:z.literal('project-notebook-failure-v1'),conflict:z.boolean(),notice:z.string().nullable()});
export function projectNotebookEditor(rawProjectId:string,raw:unknown):ProjectNotebookEditor{
 const projectId=IdSchema.parse(rawProjectId),view=ProjectNotebookViewSchema.parse(raw),notebook=view.notebook,content=notebook?.content??'';
 if(notebook&&notebook.projectId!==projectId)throw Object.assign(new Error('This notebook belongs to another project.'),{status:409,code:'wrong_resource'});
 return ProjectNotebookEditorSchema.parse({schema:'project-notebook-editor-v1',projectId,revision:view.revision,content,hasContent:!!content.trim(),updatedAt:notebook?.updatedAt??null,updatedBy:notebook?.updatedBy??null,policy:{schema:'project-notebook-policy-v1',contentMax:NotebookRequestSchema.shape.content.maxLength,readWhileEditing:false,readOnRevisionChange:true},paths:{read:`/api/projects/${projectId}/notebook/editor`,save:`/api/projects/${projectId}/notebook`},labels:{title:'Notebook',content:'Notebook content',conflict:PROJECT_NOTEBOOK_CHANGED,empty:'Nothing in the notebook yet. The coordinator keeps decisions, conventions and the current plan here.'}});
}
/** Captures the read revision; preparation never rereads a newer notebook. */
export function projectNotebookCommand(projectId:string,expectedRevision:number,content:string){return ProjectNotebookCommandSchema.parse({schema:'project-notebook-command-v1',projectId,body:{schema:'notebook-request-v1',expectedRevision,content}});}
/** The browser supplies API facts only for an actual ApiError. */
export function projectNotebookFailure(raw:unknown){const context=ProjectNotebookFailureContextSchema.parse(raw),conflict=context.apiStatus===409&&context.apiCode==='conflict';return ProjectNotebookFailureSchema.parse({schema:'project-notebook-failure-v1',conflict,notice:conflict?PROJECT_NOTEBOOK_CHANGED:null});}
export const projectNotebookUpdated=(by:'coordinator'|'owner',when:string)=>`Updated by ${by==='owner'?'you':'the coordinator'} · ${when}`;
