import {z} from 'zod';
import {IdSchema,TimestampSchema} from './schemas.js';
import {GitHubTokenStateSchema,SecretInputSchema,EmptySchema} from './client-schemas.js';
export const GIT_TOKEN_COPY={label:'GitHub token',loading:'Loading…',notSet:'Not set',add:'Add token',replace:'Replace',remove:'Remove',addTitle:'Add a GitHub token',replaceTitle:'Replace the GitHub token',replaceNote:'The saved token is replaced when you submit this form.',save:'Save token',saved:'GitHub token saved.',removeTitle:'Remove the GitHub token?',removeBody:'Threads then push their branches without opening pull requests, and their pull requests can no longer be checked or merged from Jevellan.',removed:'GitHub token removed.',
 defaultHelp:'Used only to open, read and merge pull requests for Jevellan threads. A fine-grained token with Pull requests read and write, Contents read and write, Checks read and Commit statuses read on your repositories is enough.',projectHelp:'This token is saved for this project. Grant Pull requests, Checks and Actions access, and Contents read/write for publishing and merging. Actions write enables workflow dispatch.'} as const;
export const GitTokenViewSchema=z.strictObject({schema:z.literal('github-token-view-v1'),projectId:IdSchema.nullable(),state:GitHubTokenStateSchema.nullable(),endpoint:z.string(),readPath:z.string(),label:z.string(),help:z.string(),summaryAt:TimestampSchema.nullable(),canSave:z.boolean(),canRemove:z.boolean(),saveLabel:z.string(),saveTitle:z.string(),saveNote:z.string().nullable(),saveButton:z.string(),savedMessage:z.string(),removeLabel:z.string(),removeTitle:z.string(),removeBody:z.string(),removedMessage:z.string()});
export type GitTokenView=z.infer<typeof GitTokenViewSchema>;
export const GitTokenReadRequestSchema=z.strictObject({schema:z.literal('github-token-read-v1'),projectId:IdSchema.optional()});
export const GitTokenCommandSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema:z.literal('github-token-command-v1'),operation:z.literal('save'),projectId:IdSchema.optional(),input:SecretInputSchema}),
 z.strictObject({schema:z.literal('github-token-command-v1'),operation:z.literal('remove'),projectId:IdSchema.optional(),input:EmptySchema}),
]);
export function gitTokenScope(value:string):string|undefined{return value===''?undefined:IdSchema.parse(value);}
export function gitTokenView(raw:unknown,projectId?:string):GitTokenView{
 const scope=projectId===undefined?null:IdSchema.parse(projectId),state=raw===null?null:GitHubTokenStateSchema.parse(raw),saved=state?.saved===true;
 const query=scope?'?projectId='+encodeURIComponent(scope):'';
 return GitTokenViewSchema.parse({schema:'github-token-view-v1',projectId:scope,state,endpoint:'/hub/secrets/github'+query,readPath:'/api/git/token-view'+query,label:GIT_TOKEN_COPY.label,help:scope?GIT_TOKEN_COPY.projectHelp:GIT_TOKEN_COPY.defaultHelp,summaryAt:state?.saved?state.updatedAt:null,canSave:state!==null,canRemove:saved,saveLabel:saved?GIT_TOKEN_COPY.replace:GIT_TOKEN_COPY.add,saveTitle:saved?GIT_TOKEN_COPY.replaceTitle:GIT_TOKEN_COPY.addTitle,saveNote:saved?GIT_TOKEN_COPY.replaceNote:null,saveButton:GIT_TOKEN_COPY.save,savedMessage:GIT_TOKEN_COPY.saved,removeLabel:GIT_TOKEN_COPY.remove,removeTitle:GIT_TOKEN_COPY.removeTitle,removeBody:GIT_TOKEN_COPY.removeBody,removedMessage:GIT_TOKEN_COPY.removed});
}
export function gitTokenSavedSummary(formattedDate:string):string{return `Saved · updated ${formattedDate}`;}
export function gitTokenSummary(view:GitTokenView,formattedDate:string):string{return view.state===null?GIT_TOKEN_COPY.loading:view.state.saved?gitTokenSavedSummary(formattedDate):GIT_TOKEN_COPY.notSet;}
export function gitTokenCanSubmit(value:string,busy:boolean):boolean{return !busy&&value.length>0;}
export function gitTokenReadResult(projectId:string|undefined,raw:unknown):GitTokenView{const view=GitTokenViewSchema.parse(raw);if(view.projectId!==(projectId??null))throw Error('The token reply belongs to another scope.');return view;}
export function gitTokenSaveCommand(projectId:string|undefined,value:string,clientRequestId?:string){return GitTokenCommandSchema.options[0].parse({schema:'github-token-command-v1',operation:'save',...(projectId===undefined?{}:{projectId}),input:{schema:'save-secret-v1',value,...(clientRequestId===undefined?{}:{clientRequestId})}});}
export function gitTokenRemoveCommand(projectId?:string){return GitTokenCommandSchema.options[1].parse({schema:'github-token-command-v1',operation:'remove',...(projectId===undefined?{}:{projectId}),input:{schema:'empty-request-v1'}});}
export function gitTokenCommandResult(raw:unknown,result:unknown){const request=GitTokenCommandSchema.parse(raw),view=GitTokenViewSchema.parse(result);if(view.projectId!==(request.projectId??null))throw Error('The token reply belongs to another scope.');return view;}
