import {expect,test} from 'vitest';
import {ProjectHubCollectionSchema,ProjectHubRequestSchema,ProjectHubResultSchema} from '../packages/core/dist/index.js';
const at='2026-10-20T10:00:00.000Z';
const document={schema:'intake-check-v1',id:'intake_fixture',projectId:'project',revision:0,deviceId:'dev_fixture',runId:'run_fixture',pull:{schema:'intake-pull-v1',number:1,url:'https://github.com/fixture/repo/pull/1',title:'Outside improvement',body:'Contributor description.',author:'outside-contributor',headSha:'a'.repeat(40),headRef:'outside-change',baseRef:'main',state:'open',merged:false,draft:false,updatedAt:at},repository:{owner:'fixture',repo:'repo'},baseCommit:'b'.repeat(40),status:'checking',checks:[],stats:null,decisionId:null,error:null,startedAt:at,checkedAt:null};
test('the intake collection is an explicit versioned hub capability',()=>{expect(ProjectHubCollectionSchema.safeParse('intake').success).toBe(true);});
test('normal hub transport receives a strict versioned intake check document',()=>{expect(ProjectHubRequestSchema.safeParse({schema:'project-hub-request-v1',operation:'intake-document-put',document,expectedRevision:0}).success).toBe(true);});
test('normal intake reads validate embedded revision and reject unknown fields',()=>{
 const result={schema:'project-hub-result-v1',operation:'intake-document-get',record:{revision:1,document:{...document,revision:1}}};expect(ProjectHubResultSchema.safeParse(result).success).toBe(true);expect(ProjectHubResultSchema.safeParse({...result,record:{...result.record,document:{...result.record.document,revision:0}}}).success).toBe(false);expect(ProjectHubRequestSchema.safeParse({schema:'project-hub-request-v1',operation:'intake-document-put',document:{...document,extra:true},expectedRevision:0}).success).toBe(false);
});
