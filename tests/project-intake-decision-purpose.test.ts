import {test,expect} from 'vitest';
import {ProjectDecisionSchema} from '../packages/core/dist/index.js';
import {DecisionItems} from '../packages/projects/dist/index.js';
const mixed={schema:'project-decision-v1' as const,id:'decision_mixed',projectId:'project',revision:1,from:'coordinator' as const,createdAt:'2026-10-22T12:00:00.000Z',question:'Fixture decision',options:[{label:'Deploy abcdef0'}],deploy:{deployId:'deploy_fixture',action:'approve' as const},intake:{checkId:'check',runId:'run',number:1,head:'a'.repeat(40)}};
test('intake metadata cannot share an existing deploy decision purpose',()=>{
 expect(ProjectDecisionSchema.safeParse(mixed).success).toBe(false);expect(ProjectDecisionSchema.safeParse({...mixed,deploy:undefined}).success).toBe(true);
});
test('intake dispatch preserves the existing deploy owner-chat refusal',async()=>{
 let intakeCalls=0;const service=new DecisionItems({hub:{decision:async()=>({revision:1,document:mixed}),decisions:async()=>[],createDecision:async()=>{throw Error('Unexpected create.');},withdrawDecision:async()=>{throw Error('Unexpected withdrawal.');},answerDecision:async()=>{throw Error('Unexpected ordinary answer.');}},threads:()=>({allowTurns:async()=>{},stop:async()=>{},message:async()=>{}}),toCoordinator:async()=>{},intakeAnswer:async()=>{intakeCalls++;return{repeated:false,closed:true};},deployAnswer:async()=>{throw Error('Should refuse owner chat before the deploy handler.');}});
 await expect(service.answerChat('project',mixed.id,{clientRequestId:'mixed_chat',optionLabel:'Deploy abcdef0'},'Fixture owner message.')).rejects.toThrow(/owner.*deploy|deploy.*message/iu);expect(intakeCalls).toBe(0);
});
