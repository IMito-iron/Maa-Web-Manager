import {test} from 'node:test';
import assert from 'node:assert/strict';
import {basicFields, duplicateTask, fieldEditable, runBlock, setTaskEnabled, startupNotices, switchesAccount, taskDisabled, validateEditorRaw} from './taskEditor';
import {getTaskType, parsePreset, serializePreset, type PresetDoc} from './taskSchema';
import {reorder} from './reorder';

function preset(variants?: unknown): PresetDoc {
  return {name:'shared',client_type:'Official',startup:false,closedown:false,future:{x:1},tasks:[{name:'fight',type:'Fight',params:{stage:'1-7',times:3,medicine_expire_days:2,expiring_medicine:4,unknown:{a:[1,null]}},...(variants === undefined ? {} : {variants})}]};
}

// Interpret only the native logical conditions used by our toggle, without a game/Core process.
function condition(v: any): boolean {
  if (!v || v.type === 'Always') return true;
  if (v.type === 'Not') return !condition(v.condition);
  if (v.type === 'And') return v.conditions.every(condition);
  if (v.type === 'Or') return v.conditions.some(condition);
  throw new Error('out of scope');
}

for (const variants of [undefined, [], [{params:{stage:'CE-6'}}], [{condition:{type:'Always'},params:{medicine:1},future:42},{condition:{type:'Or',conditions:[]},params:{stage:'LS-6'}}]]) {
  test(`disable persists without executing a variant and enabling restores original: ${JSON.stringify(variants)}`,()=>{
    const doc=preset(variants), before=structuredClone(doc);
    const disabled=setTaskEnabled(doc,0,false);
    assert.equal(taskDisabled(disabled.tasks[0]),true);
    assert.equal((disabled.tasks[0].variants as any[]).some(v=>condition(v.condition)),false);
    const loaded=parsePreset(serializePreset(disabled));
    assert.equal(taskDisabled(loaded.tasks[0]),true);
    assert.deepEqual(setTaskEnabled(loaded,0,true),before);
    assert.deepEqual(doc,before);
    assert.deepEqual(disabled.tasks[0].params,doc.tasks[0].params);
  });
}

test('conditional variants, strategies and unknown JSON remain intact through toggle and sorting',()=>{
  const doc=preset([{condition:{type:'Weekday',weekdays:['Mon']},params:{stage:{default:'1-7'}}}]);
  doc.tasks[0].strategy='merge'; doc.tasks[0].future={nested:['x']};
  const disabled=setTaskEnabled(doc,0,false), copy=duplicateTask(disabled,0);
  assert.deepEqual(setTaskEnabled(disabled,0,true),doc);
  const moved=reorder(copy.tasks,0,1,0);
  assert.equal(moved.items[1],copy.tasks[0]); assert.equal(moved.selected,1);
  copy.tasks[1].params.unknown='copy edit';
  assert.deepEqual(copy.tasks[0].params.unknown,{a:[1,null]});
  assert.equal(taskDisabled(copy.tasks[1]),true);
});

test('StartUp can be disabled and re-enabled losslessly; CloseDown keeps its implicit-task guard',()=>{
  // StartUp is optional now. Disabling must not delete it, must keep every parameter and the
  // preset-level flags untouched, and must use the native condition mechanism only.
  const doc=preset(); doc.tasks[0]={name:'account',type:'StartUp',params:{account_name:'remembered',client_type:'YoStarJP',start_game_enabled:true,enable:true,future:42},future:{keep:[null,1]},strategy:'merge'};
  const before=structuredClone(doc);
  const disabled=setTaskEnabled(doc,0,false);
  assert.equal(taskDisabled(disabled.tasks[0]),true);
  assert.equal(disabled.startup,doc.startup,'preset-level startup flag is not rewritten by the UI');
  assert.deepEqual(disabled.tasks[0].params,before.tasks[0].params);
  assert.deepEqual(disabled.tasks[0].future,before.tasks[0].future);
  assert.equal(disabled.tasks[0].strategy,'merge');
  const loaded=parsePreset(serializePreset(disabled));
  assert.equal(taskDisabled(loaded.tasks[0]),true);
  assert.deepEqual(setTaskEnabled(loaded,0,true),before);
  assert.deepEqual(doc,before);
  // The backend contract for an account StartUp: must be enabled to be allowed to run.
  assert.equal(switchesAccount(loaded.tasks[0]),true);
  assert.ok(startupNotices(loaded,loaded.tasks[0]).some(text=>/后端/.test(text)),'disabled account StartUp explains the backend rejection');
  // CloseDown still refuses to be disabled while the preset would append an implicit CloseDown.
  const close={...preset(),closedown:true}; close.tasks[0].type='CloseDown';
  assert.throws(()=>setTaskEnabled(close,0,false),/CLI/);
});

test('account policy notices distinguish strict fail-closed from the explicit compatibility mode',()=>{
  const doc=preset(); doc.tasks[0]={name:'account',type:'StartUp',params:{account_name:'remembered'}};
  const strict=startupNotices(doc,doc.tasks[0]);
  const compat=startupNotices(doc,doc.tasks[0],'warn-continue');
  assert.ok(strict.some(text=>/fail-closed/.test(text)),JSON.stringify(strict));
  assert.ok(compat.some(text=>/兼容模式/.test(text)&&/风险/.test(text)),JSON.stringify(compat));
  assert.ok(compat.every(text=>!/fail-closed/.test(text)),JSON.stringify(compat));
  // Disabled StartUp keeps its own contract and still explains the backend rejection.
  const disabled=setTaskEnabled(doc,0,false);
  const notices=startupNotices(disabled,disabled.tasks[0],'warn-continue');
  assert.ok(notices.some(text=>/后端/.test(text)),JSON.stringify(notices));
});

test('ordinary tasks keep their existing enable/disable behaviour',()=>{
  const doc=preset();
  const disabled=setTaskEnabled(doc,0,false);
  assert.equal(taskDisabled(disabled.tasks[0]),true);
  assert.deepEqual(setTaskEnabled(disabled,0,true),doc);
  assert.deepEqual(startupNotices(doc,doc.tasks[0]),[]);
});

test('existing native enable=false is shown as disabled and explicit re-enable affects only that parameter',()=>{
  const doc=preset(); doc.tasks[0].params.enable=false;
  assert.equal(taskDisabled(doc.tasks[0]),true);
  assert.deepEqual(setTaskEnabled(doc,0,true).tasks[0].params,{...doc.tasks[0].params,enable:true});
});

test('explicit false startup and closedown survive saving; absent flags remain absent',()=>{
  for(const flags of [{}, {startup:false,closedown:false}, {startup:true,closedown:true}]){
    const raw={tasks:[{name:'a',type:'Award',params:{}}],...flags};
    const result=JSON.parse(serializePreset(parsePreset(JSON.stringify(raw))));
    for(const key of ['startup','closedown']) assert.equal(Object.hasOwn(result,key),Object.hasOwn(flags,key));
    assert.deepEqual(result.tasks,raw.tasks);
    for(const [key,value] of Object.entries(flags)) assert.equal(result[key],value);
  }
});

test('templates, nulls and wrongly typed known values stay read-only; all fields remain assigned a section',()=>{
  const type=getTaskType('Fight')!;
  for(const field of type.fields){
    assert.equal(fieldEditable(field,{default:1}),false);
    assert.equal(fieldEditable(field,null),false);
    assert.equal(fieldEditable(field,undefined),true);
  }
  assert.equal(basicFields('Fight',type.fields).some(f=>f.key==='stage'),true);
  assert.equal(basicFields('Fight',type.fields).some(f=>f.key==='medicine_expire_days'),true);
});

test('invalid rows and params are rejected before they can be dropped by visual normalization',()=>{
  for(const raw of ['{','{}','{"tasks":[]}','{"tasks":[{"type":""}]}','{"tasks":[null]}','{"tasks":[{"type":"Fight","params":[]}]}']) assert.throws(()=>validateEditorRaw(raw));
  assert.doesNotThrow(()=>validateEditorRaw(JSON.stringify(preset())));
  assert.doesNotThrow(()=>validateEditorRaw('{"tasks":[{"type":"FutureTask","params":{"future":null},"unknown":42}]}'));
});

test('execution stays unavailable with paused, blocked, stale, pending or unready device state',()=>{
  const ready={queue:{paused:false,blocked:false},android:true,adb:true,maa:true};
  assert.equal(runBlock(ready,true,false),'');
  for(const [status,fresh,pending] of [[null,true,false],[ready,false,false],[ready,true,true],[{...ready,queue:{paused:true}},true,false],[{...ready,queue:{blocked:true}},true,false],[{...ready,adb:false},true,false],[{...ready,maa:false},true,false]] as const) assert.notEqual(runBlock(status,fresh,pending),'');
});
