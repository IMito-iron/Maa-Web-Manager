import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRunnerStatus,dispatchLabel,taskLabel} from './runnerStatus';
test('unknown/disconnected state is not guessed as paused or enabled',()=>{
  assert.equal(dispatchLabel(null,false,false),'同步状态中…');
  assert.equal(dispatchLabel({queue:{paused:true}},false,false),'同步状态中…');
  assert.equal(dispatchLabel({queue:{paused:true}},true,true),'正在同步…');
});
test('delayed SSE cannot undo an acknowledged queue mutation',()=>{
  const paused={queue:{paused:true,observedAt:100}},resumed={queue:{paused:false,observedAt:102}};
  let state=mergeRunnerStatus(null,paused);
  state=mergeRunnerStatus(state,resumed);
  state=mergeRunnerStatus(state,{queue:{paused:true,observedAt:101}});
  assert.equal(state,resumed);
  assert.equal(dispatchLabel(state,true,false),'暂停派发');
  assert.equal(mergeRunnerStatus(state,null),state);
});

// History rows store the preset's file id; the console must name it the way its configuration does.
test('a run is labelled with the preset display name',()=>{
  const tasks=[{name:'preset-demo01',displayName:'日常'},{name:'preset-demo02',displayName:'剿灭'}];
  assert.equal(taskLabel('preset-demo01',tasks),'日常');
  assert.equal(taskLabel('preset-demo02',tasks),'剿灭');
  // A preset that has since been removed still shows something recognisable, never an empty cell.
  assert.equal(taskLabel('preset-gone',tasks),'preset-gone');
  assert.equal(taskLabel('preset-demo01',[]),'preset-demo01');
  assert.equal(taskLabel('preset-demo01',undefined as any),'preset-demo01');
  assert.equal(taskLabel('',tasks),'—');
});
