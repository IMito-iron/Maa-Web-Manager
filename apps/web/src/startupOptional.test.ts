import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {act, create, type ReactTestRenderer, type ReactTestInstance} from 'react-test-renderer';
import TaskConfig from './TaskConfig';
import {I18nProvider} from './I18nContext';

// StartUp is optional in R2. This exercises the real UI -> saved JSON path (not just the pure
// reducer): the toggle must be clickable, the saved document must keep the preset-level `startup`
// flag and every StartUp parameter, and re-enabling must restore the original document exactly.
const original = {name:'Daily', client_type:'Official', startup:true, closedown:false, future:{keep:[null,7]}, tasks:[
  {name:'start', type:'StartUp', params:{account_name:'remembered', client_type:'YoStarJP', start_game_enabled:true, enable:true, future:{nested:true}}},
  {name:'fight', type:'Fight', params:{stage:'1-7', times:3, medicine_expire_days:0}},
]};

const text = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.children.map(text).join('');
const flush = () => new Promise<void>(resolve=>setImmediate(resolve));

async function harness() {
  const listeners = new Set<(event:any)=>void>();
  const oldWindow = globalThis.window, oldFetch=globalThis.fetch, oldDocument=globalThis.document;
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'), oldLocalStorage=(globalThis as any).localStorage;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  (globalThis as any).window={addEventListener:(_type:string,fn:any)=>listeners.add(fn),removeEventListener:(_type:string,fn:any)=>listeners.delete(fn)};
  (globalThis as any).document={documentElement:{lang:''}};
  Object.defineProperty(globalThis,'navigator',{value:{languages:['zh-CN'],language:'zh-CN'},configurable:true,writable:true});
  (globalThis as any).localStorage={getItem:()=>null,setItem:()=>{}};
  const requests: {url:string;method:string;body:any}[]=[];
  let version='version-1';
  globalThis.fetch=async (input,init)=>{
    const url=String(input),method=init?.method || 'GET',body=init?.body ? JSON.parse(String(init.body)):undefined;
    requests.push({url,method,body});
    if(method==='GET') return new Response(JSON.stringify({name:'daily',version,raw:JSON.stringify(original)}));
    version='version-2';
    return new Response(JSON.stringify({name:'daily',version,raw:body.raw}));
  };
  let view!:ReactTestRenderer;
  await act(async()=>{view=create(React.createElement(I18nProvider,{children:React.createElement(TaskConfig,{tasks:[{name:'daily',displayName:'Daily',editable:true}],reloadTasks:async()=>{},submit:async()=>{},runDisabledReason:'',deviceLabel:'Fake device'})}));});
  const node=(type:string,predicate:(n:ReactTestInstance)=>boolean)=>view.root.findAllByType(type as any).find(predicate)!;
  const button=(label:string)=>node('button',n=>text(n)===label);
  const click=async(label:string)=>{await act(async()=>{button(label).props.onClick();await flush();});};
  const open=async()=>{await act(async()=>{node('select',n=>n.props['aria-label']==='当前预设').props.onChange({target:{value:'daily'}});await flush();});};
  const toggle=async(name:string,checked:boolean)=>{await act(async()=>{node('input',n=>n.props['aria-label']==='启用任务 '+name).props.onChange({target:{checked}});await flush();});};
  const enableBox=(name:string)=>node('input',n=>n.props['aria-label']==='启用任务 '+name);
  const save=async()=>{await act(async()=>{button('保存').props.onClick();await flush();await flush();});};
  return {requests,view,node,button,click,open,toggle,enableBox,save,listeners,
    close:async()=>{await act(async()=>view.unmount());globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).document=oldDocument;(globalThis as any).localStorage=oldLocalStorage;if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete (globalThis as any).navigator;}};
}

test('StartUp toggle is not locked and the saved JSON keeps every StartUp field',async()=>{
  const h=await harness();try{
    await h.open();
    assert.equal(h.enableBox('start').props.checked,true);
    assert.notEqual(h.enableBox('start').props.disabled,true,'StartUp (with account_name) must be toggleable');
    await h.toggle('start',false);
    assert.equal(h.enableBox('start').props.checked,false);
    await h.save();
    const put=h.requests.find(r=>r.method==='PUT')!;
    assert.ok(put,'saving the disabled StartUp reaches the API');
    const saved=JSON.parse(put.body.raw);
    assert.equal(saved.startup,true,'preset-level startup flag is not rewritten by the UI');
    assert.equal(saved.tasks[0].type,'StartUp');
    assert.deepEqual(saved.tasks[0].params,original.tasks[0].params,'all StartUp parameters survive');
    assert.equal(saved.tasks[0].variants.length,1);
    assert.equal(saved.tasks[0].variants[0].condition.type,'Not');
    assert.deepEqual(saved.tasks[1],original.tasks[1]);
    assert.deepEqual(saved.future,original.future);
    // Re-enable and save again: the serialized document must be byte-identical to the original.
    await h.toggle('start',true);
    await h.save();
    const next=h.requests.filter(r=>r.method==='PUT').at(-1)!;
    assert.deepEqual(JSON.parse(next.body.raw),original);
  }finally{await h.close();}
});
