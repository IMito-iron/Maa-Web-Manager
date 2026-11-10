import test from 'node:test';
import assert from 'node:assert/strict';
import {sanityRetryDocument,isUnlimitedDrain} from '../src/sanity';
const max=2147483647;
const fight=(name:string,times:any,stage='')=>({name,type:'Fight',params:{stage,times,medicine:0,stone:0}});
test('A10 mixed tasks retry only unlimited last Fight, preserving input and context',()=>{
 const unlimited=fight('unlimited',max),finite=fight('finite',1),explicit=fight('explicit',100,'1-7');
 const doc={startup:true,closedown:true,client_type:'Official',tasks:[finite,explicit,unlimited,{type:'Award',params:{}}]},before=JSON.stringify(doc),out=sanityRetryDocument(doc,'LS-6');
 assert.deepEqual(out.tasks.map((t:any)=>t.name),['unlimited']);assert.equal(out.tasks[0].params.stage,'LS-6');
 assert.equal(out.startup,false);assert.equal(out.closedown,false);assert.equal(out.client_type,'Official');assert.equal(JSON.stringify(doc),before);
 assert.equal(sanityRetryDocument({...doc,tasks:[unlimited,finite,explicit]},'LS-6'),null);
});
test('A10 finite, disabled, conditional, resource-budget and drop-goal tasks never auto-repeat',()=>{
 const unlimited=fight('unlimited',max);
 for(const tasks of [[fight('finite',1)],[fight('finite100',100)],[fight('finite200',200)],[{type:'Award',params:{}}],[{...unlimited,enabled:false}],[{...unlimited,params:{...unlimited.params,enable:false}}],[{...unlimited,params:{...unlimited.params,enable:'false'}}],[{...unlimited,variants:[{params:{times:1}}]}],[{...unlimited,condition:{type:'Time'}}],[fight('named',max,'CE-6')],[{type:'Fight',params:{}}], ...['medicine','stone','expiring_medicine','medicine_expire_days'].flatMap(key=>[1,-1,null,'0'].map(value=>[{...unlimited,params:{...unlimited.params,[key]:value}}])),[{...unlimited,params:{...unlimited.params,drops:{'3001':1}}}]]) assert.equal(sanityRetryDocument({tasks},'LS-6'),null,JSON.stringify(tasks));
 for(const times of [100,200,'2147483647',undefined,null,Infinity])assert.equal(isUnlimitedDrain(fight('bad',times)),false);
});
test('A10 ambiguous multiple drains, changed order or invalid fallback stop safely',()=>{
 const one=fight('one',max),two=fight('two',max);
 assert.equal(sanityRetryDocument({tasks:[one,two]},'YW-7'),null);
 assert.equal(sanityRetryDocument({tasks:[one]},''),null);
 assert.equal(sanityRetryDocument({tasks:[one]},'../stage'),null);
 assert.equal(sanityRetryDocument({tasks:[one,fight('later',1,'CE-6')]},'LS-6'),null);
 assert.equal(sanityRetryDocument({tasks:[fight('earlier',1,'CE-6'),one]},'LS-6').tasks[0].name,'one');
});
