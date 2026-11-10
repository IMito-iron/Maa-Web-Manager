import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceControl} from '../src/control';
const a='a'.repeat(64),b='b'.repeat(64);
const IDLE=5*60_000,SESSION=30*60_000;
test('control excludes other clients and automation, tolerates a heartbeat pause, caps the session and renews',()=>{
  let time=0;const c=new DeviceControl(()=>time);
  assert.throws(()=>c.grant(a,true));assert.equal(c.held,false);
  assert.equal(c.grant(a,false).owned,true);
  assert.throws(()=>c.grant(b,false));assert.throws(()=>c.release(b));
  // A viewer who does not move the pointer for minutes keeps control; a forgotten session does not.
  time=IDLE-1000;assert.equal(c.status(a).owned,true);
  time=IDLE;assert.equal(c.status(a).owned,false);assert.equal(c.held,true);assert.throws(()=>c.touch(a));
  time+=4000;assert.equal(c.held,false);
  // Heartbeats keep an attended session alive, and re-requesting renews the deadline.
  c.grant(a,false);
  for(let i=0;i<28;i++){time+=30_000;c.touch(a);}
  assert.equal(c.status(a).owned,true);
  c.grant(a,false);
  for(let i=0;i<29;i++){time+=60_000;c.touch(a);}
  assert.equal(c.status(a).owned,true,'a renewed session survives heartbeats until its deadline');
  time+=120_000;assert.equal(c.status(a).owned,false,'the per-grant deadline still applies');
  assert.equal(c.held,true);time+=4000;
  c.grant(b,false);c.release(b);
  assert.equal(c.held,true);time+=4000;assert.equal(c.held,false);
  assert.equal(new DeviceControl().status(a).owned,false,'restart revokes control');
});
