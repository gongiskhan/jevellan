import {landingCheckEnvironment} from './landing-resources.js';
import {existsSync} from 'node:fs';
import {IntakeLandingSchema,ProjectDecisionSchema,boundedRedaction,parseGitHubRemote,resolveProjectPath,withPublicationLease,
 type IntakeCheck,type IntakeCheckResultSchema,type IntakeLanding,type NativeProcess,type ProjectJobRun,type PublicationLeaseService} from '@jevellan/core';
import type {z} from 'zod';
import type {ProjectIntake} from './intake.js';
import {derivedId} from './decision-items.js';
import {GIT_NETWORK_TIMEOUT_MS,threadBaseRef} from './git.js';
import {selectedLandingChecks} from './landing.js';
import {outputTail,runThreadCommand,SETUP_TIMEOUT_MS,TEST_TIMEOUT_MS} from './verification.js';
type Options=ProjectIntake['o']&{leases?:PublicationLeaseService|undefined;assertIntakeLanding?(projectId:string):Promise<void>};
type Outcome={conclusion:'passed'|'failed';summary:string};
function refuse(message:string):never{throw Object.assign(Error(message),{status:409});}
/** Owner-approved jobs use the same checks and publication lease without inventing a thread. */
export class ProjectIntakeLanding{
 constructor(readonly o:Options){}
 #at(){return new Date(this.o.now()).toISOString();}
 #id(run:ProjectJobRun){return derivedId('intake_landing',run.id);}
 #path(run:ProjectJobRun,attempt:number){return this.o.homes.at('worktrees',run.projectId,'intake-landing',run.id,String(attempt));}
 async #save(row:IntakeLanding){const saved=(await this.o.hub.putIntakeDocument(IntakeLandingSchema.parse(boundedRedaction(this.o.redactor,row)),row.revision)).document;if(saved.schema!=='intake-landing-v1')throw Error('The intake landing receipt changed kind.');return saved;}
 async #context(run:ProjectJobRun){
  const stored=(await this.o.hub.jobRun(run.id))?.document,binding=run.intakeLanding;
  if(!binding||!stored?.intakeLanding||stored.intakeLanding.actionId!==binding.actionId||stored.intakeLanding.checkId!==binding.checkId||stored.deviceId!==this.o.deviceId||stored.projectId!==run.projectId)refuse('This job has no matching intake execution binding.');
  const check=(await this.o.hub.intakeDocument(binding.checkId))?.document,action=(await this.o.hub.intakeDocument(binding.actionId))?.document;
  if(check?.schema!=='intake-check-v1'||check.status!=='checked'||check.projectId!==run.projectId||action?.schema!=='intake-action-v1'||action.checkId!==check.id||action.answer.optionLabel!=='merge'||action.taskId!==run.taskId)refuse('The checked head or owner approval changed.');
  const decision=(await this.o.hub.decision(action.decisionId))?.document;if(decision?.answer?.optionLabel!=='merge'||decision.intake?.head!==check.pull.headSha)refuse('The intake owner approval is unavailable.');
  const project=await this.o.project(run.projectId),repo=resolveProjectPath(project,this.o.deviceId,this.o.deviceName),remote=await this.o.git.remoteUrl(repo),repository=remote&&parseGitHubRemote(remote);
  if(!remote||!repository||repository.owner.toLowerCase()!==check.repository.owner.toLowerCase()||repository.repo.toLowerCase()!==check.repository.repo.toLowerCase()||check.pull.baseRef!==run.baseBranch)refuse('The intake repository or registered base changed.');
  const token=await this.o.github.token(project.id);if(!token)refuse('No GitHub token is saved for this project.');this.o.redactor.add(token);
  return{check,repo,remote,client:this.o.github.client(token),gitEnv:await this.o.github.turnGitEnvironment(project.id,remote)};
 }
 async #clean(run:ProjectJobRun,row:IntakeLanding):Promise<boolean>{
  const path=this.#path(run,row.attempt);if(!existsSync(path))return false;
  const expected=row.candidate?.commit??row.baseCommit;
  try{if(await this.o.git.resolve(path,'HEAD')!==expected||(await this.o.git.run(path,['status','--porcelain=v1','--untracked-files=all'])).stdout)return true;
   const project=await this.o.project(run.projectId),repo=resolveProjectPath(project,this.o.deviceId,this.o.deviceName);await this.o.git.run(repo,['worktree','remove',path]);return false;
  }catch{return true;}
 }
 async #failed(run:ProjectJobRun,row:IntakeLanding,check:IntakeCheck,message:string):Promise<Outcome>{
  const failure=this.o.redactor.text(message).slice(0,1200),decisionId=derivedId('pdec','intake-landing-failed',row.id),retained=await this.#clean(run,row);
  row=await this.#save({...row,state:'failed',failure,decisionId,endedAt:this.#at(),worktreeRetained:retained});
  if(!(await this.o.hub.decision(decisionId)))await this.o.hub.createDecision(ProjectDecisionSchema.parse({schema:'project-decision-v1',id:decisionId,projectId:run.projectId,revision:0,from:'coordinator',createdAt:this.#at(),question:`Landing PR #${check.pull.number} failed${row.baseCommit!==check.baseCommit?' after main moved':''}: ${failure}`.slice(0,2000),options:['redo','close','later'].map(label=>({label})),intake:{checkId:check.id,runId:check.runId,number:check.pull.number,head:check.pull.headSha}}));
  return{conclusion:'failed',summary:`Landing PR #${check.pull.number} did not complete: ${failure}`.slice(0,1200)};
 }
 /** Read-only ancestry recovery. It never repeats a push after a lost acknowledgement or restart. */
 async recover(run:ProjectJobRun):Promise<Outcome|null>{
  const row=(await this.o.hub.intakeDocument(this.#id(run)))?.document;if(row?.schema!=='intake-landing-v1')return null;
  if(row.state==='landed')return{conclusion:'passed',summary:'The recorded intake landing completed.'};
  const {check,repo,gitEnv}=await this.#context(run),ref=threadBaseRef(derivedId('intake_recover',run.id));
  try{const base=await this.o.git.fetchPrivate(repo,run.baseBranch,ref,undefined,gitEnv);
   if(row.candidate&&(await this.o.git.run(repo,['merge-base','--is-ancestor',row.candidate.commit,base],{permitted:[1,128]})).code===0){const retained=await this.#clean(run,row);await this.#save({...row,state:'landed',endedAt:row.endedAt??this.#at(),failure:null,worktreeRetained:retained});return{conclusion:'passed',summary:`PR #${check.pull.number} landed at ${row.candidate.commit.slice(0,7)}; confirmed by main ancestry without another push.`};}
   return this.#failed(run,row,check,'The interrupted landing was not confirmed on main. No push was repeated.');
  }finally{await this.o.git.run(repo,['update-ref','-d',ref]).catch(()=>undefined);}
 }
 async execute(run:ProjectJobRun,signal:AbortSignal,onProcess:(process:NativeProcess)=>void):Promise<Outcome>{
  const {check,repo,remote,client,gitEnv}=await this.#context(run),leases=this.o.leases;if(!leases)refuse('The publication lease service is unavailable.');
  const id=this.#id(run),previous=(await this.o.hub.intakeDocument(id))?.document;
  if(previous?.schema==='intake-landing-v1'){const recovered=await this.recover(run);if(recovered)return recovered;}
  let row=await this.#save(IntakeLandingSchema.parse({schema:'intake-landing-v1',id,projectId:run.projectId,revision:0,deviceId:this.o.deviceId,runId:run.id,actionId:run.intakeLanding!.actionId,checkId:check.id,source:'owner',head:check.pull.headSha,baseCommit:run.commit,attempt:0,at:this.#at(),state:'checking',candidate:null,failure:null,decisionId:null,endedAt:null}));
  const ref=threadBaseRef(derivedId('intake_base',run.id)),pullRef=`refs/jevellan/threads/${derivedId('intake_pull',run.id)}/pull-head`;
  try{return await withPublicationLease<Outcome>(leases,remote,run.id,async assertLease=>{
   for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();await this.o.assertIntakeLanding?.(run.projectId);await assertLease();const settings=await this.o.settings(run.projectId);if(settings.status!=='active')refuse('Project work is paused.');
    const pull=await client.intakePull(check.repository,check.pull.number);if(pull.headSha!==check.pull.headSha||pull.baseRef!==check.pull.baseRef||pull.state!=='open'||pull.merged)refuse('The pull request head or base changed before landing.');
    const base=await this.o.git.fetchPrivate(repo,run.baseBranch,ref,signal,gitEnv);if((await this.o.git.run(repo,['merge-base','--is-ancestor',run.commit,base],{permitted:[1,128]})).code!==0)refuse('Main history changed before landing.');
    const head=await this.o.git.fetchPullHead(repo,pull.number,pullRef,signal,gitEnv);if(head!==check.pull.headSha)refuse('The contributor head changed before landing.');
    if((await this.o.git.run(repo,['merge-base','--is-ancestor',head,base],{permitted:[1,128]})).code===0){await this.#save({...row,state:'already-on-main',baseCommit:base,endedAt:this.#at()});return{conclusion:'passed',summary:`PR #${pull.number}'s exact head is already on main; no push was made.`};}
    row=await this.#save({...row,attempt,baseCommit:base,state:'checking',candidate:null});this.o.homes.ensure('worktrees',run.projectId,'intake-landing',run.id);const path=this.#path(run,attempt);if(existsSync(path))refuse('The intake landing has a leftover worktree that needs attention.');
    await this.o.git.run(repo,['worktree','add','--detach',path,base],{signal});
    const identity=await this.o.git.identity(repo),identityEnv=identity?{GIT_AUTHOR_NAME:identity.name,GIT_AUTHOR_EMAIL:identity.email,GIT_COMMITTER_NAME:identity.name,GIT_COMMITTER_EMAIL:identity.email}:{};
    await this.o.git.run(path,['merge','--no-ff',head,'-m',`Land PR #${pull.number}: ${pull.title}`.slice(0,500)],{signal,env:identityEnv});
    const candidate=(await this.o.git.resolve(path,'HEAD'))!,parents=(await this.o.git.run(path,['rev-list','--parents','-n','1',candidate])).stdout.trim().split(' ');if(parents.length!==3||parents[1]!==base||parents[2]!==head)refuse('The landing did not preserve the exact contributor parents.');
    row=await this.#save({...row,candidate:{commit:candidate,at:this.#at(),method:'merge-commit',route:'land',checks:[]}});
    const files=(await this.o.git.run(path,['diff','--name-only','--no-renames','-z',`${base}..HEAD`])).stdout.split('\0').filter(Boolean),selected=selectedLandingChecks(settings,files),checks:z.infer<typeof IntakeCheckResultSchema>[]=[],projectEnv=await this.o.projectEnvironment?.(run.projectId)??{},workspace=this.o.homes.ensure('project-work',run.projectId,'intake-landing',run.id);
    const execute=async(name:string,command:string,timeoutMs:number)=>{const resources=await landingCheckEnvironment(projectEnv,settings.landingPorts);const output=await runThreadCommand(path,command,{homes:this.o.homes,workId:run.id,redactor:this.o.redactor,signal,timeoutMs,minimal:true,environmentScope:'command',projectEnv:resources.environment,gitEnv,onProcess,jobContext:{schema:'project-job-context-v1',workspace,commandCheckout:path,runId:run.id,projectId:run.projectId,jobId:run.jobId,commit:candidate}}),clean=await this.o.git.resolve(path,'HEAD')===candidate&&!(await this.o.git.run(path,['status','--porcelain=v1','--untracked-files=all'])).stdout;checks.push({name,passed:output.code===0&&!output.timedOut&&clean,at:this.#at(),exitCode:output.code,timedOut:output.timedOut,tail:this.o.redactor.text(outputTail(output,2000)||(!clean?'The check changed its worktree or commit.':'')).slice(-2000)});return clean;};
    if(run.setupCommand)await execute('Project setup',run.setupCommand,SETUP_TIMEOUT_MS);
    if(!checks.some(result=>!result.passed))for(const command of selected)if(!await execute(command.name,command.command,TEST_TIMEOUT_MS))break;
    row=await this.#save({...row,candidate:{...row.candidate!,checks}});if(!selected.length)refuse('No landing checks are configured; the candidate was not pushed.');if(checks.some(result=>!result.passed))refuse(checks.filter(result=>!result.passed).map(result=>result.name).join(', '));
    signal.throwIfAborted();await this.o.assertIntakeLanding?.(run.projectId);await assertLease();const fresh=await client.intakePull(check.repository,pull.number);if(fresh.headSha!==head||fresh.baseRef!==run.baseBranch||fresh.state!=='open'||fresh.merged)refuse('The pull request changed after its landing checks.');
    const current=await this.o.settings(run.projectId);if(current.status!=='active'||JSON.stringify([current.landingChecks,current.landingPorts,current.smokeCheck,current.setupCommand])!==JSON.stringify([settings.landingChecks,settings.landingPorts,settings.smokeCheck,settings.setupCommand]))refuse('Project checks changed before landing.');
    const latest=await this.o.git.fetchPrivate(repo,run.baseBranch,ref,signal,gitEnv);if(latest!==base){const retained=await this.#clean(run,row);if(retained)refuse('The previous candidate worktree changed and was retained.');continue;}
    row=await this.#save({...row,state:'publishing'});await this.o.assertIntakeLanding?.(run.projectId);await assertLease();
    const pushed=await this.o.git.run(path,['push','origin',`HEAD:refs/heads/${run.baseBranch}`,`--force-with-lease=refs/heads/${run.baseBranch}:${base}`],{permitted:[1],timeoutMs:GIT_NETWORK_TIMEOUT_MS,signal,env:gitEnv});
    if(pushed.code!==0){const now=await this.o.git.fetchPrivate(repo,run.baseBranch,ref,signal,gitEnv);if((await this.o.git.run(repo,['merge-base','--is-ancestor',candidate,now],{permitted:[1,128]})).code===0){const retained=await this.#clean(run,row);await this.#save({...row,state:'landed',endedAt:this.#at(),worktreeRetained:retained});return{conclusion:'passed',summary:`PR #${pull.number} landed at ${candidate.slice(0,7)}; confirmed after its push reply.`};}if(now===base)refuse('The main push was refused.');if(await this.#clean(run,row))refuse('The refused candidate worktree was retained.');continue;}
    const retained=await this.#clean(run,row);await this.#save({...row,state:'landed',endedAt:this.#at(),worktreeRetained:retained});return{conclusion:'passed',summary:`PR #${pull.number} landed at ${candidate.slice(0,7)} with the contributor commits preserved.`};
   }return this.#failed(run,row,check,'Main moved three times during landing. No further push was attempted.');
  });}catch(error){
   let recovered:Outcome|null=null;
   if(row.state==='publishing')try{recovered=await this.recover(run);}catch{/* Preserve the original failure and durable candidate below. */}
   if(recovered){if(signal.aborted&&recovered.conclusion!=='passed')throw error;return recovered;}
   const failed=await this.#failed(run,row,check,error instanceof Error?error.message:'Intake landing failed.');if(signal.aborted)throw error;return failed;
  }finally{await this.o.git.run(repo,['update-ref','-d',ref]).catch(()=>undefined);await this.o.git.run(repo,['update-ref','-d',pullRef]).catch(()=>undefined);}
 }
}
