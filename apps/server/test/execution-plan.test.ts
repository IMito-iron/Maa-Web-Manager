import test from 'node:test';
import assert from 'node:assert/strict';
import {executionPlan} from '../src/execution-plan';
import {executeSequence} from '../src/sequence';
test('split startup keeps unknown values and rejects ambiguous account ordering',()=>{
  const first={type:'StartUp',params:{account_name:'remembered-user',future:42}},rest={type:'Fight',variants:[{condition:{type:'Time'},params:{stage:'1-7'}}]};
  const raw=JSON.stringify({future:{x:1},startup:true,closedown:true,tasks:[first,rest]});
  const p=executionPlan(raw);assert.equal(p.documents.length,2);assert.deepEqual(p.documents[0].tasks,[first]);assert.deepEqual(p.documents[1].tasks,[rest]);assert.equal(p.documents[0].closedown,false);assert.equal(p.documents[1].startup,false);assert.deepEqual(p.documents[1].future,{x:1});
  for(const tasks of [[rest,first],[{...first,condition:{type:'Time'}},rest],[first,first]])assert.throws(()=>executionPlan(JSON.stringify({tasks})));
  assert.equal(executionPlan(JSON.stringify({tasks:[rest]})).switching,false);
});
test('startup failure or missing completion never launches following tasks',async()=>{
  for(const script of ['process.exit(7)', 'console.log("[INFO] StartUp Stopped")']) {
    let output='';const code=await executeSequence(process.execPath,[['-e',script],['-e','console.log("SECOND")']],c=>{output+=c;});
    assert.notEqual(code,0);assert.doesNotMatch(output,/SECOND/);
  }
  // Account switching is fail-closed: "StartUp Completed" alone is not identity verification.
  let output='';assert.equal(await executeSequence(process.execPath,[['-e','console.log("[INFO] StartUp Completed")'],['-e','console.log("SECOND")']],c=>{output+=c;}),3);assert.doesNotMatch(output,/SECOND/);
  // Only a positively confirmed identity releases the remaining tasks.
  output='';assert.equal(await executeSequence(process.execPath,[['-e','console.log("[INFO] StartUp Completed")'],['-e','console.log("SECOND")']],c=>{output+=c;},
    {probe:{confirm:async()=>'confirmed'},target:{accountName:'remembered-user'}}),0);assert.match(output,/SECOND/);
});
