import test from 'node:test';
import assert from 'node:assert/strict';
import {getTaskType,deserializeParams,parsePreset,serializePreset} from './taskSchema';
import {composeExpression,splitExpression,emptyFields} from './schedule';
test('A02 expiry control is days, canonical wins and legacy display has exact old semantics',()=>{
 const fields=getTaskType('Fight')!.fields;
 assert.equal(fields.some(f=>f.key==='expiring_medicine'),false);
 assert.match(fields.find(f=>f.key==='medicine_expire_days')!.label,/天/);
 for(const [params,want] of [[{},0],[{expiring_medicine:0},0],[{expiring_medicine:1},2],[{expiring_medicine:5},2],[{expiring_medicine:5,medicine_expire_days:0},0],[{expiring_medicine:0,medicine_expire_days:7},7]] as const){
  assert.equal(deserializeParams('Fight',params).form.medicine_expire_days,want);
  const raw=JSON.stringify({tasks:[{type:'Fight',params}]});
  assert.deepEqual(JSON.parse(serializePreset(parsePreset(raw))).tasks[0].params,params);
 }
});
test('A17 empty or invalid weekdays cannot invent an execution day',()=>{
 for(const weekdays of [[],[9],[-1],[1,9],[NaN]]) assert.equal(composeExpression('weekly',{...emptyFields(),weekdays}),'');
 for(const expression of ['', ' ', '06:00', '1,9 06:00', ', 06:00', '1, 06:00']) assert.equal(composeExpression('weekly',splitExpression('weekly',expression)),'',expression);
 for(const days of [[1],[0,1,2,3,4,5,6],[6,0,0]]) assert.equal(composeExpression('weekly',{...emptyFields(),weekdays:days}),[...new Set(days)].sort().join(',')+' 06:00');
});
