import test from 'node:test';
import assert from 'node:assert/strict';
import {format} from './i18n';
import {composeExpression, describeSchedule, emptyFields, fieldsFor, splitExpression} from './schedule';

test('every type composes exactly the wire format the server validates',()=>{
  const fields={...emptyFields(),minutes:90,time:'06:30',weekdays:[5,1,1,3],cron:['0','6','*','*','1']};
  assert.equal(composeExpression('interval',fields),'90');
  assert.equal(composeExpression('daily',fields),'06:30');
  assert.equal(composeExpression('weekly',fields),'1,3,5 06:30');
  assert.equal(composeExpression('cron',fields),'0 6 * * 1');
  // Out-of-range input is clamped rather than sent to the server to reject.
  assert.equal(composeExpression('interval',{...fields,minutes:0}),'1');
  assert.equal(composeExpression('interval',{...fields,minutes:1e9}),'525600');
  assert.equal(composeExpression('daily',{...fields,time:'25:99'}),'06:00');
  assert.equal(composeExpression('weekly',{...fields,weekdays:[]}),'');
  assert.equal(composeExpression('cron',{...fields,cron:['0','',null as any]}),'0 * * * *');
});

test('existing rules load into fields and round trip unchanged',()=>{
  for(const [type,expression] of [['interval','360'],['daily','18:00'],['weekly','0,6 02:00'],['cron','10 5 * * *']] as const){
    const fields=splitExpression(type,expression);
    assert.equal(composeExpression(type,fields),expression,`${type} ${expression}`);
    assert.equal(describeSchedule(type,expression, format).length>0,true);
  }
  // A rule the editor cannot interpret must not throw and must not invent a value.
  for(const junk of ['','   ','not-a-rule','1,9 99:99']){
    assert.doesNotThrow(()=>splitExpression('weekly',junk));
    assert.doesNotThrow(()=>splitExpression('cron',junk));
  }
  assert.deepEqual(splitExpression('cron','1 2 3').cron,emptyFields().cron);
  assert.equal(composeExpression('weekly',splitExpression('weekly','1,9 99:99')),'');
});

test('rules are described in words, not raw expressions',()=>{
  assert.equal(describeSchedule('interval','360', format),'每 360 分钟');
  assert.equal(describeSchedule('daily','06:00', format),'每天 06:00');
  assert.equal(describeSchedule('weekly','0,6 02:00', format),'每周日、周六 02:00');
  assert.equal(describeSchedule('cron','0 6,18 * * *', format),'Cron 0 6,18 * * *');
});

test('the editor only asks for the parts the type needs',()=>{
  assert.deepEqual(fieldsFor('interval'),{minutes:true,time:false,weekdays:false,cron:false});
  assert.deepEqual(fieldsFor('daily'),{minutes:false,time:true,weekdays:false,cron:false});
  assert.deepEqual(fieldsFor('weekly'),{minutes:false,time:true,weekdays:true,cron:false});
  assert.deepEqual(fieldsFor('cron'),{minutes:false,time:false,weekdays:false,cron:true});
});
