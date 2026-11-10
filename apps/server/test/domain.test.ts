import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nameOf,parseTask,nextDate} from '../src/domain';
import {parseTimeZone} from '../src/time-zone';
test('task names reject traversal and command syntax',()=>{for(const n of ['../a','x;y','a/b','','a.json','a$(id)'])assert.throws(()=>nameOf(n));assert.equal(nameOf('daily_2'),'daily_2');});
test('JSON validation preserves unknown fields and variants',()=>{const raw='{"future":1,"tasks":[{"type":"Fight","variants":[{"params":{"new":true}}]}]}';assert.equal(parseTask(raw),raw);for(const x of ['{}','{','{"tasks":[]}','{"tasks":[{}]}'])assert.throws(()=>parseTask(x));});
test('maa-cli preset top-level fields (name/client_type/startup) pass through',()=>{const raw='{"name":"日常","client_type":"Official","startup":true,"closedown":false,"tasks":[{"name":"领取奖励","type":"Award","params":{"award":true}}]}';assert.equal(parseTask(raw),raw);});
test('daily schedule observes Tokyo midnight',()=>{assert.equal(nextDate('daily','05:10',new Date('2026-10-08T22:00:00Z'),'Asia/Tokyo').toISOString(),'2026-10-09T20:10:00.000Z');});
test('weekly/cron/interval and validation',()=>{const now=new Date('2026-10-09T00:00:00Z');assert.equal(nextDate('weekly','6 02:00',now,'Asia/Tokyo').toISOString(),'2026-10-09T17:00:00.000Z');assert.equal(nextDate('cron','10 5 * * *',now,'Asia/Tokyo').toISOString(),'2026-10-09T20:10:00.000Z');assert.equal(nextDate('interval','360',now).toISOString(),'2026-10-09T06:00:00.000Z');for(const [t,e] of [['interval','0'],['daily','25:00'],['cron','* * * * * *'],['weekly','7 02:00']])assert.throws(()=>nextDate(t,e,now));});

test('schedules follow the configured zone; invalid zones fail loudly',()=>{
  const now=new Date('2026-10-08T22:00:00Z');
  assert.equal(nextDate('daily','05:10',now,'Asia/Shanghai').toISOString(),'2026-10-09T21:10:00.000Z');
  assert.equal(nextDate('daily','05:10',now,'UTC').toISOString(),'2026-10-09T05:10:00.000Z');
  assert.equal(parseTimeZone(undefined),'Asia/Shanghai');
  assert.equal(parseTimeZone(' Europe/Berlin '),'Europe/Berlin');
  assert.throws(()=>parseTimeZone('Mars/Olympus'),/MANAGER_TIME_ZONE/);
});
