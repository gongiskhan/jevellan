import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Homes,IntakeCheckSchema,ProjectSchema,type IntakeDocument} from '../packages/core/dist/index.js';
import {HubDatabase,HubProjectAccess} from '../packages/mesh/dist/index.js';
let close:(()=>void)|undefined;afterEach(()=>{close?.();close=undefined;});
test('large intake source pages stay under the member transport budget and cursors return each exact record once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'jevellan-intake-page-'));mkdirSync(join(root,'user'));const homes=new Homes(join(root,'hub'),join(root,'user'));homes.ensure();const db=new HubDatabase(homes,'hub');close=()=>{db.close();rmSync(root,{recursive:true,force:true});};const project=ProjectSchema.parse({schema:'project-v1',id:'project',name:'Shop',paths:{},branchPolicy:'main',memory:{mode:'repo',dir:'.memory'},context:{state:'none'}});db.put('projects',project.id,ProjectSchema,project,0);const at='2026-10-22T12:00:00.000Z',expected=[];
 for(let n=1;n<=24;n++){const id=`intake_${String(n).padStart(3,'0')}`,doc=IntakeCheckSchema.parse({schema:'intake-check-v1',id,projectId:'project',revision:1,deviceId:'hub',runId:'run_intake',pull:{schema:'intake-pull-v1',number:n,url:`https://github.com/fixture/repo/pull/${n}`,title:'Outside improvement',body:'x'.repeat(65536),author:'contributor',headSha:n.toString(16).padStart(40,'0'),headRef:'outside-change',baseRef:'main',state:'open',merged:false,draft:false,updatedAt:at},repository:{owner:'fixture',repo:'repo'},baseCommit:'b'.repeat(40),status:'checked',checks:Array.from({length:32},(_,i)=>({name:`Check ${i}`,passed:false,at,exitCode:7,timedOut:false,tail:'y'.repeat(2000)})),selectedChecks:Array.from({length:32},(_,i)=>`Check ${i}`),worktreeRetained:false,stats:{files:1,added:1,deleted:0},decisionId:`decision_${n}`,error:null,startedAt:at,checkedAt:at});db.put('project-intake',id,IntakeCheckSchema,doc,0);expected.push(doc);}
 const hub=new HubProjectAccess(db,'hub'),seen:IntakeDocument[]=[];let after:string|undefined,pages=0;
 do{const page=await hub.intakeDocuments('project',after);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_100_000);expect(page.records.length).toBeGreaterThan(0);expect(page.next).not.toBe(after);seen.push(...page.records);after=page.next??undefined;pages++;expect(pages).toBeLessThan(25);}while(after);
 expect(pages).toBeGreaterThan(1);expect(seen).toEqual(expected);expect(new Set(seen.map(row=>row.id)).size).toBe(24);
});
