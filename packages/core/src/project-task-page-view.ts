import {z} from 'zod';
import {IdSchema} from './schemas.js';
import {ProjectWorkTaskSchema,type ProjectWorkTask} from './project-loop-schemas.js';
import {PullRequestStateSchema,type ThreadIndex} from './project-schemas.js';

export const ProjectTaskPagePolicySchema=z.strictObject({schema:z.literal('project-task-page-policy-v1'),pollHintMs:z.literal(30000),loadingLabel:z.string(),backLabel:z.string(),threadLabel:z.string()});
export const projectTaskPagePolicy=Object.freeze(ProjectTaskPagePolicySchema.parse({schema:'project-task-page-policy-v1',pollHintMs:30000,loadingLabel:'Loading task…',backLabel:'Back to project',threadLabel:'Open thread'}));
const link=z.strictObject({label:z.string(),href:z.string().startsWith('/projects/')});
export const ProjectTaskPageViewSchema=z.strictObject({schema:z.literal('project-task-page-view-v1'),projectId:IdSchema,taskId:IdSchema,task:ProjectWorkTaskSchema,policy:ProjectTaskPagePolicySchema,meta:z.string(),back:link,threadLink:link.extend({id:IdSchema}).nullable(),pullRequest:z.strictObject({threadId:IdSchema,number:PullRequestStateSchema.shape.number,url:PullRequestStateSchema.shape.url,state:PullRequestStateSchema.shape.state,headSha:PullRequestStateSchema.shape.headSha,label:z.string()}).nullable()}).superRefine((view,ctx)=>{
 if(view.task.projectId!==view.projectId||view.task.id!==view.taskId)ctx.addIssue({code:'custom',message:'This view belongs to another task or project.'});
 if(view.threadLink&&view.threadLink.id!==view.task.threadId||view.pullRequest&&view.pullRequest.threadId!==view.task.threadId)ctx.addIssue({code:'custom',message:'This view belongs to another thread.'});
});
export type ProjectTaskPageView=z.infer<typeof ProjectTaskPageViewSchema>;
export function projectTaskPageBack(projectId:string){return{label:projectTaskPagePolicy.backLabel,href:`/projects/${IdSchema.parse(projectId)}`};}
/** The same paired read as TaskPage, with the first matching thread and no writer or history work. */
export function projectTaskPageView(projectId:string,task:ProjectWorkTask,threads:readonly ThreadIndex[]):ProjectTaskPageView{
 IdSchema.parse(projectId);
 if(task.projectId!==projectId)throw Object.assign(new Error('This task belongs to another project.'),{status:409});
 const thread=threads.find(row=>row.id===task.threadId);
 if(thread&&thread.projectId!==projectId)throw Object.assign(new Error('This thread belongs to another project.'),{status:409});
 const pr=thread?.pr;
 return ProjectTaskPageViewSchema.parse({schema:'project-task-page-view-v1',projectId,taskId:task.id,task,policy:projectTaskPagePolicy,meta:`${task.type} · ${task.state}`,back:projectTaskPageBack(projectId),threadLink:task.threadId?{id:task.threadId,label:projectTaskPagePolicy.threadLabel,href:`/projects/${projectId}/threads/${task.threadId}`}:null,pullRequest:thread&&pr?{threadId:thread.id,number:pr.number,url:pr.url,state:pr.state,headSha:pr.headSha,label:`#${pr.number} · ${pr.state}`}:null});
}
