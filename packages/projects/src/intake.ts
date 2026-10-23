import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {IntakeCheckSchema,IntakeJobResultSchema,IntakePullSchema,ProjectDecisionSchema,boundedRedaction,intakeBuild,intakeQuestion,parseGitHubRemote,resolveProjectPath,
 type Homes,type IntakeCheck,type IntakeJobResult,type NativeProcess,type Project,type ProjectHub,type ProjectJobRun,type ProjectWorkSettings,type SecretRedactor} from '@jevellan/core';
import {derivedId,systemWithdrawal} from './decision-items.js';
import {threadBaseRef,type ThreadGit} from './git.js';
import {selectedLandingChecks} from './landing.js';
import type {GitHubAccess} from './publication.js';
import {outputTail,runThreadCommand,SETUP_TIMEOUT_MS,TEST_TIMEOUT_MS} from './verification.js';
const fail=(message:string,status=409)=>Object.assign(Error(message),{status});
export type IntakeExecution={result:IntakeJobResult;conclusion:'passed'|'failed'|'skipped';summary:string};
/** Command jobs check outside pull requests; publication and other mutations require a later pinned owner choice. */
export class ProjectIntake{
 constructor(readonly o:{homes:Homes;hub:ProjectHub;git:ThreadGit;github:GitHubAccess;deviceId:string;deviceName:string;redactor:SecretRedactor;now():number;project(id:string):Promise<Project>;settings(id:string):Promise<ProjectWorkSettings>;projectEnvironment?(id:string):Promise<Record<string,string>>}){}
 #at(){return new Date(this.o.now()).toISOString();}
 async #save(document:IntakeCheck){const saved=(await this.o.hub.putIntakeDocument(IntakeCheckSchema.parse(boundedRedaction(this.o.redactor,document)),document.revision)).document;if(saved.schema!=='intake-check-v1')throw Error('The intake check receipt changed type.');return saved;}
 async #item(check:IntakeCheck){
  if(check.status!=='checked'||!check.decisionId)return;
  const existing=(await this.o.hub.decision(check.decisionId))?.document;
  if(!existing){
   const document=ProjectDecisionSchema.parse({schema:'project-decision-v1',id:check.decisionId,projectId:check.projectId,revision:0,from:'coordinator',createdAt:check.checkedAt!,question:intakeQuestion(check),options:['merge','redo','close','later'].map(label=>({label})),intake:{checkId:check.id,runId:check.runId,number:check.pull.number,head:check.pull.headSha}});
   try{await this.o.hub.createDecision(document);}catch(error){if((error as {status?:number}).status!==409||!(await this.o.hub.decision(document.id)))throw error;}
  }
  // A newly checked head replaces the old open owner item; an answer is never erased.
  for(const old of await this.o.hub.decisions(check.projectId))if(old.id!==check.decisionId&&old.intake?.number===check.pull.number&&old.intake.head!==check.pull.headSha&&!old.answer&&!old.withdrawnAt)await this.o.hub.withdrawDecision(old.id,this.#at(),systemWithdrawal('A newer checked pull-request head replaced this owner item.'));
 }
 async check(run:ProjectJobRun,signal:AbortSignal,onProcess:(process:NativeProcess)=>void):Promise<IntakeExecution>{
  if(run.deviceId!==this.o.deviceId||run.spec.kind!=='command'||!run.spec.intake)throw fail('This is not the executing intake job.',403);
  const intake=run.spec.intake,project=await this.o.project(run.projectId),repo=resolveProjectPath(project,this.o.deviceId,this.o.deviceName),remote=await this.o.git.remoteUrl(repo),repository=remote&&parseGitHubRemote(remote);
  if(!remote||!repository)throw fail('Intake needs the registered GitHub repository.');
  const configured=project.remoteUrl&&parseGitHubRemote(project.remoteUrl);if(configured&&(configured.owner.toLowerCase()!==repository.owner.toLowerCase()||configured.repo.toLowerCase()!==repository.repo.toLowerCase()))throw fail('The registered GitHub remote changed.');
  const token=await this.o.github.token(project.id);if(!token)throw fail('No GitHub token is saved for this project.');this.o.redactor.add(token);
  const client=this.o.github.client(token),authors=intake.authors,owner=authors===null?await(await this.o.github.open()).viewer():null,allowed=authors&&new Set(authors.map(author=>author.toLowerCase()));
  const pulls=(await client.intakePulls(repository)).filter(pull=>pull.state==='open'&&!pull.merged&&(allowed?allowed.has(pull.author.toLowerCase()):pull.author.toLowerCase()!==owner!.toLowerCase()));
  const result:IntakeJobResult={schema:'intake-job-result-v1',pulls:[],skipped:0,errors:[]},gitEnv=await this.o.github.turnGitEnvironment(project.id,remote);
  for(const raw of pulls){
   signal.throwIfAborted();const pull=IntakePullSchema.parse(boundedRedaction(this.o.redactor,raw)),id=derivedId('intake',project.id,repository.owner.toLowerCase(),repository.repo.toLowerCase(),String(pull.number),pull.headSha),stored=(await this.o.hub.intakeDocument(id))?.document,previous=stored?.schema==='intake-check-v1'?stored:undefined;
   if(previous?.status==='checked'){await this.#item(previous);result.skipped++;continue;}
   if(previous&&previous.runId!==run.id&&!(await this.o.hub.jobRun(previous.runId))?.document.conclusion){result.skipped++;continue;}
   const baseRef=threadBaseRef(id),pullRef=`refs/jevellan/threads/${id}/pull-head`;let check:IntakeCheck|undefined,added=false,retained=false;const directory=this.o.homes.ensure('worktrees',project.id,'intake'),path=join(directory,derivedId('check',id,run.id)),workspace=this.o.homes.ensure('project-work',project.id,'intake',id,run.id);
   try{
    const base=await this.o.git.fetchPrivate(repo,pull.baseRef,baseRef,signal,gitEnv);
    check=await this.#save(IntakeCheckSchema.parse({schema:'intake-check-v1',id,projectId:project.id,revision:previous?.revision??0,deviceId:this.o.deviceId,runId:run.id,pull,repository,baseCommit:base,status:'checking',checks:[],selectedChecks:[],stats:null,decisionId:null,error:null,startedAt:this.#at(),checkedAt:null}));
    const head=await this.o.git.fetchPullHead(repo,pull.number,pullRef,signal,gitEnv);if(head!==pull.headSha)throw fail('The pull request head changed before its check.');
    if(existsSync(path))throw fail('A leftover intake worktree needs attention before retry.');
    await this.o.git.run(repo,['worktree','add','--detach',path,head],{signal});added=true;
    const files=(await this.o.git.run(path,['diff','--name-only','--no-renames','-z',`${base}...HEAD`],{signal})).stdout.split('\0').filter(Boolean),stats=(await this.o.git.run(path,['diff','--numstat','--no-renames','-z',`${base}...HEAD`],{signal})).stdout.split('\0').filter(Boolean);
    const settings=await this.o.settings(project.id),checks=selectedLandingChecks(settings,files);check={...check,selectedChecks:[...(run.setupCommand?['Project setup']:[]),...checks.map(row=>row.name)],stats:{files:files.length,added:stats.reduce((n,row)=>n+(Number(row.split('\t')[0])||0),0),deleted:stats.reduce((n,row)=>n+(Number(row.split('\t')[1])||0),0)}};
    const projectEnv=await this.o.projectEnvironment?.(project.id)??{},jobContext={schema:'project-job-context-v1' as const,workspace,commandCheckout:path,runId:run.id,projectId:project.id,jobId:run.jobId,commit:head};
    const execute=async(name:string,command:string,timeoutMs:number)=>{
     const output=await runThreadCommand(path,command,{homes:this.o.homes,workId:run.id,timeoutMs,redactor:this.o.redactor,projectEnv,gitEnv,signal,minimal:true,environmentScope:'command',jobContext,onProcess});
     const unchanged=await this.o.git.resolve(path,'HEAD')===head,clean=!(await this.o.git.run(path,['status','--porcelain=v1','--untracked-files=all'])).stdout;
     const tail=this.o.redactor.text(outputTail(output,2000)||(!unchanged||!clean?'The check changed its worktree or commit.':''));retained=retained||!unchanged||!clean;
     check!.checks.push({name,passed:output.code===0&&!output.timedOut&&unchanged&&clean,at:this.#at(),exitCode:output.code,timedOut:output.timedOut,tail:tail.slice(-2000)});return unchanged&&clean;
    };
    if(run.setupCommand){await execute('Project setup',run.setupCommand,SETUP_TIMEOUT_MS);}
    if(!check.checks.some(row=>!row.passed))for(const command of checks)if(!await execute(command.name,command.command,TEST_TIMEOUT_MS))break;
    signal.throwIfAborted();const current=await client.intakePull(repository,pull.number);if(current.headSha!==head||current.state!=='open'||current.merged)throw fail('The pull request changed while its checks ran.');
    check=await this.#save({...check,status:'checked',decisionId:derivedId('pdec',id),checkedAt:this.#at(),worktreeRetained:retained});await this.#item(check);result.pulls.push({checkId:check.id,number:pull.number,head,build:intakeBuild(check)});
   }catch(error){
    const reason=this.o.redactor.text(error instanceof Error?error.message:'Intake could not check this head.').slice(0,1200);result.errors.push({number:pull.number,reason});
    if(check&&check.status!=='checked')await this.#save({...check,status:'error',error:reason,worktreeRetained:retained}).catch(()=>undefined);
    if(signal.aborted)throw error;
   }finally{
    if(added&&!retained){const head=await this.o.git.resolve(path,'HEAD'),clean=!(await this.o.git.run(path,['status','--porcelain=v1','--untracked-files=all'])).stdout;if(head===pull.headSha&&clean)await this.o.git.run(repo,['worktree','remove',path]);}
    await this.o.git.run(repo,['update-ref','-d',baseRef]).catch(()=>undefined);await this.o.git.run(repo,['update-ref','-d',pullRef]).catch(()=>undefined);
   }
  }
  const failed=result.pulls.filter(row=>row.build==='failed').length,notRun=result.pulls.filter(row=>row.build==='not-run').length,conclusion=result.errors.length||failed?'failed':notRun||!result.pulls.length?'skipped':'passed';
  return{result:IntakeJobResultSchema.parse(result),conclusion,summary:`Intake checked ${result.pulls.length} pull request(s): ${failed} failed, ${notRun} not run; ${result.skipped} unchanged or already checking; ${result.errors.length} blocked. Waiting items require the owner's choice.`};
 }
}
