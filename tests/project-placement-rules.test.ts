import {afterEach,expect,test} from 'vitest';
import {projectFixture,type ProjectFixture} from './helpers/project-fixture.js';
let f:ProjectFixture|undefined;afterEach(async()=>{await f?.close();f=undefined;});
test('project placement effort rules beat a more specific global conflict',async()=>{
 f=await projectFixture();const c=f.app.ownerJev;await c.saveRule('project',{scope:'project',when:{},set:{minEffort:'high'}});await c.saveRule('project',{scope:'global',when:{taskType:'fix',keywords:['parser']},set:{maxEffort:'low'}});expect(c.ruleEffort('project','medium',{taskType:'fix',text:'Fix parser'}).effort).toBe('high');
});
test('an equally specific effort conflict retains the higher floor',async()=>{
 f=await projectFixture();const c=f.app.ownerJev;await c.saveRule('project',{when:{taskType:'fix'},set:{minEffort:'high'}});await c.saveRule('project',{when:{taskType:'fix'},set:{maxEffort:'low'}});expect(c.ruleEffort('project','medium',{taskType:'fix',text:'Fix parser'}).effort).toBe('high');
});
test('normal rule_set refuses an account that does not exist before saving a rule',async()=>{
 f=await projectFixture();const result=await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'bridge:project',args:{action:'rule_set',set:{account:'missing-account'},note:'Fixture invalid account.'}});expect(result).toMatchObject({ok:false,error:{code:'invalid_rule'}});expect(f.app.ownerJev.rules('project')).toEqual([]);
});
test('normal rule_set refuses a model that does not exist before saving a rule',async()=>{
 f=await projectFixture();const result=await f.app.ownerTools.call('jev',{schema:'owner-tool-request-v1',caller:'bridge:project',args:{action:'rule_set',set:{minModel:'missing-model'},note:'Fixture invalid floor.'}});expect(result).toMatchObject({ok:false,error:{code:'invalid_rule'}});expect(f.app.ownerJev.rules('project')).toEqual([]);
});
