import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deserializeParams, serializeParams, parsePreset, serializePreset, getTaskType } from './taskSchema';

test('deserialize/serialize keeps known fields and preserves unknown params', () => {
  const { form, extra } = deserializeParams('Award', { award: true, mail: false, signinevent: false });
  assert.equal(form.award, true);
  assert.equal(form.mail, false);
  assert.equal(extra.signinevent, false, 'unknown param preserved');
  const out = serializeParams('Award', form, extra);
  assert.equal(out.award, true);
  assert.equal(out.mail, false);
  assert.equal(out.signinevent, false);
});

test('omitEmpty drops empty strings and empty arrays', () => {
  const { form } = deserializeParams('Fight', {});
  const out = serializeParams('Fight', form, {});
  assert.equal(out.stage, undefined, 'empty stage omitted');
  assert.equal(out.client_type, undefined, 'empty client_type omitted');
  assert.equal(out.medicine, 0, 'number default kept');
});

test('parsePreset/serializePreset round-trips and preserves unknown top-level fields', () => {
  const raw = '{"name":"日常","client_type":"Official","startup":true,"foo":123,"tasks":[{"name":"领取奖励","type":"Award","params":{"award":true,"signinevent":false}}]}';
  const doc = parsePreset(raw);
  assert.equal(doc.name, '日常');
  assert.equal(doc.startup, true);
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].type, 'Award');
  assert.equal(doc.foo, 123, 'unknown top-level preserved');
  const out = JSON.parse(serializePreset(doc));
  assert.equal(out.name, '日常');
  assert.equal(out.foo, 123);
  assert.equal(out.tasks[0].type, 'Award');
  assert.equal(out.tasks[0].params.signinevent, false);
});

test('preserve unknown top-level field that is not a known key', () => {
  const doc = parsePreset('{"custom_flag":true,"tasks":[{"type":"Depot","params":{}}]}');
  const out = JSON.parse(serializePreset(doc));
  assert.equal(out.custom_flag, true);
  assert.equal(out.tasks[0].type, 'Depot');
});
test('preserves task variants and unknown task fields across visual edits', () => {
  const task = {type:'Fight',name:'fight',params:{times:1},variants:[{condition:{type:'Time'},params:{stage:'1-7'}}],future_flag:42};
  const doc = parsePreset(JSON.stringify({tasks:[task]}));
  doc.tasks[0].params.times = 2;
  const result = JSON.parse(serializePreset(doc)).tasks[0];
  assert.deepEqual(result.variants,task.variants);
  assert.equal(result.future_flag,42);
  assert.equal(result.params.times,2);
});

test('missing series displays actual MAA default; explicit auto zero survives save/reload',()=>{
  const missing=deserializeParams('Fight',{stage:'LS-6'});
  assert.equal(missing.form.series,1);
  const out=serializeParams('Fight',{...missing.form,series:0},missing.extra);
  assert.equal(out.series,0);
  assert.equal(deserializeParams('Fight',out).form.series,0);
});

test('client options keep six wire values, order and inherited default for each task', () => {
  for (const type of ['StartUp', 'Fight', 'CloseDown']) {
    const field = getTaskType(type)!.fields.find(f => f.key === 'client_type')!;
    assert.equal(field.default, '');
    assert.equal(field.omitEmpty, true);
    assert.deepEqual(field.options, [
      {value:'Official', label:'官方服 Official'}, {value:'Bilibili', label:'B 服 Bilibili'},
      {value:'txwy', label:'繁中服 txwy'}, {value:'YoStarEN', label:'国际服 YoStarEN'},
      {value:'YoStarJP', label:'日服 YoStarJP'}, {value:'YoStarKR', label:'韩服 YoStarKR'},
    ]);
    for (const client of ['Official', 'Bilibili', 'txwy', 'YoStarEN', 'YoStarJP', 'YoStarKR', 'future-client']) {
      const parsed = deserializeParams(type, {client_type:client, future:{keep:null}});
      assert.equal(parsed.form.client_type, client);
      const out = serializeParams(type, parsed.form, parsed.extra);
      assert.equal(out.client_type, client);
      assert.deepEqual(out.future, {keep:null});
    }
    for (const params of [{}, {client_type:''}, {client_type:null}, {client_type:undefined}]) {
      const parsed = deserializeParams(type, params);
      assert.equal('client_type' in serializeParams(type, parsed.form, parsed.extra), false);
    }
  }
});

test('preset client roundtrip matches the fixed pre-change JSON golden', () => {
  const golden = {
    future:{keep:[null, '']}, name:'synthetic', client_type:'txwy', startup:true,
    tasks:[
      {name:'start', type:'StartUp', params:{client_type:'txwy', future:null}},
      {name:'fight', type:'Fight', params:{client_type:'YoStarJP', series:0}},
      {name:'close', type:'CloseDown', params:{client_type:'YoStarKR'}},
      {name:'empty', type:'StartUp', params:{client_type:''}},
      {name:'null', type:'CloseDown', params:{client_type:null}},
      {name:'missing', type:'Fight', params:{}},
      {name:'unknown', type:'FutureTask', params:{client_type:'future-client'}, future:true},
    ],
  };
  assert.deepEqual(JSON.parse(serializePreset(parsePreset(JSON.stringify(golden)))), golden);
  for (const client of ['Official', 'Bilibili', 'txwy', 'YoStarEN', 'YoStarJP', 'YoStarKR', 'future-client', '', null, undefined]) {
    const parsed = parsePreset(JSON.stringify({client_type:client, tasks:[]}));
    assert.equal(parsed.client_type, typeof client === 'string' ? client : '');
    const out = JSON.parse(serializePreset(parsed));
    assert.deepEqual(out, client ? {client_type:client, tasks:[]} : {tasks:[]});
  }
});

test('Windows-mode tasks: gui survives parse/serialize, params are compiled, tasks carry no unknown keys', async () => {
  const {defaultGui} = await import('./maaModel');
  const doc = parsePreset('{"client_type":"Official","tasks":[{"type":"Fight","params":{"stage":"1-7"}}]}');
  assert.equal(doc.tasks[0].gui, undefined, 'legacy tasks stay raw until converted');
  doc.tasks[0].gui = {...defaultGui('Fight'), StagePlan: ['CE-6']};
  const raw = serializePreset(doc);
  const stored = JSON.parse(raw);
  assert.deepEqual(Object.keys(stored.tasks[0]).sort(), ['name', 'params', 'type']);
  assert.equal(stored.tasks[0].params.stage, 'CE-6');
  assert.equal(stored.manager.tasks[0].gui.StagePlan[0], 'CE-6');
  const back = parsePreset(raw);
  assert.equal(back.tasks[0].gui?.StagePlan[0], 'CE-6');
  assert.equal(JSON.parse(serializePreset(back)).manager.tasks[0].paramsHash, stored.manager.tasks[0].paramsHash);
  const edited = parsePreset(raw.replace('"stage": "CE-6"', '"stage": "LS-6"'));
  assert.equal(edited.tasks[0].gui, undefined);
  assert.equal(edited.tasks[0].guiStale, true);
  assert.equal('manager' in JSON.parse(serializePreset(edited)), false, 'a stale GUI section is dropped; raw params win');
});
