import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {useRunnerStatus} from './useRunnerStatus';

test('closed SSE recovers from a real status read without resuming the queue or duplicating requests',async t=>{
  const originalFetch=globalThis.fetch, originalSource=globalThis.EventSource;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  t.mock.timers.enable({apis:['setInterval','Date'],now:10000});
  let source:any, calls=0, down=false;
  class FakeEventSource {
    static OPEN=1;
    readyState=1;
    onerror?:()=>void;
    onopen?:()=>void;
    constructor(){source=this;}
    addEventListener(){}
    close(){this.readyState=2;}
  }
  globalThis.EventSource=FakeEventSource as any;
  globalThis.fetch=async (_url,init)=>{
    calls++;assert.equal(init?.method,'GET');
    if(down)throw Error('Local runner unavailable');
    return new Response(JSON.stringify({queue:{paused:true,blocked:false,observedAt:Date.now(),items:[]},adb:true,android:true,maa:true}));
  };
  let state!:ReturnType<typeof useRunnerStatus>,view!:ReactTestRenderer;
  function Probe(){state=useRunnerStatus();return null;}
  try {
    await act(async()=>{view=create(React.createElement(Probe));});
    assert.equal(state.fresh,true);
    await act(async()=>{source.readyState=2;source.onerror();});
    assert.equal(state.fresh,false);
    down=true;
    await act(async()=>{t.mock.timers.tick(3000);});
    assert.equal(state.fresh,false);
    down=false;
    await act(async()=>{t.mock.timers.tick(3000);});
    assert.equal(state.fresh,true);
    assert.equal(state.status.queue.paused,true);
    assert.equal(state.pending,false);
    assert.equal(calls,3,'initial read and one read per three seconds only');
  } finally {
    if(view)await act(async()=>view.unmount());
    t.mock.timers.reset();globalThis.fetch=originalFetch;globalThis.EventSource=originalSource;
  }
});
