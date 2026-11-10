import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTask} from '../src/domain';
test('A02 canonical expiry must be integer days within Core signed-int range',()=>{
 for(const value of [-1,0.5,'2',null,2147483648])assert.throws(()=>parseTask(JSON.stringify({tasks:[{type:'Fight',params:{medicine_expire_days:value}}]})),/medicine_expire_days/);
 for(const value of [0,1,2,7,2147483647]){const raw=JSON.stringify({tasks:[{type:'Fight',params:{medicine_expire_days:value,expiring_medicine:5}}]});assert.equal(parseTask(raw),raw);}
 const legacy=JSON.stringify({tasks:[{type:'Fight',params:{expiring_medicine:5}}]});assert.equal(parseTask(legacy),legacy);
});

test('A02 opaque CLI expiry templates are preserved without guessing a numeric value',()=>{
 const raw=JSON.stringify({tasks:[{type:'Fight',params:{medicine_expire_days:{default:0,description:'expiry days'},expiring_medicine:5},variants:[{params:{medicine_expire_days:0}}]}]});
 assert.equal(parseTask(raw),raw);
});
