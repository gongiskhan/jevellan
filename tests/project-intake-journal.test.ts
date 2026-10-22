import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {Homes,JournalDocumentSchema,ProjectSchema} from '../packages/core/dist/index.js';
import {HubDatabase,HubProjectAccess} from '../packages/mesh/dist/index.js';
import {ProjectJournals,ProjectLedgers,ProjectPaths,validateJournalDocument} from '../packages/projects/dist/index.js';
const at='2026-10-22T12:00:00.000Z';
const check={schema:'intake-check-v1',id:'intake_external',projectId:'project',revision:1,deviceId:'hub',runId:'run_intake',
 pull:{schema:'intake-pull-v1',number:1,url:'https://github.com/fixture/repo/pull/1',title:'Outside improvement',body:'Contributor description.',author:'outside-contributor',headSha:'a'.repeat(40),headRef:'outside-change',baseRef:'main',state:'open',merged:false,draft:false,updatedAt:at},
 repository:{owner:'fixture',repo:'repo'},baseCommit:'b'.repeat(40),status:'checked',checks:[{name:'Changed text',passed:false,at,exitCode:7,timedOut:false,tail:'Specific failure.'}],selectedChecks:['Changed text'],worktreeRetained:false,stats:{files:1,added:2,deleted:1},decisionId:'decision_intake',error:null,startedAt:at,checkedAt:at};
const cleanup:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'jevellan-intake-journal-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'user'));const homes=new Homes(join(root,'hub'),join(root,'user'));homes.ensure();const database=new HubDatabase(homes,'hub');cleanup.push(()=>database.close());
 const project=ProjectSchema.parse({schema:'project-v1',id:'project',name:'Shop',paths:{},branchPolicy:'main',memory:{mode:'repo',dir:'.memory'},context:{state:'none'}});database.put('projects',project.id,ProjectSchema,project,0);
 // Seed the authoritative source to isolate journal capture from the separate executor contracts.
 const source=z.object({schema:z.literal('intake-check-v1'),id:z.string(),projectId:z.string(),revision:z.number()}).passthrough();database.put('project-intake',check.id,source,check,0);
 const hub=new HubProjectAccess(database,'hub'),ledgers=new ProjectLedgers(new ProjectPaths(homes),{now:()=>at}),engine=new ProjectJournals({homes,deviceId:'hub',isHub:true,ledgers,hub,projects:async()=>[project],threads:()=>[],now:()=>Date.parse(at)});cleanup.push(()=>engine.close());return{database,hub,ledgers,engine};
}
test('intake journal documents validate the complete versioned source and reject unknown fields',()=>{
 const entry={schema:'journal-document-v1',collection:'intake',key:check.id,document:check};expect(JournalDocumentSchema.safeParse(entry).success).toBe(true);expect(validateJournalDocument(entry).document).toEqual(check);expect(()=>validateJournalDocument({...entry,document:{...check,unexpected:true}})).toThrow();
});
test('intake checks enter the authoritative journal once and survive a deterministic rebuild',async()=>{
 const{engine,ledgers}=fixture();await engine.sync('project');const events=()=>ledgers.coordinator('project').events().filter(row=>row.type==='journal-document').map(row=>JournalDocumentSchema.parse(ledgers.coordinator('project').payload(row))).filter(row=>row.collection==='intake');expect(events()).toHaveLength(1);const day=join(engine.path('project'),'days/2026-10-22.md'),before=readFileSync(day,'utf8');for(const text of ['Outside improvement','Contributor description.','Specific failure.',check.pull.headSha,check.baseCommit])expect(before).toContain(text);await engine.sync('project');expect(events()).toHaveLength(1);await engine.request({schema:'project-journal-request-v1',operation:'rebuild',projectId:'project'},'hub');expect(readFileSync(day,'utf8')).toBe(before);
});
