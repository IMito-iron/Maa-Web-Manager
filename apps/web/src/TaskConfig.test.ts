import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {act, create, type ReactTestRenderer, type ReactTestInstance} from 'react-test-renderer';
import TaskConfig from './TaskConfig';
import {I18nProvider} from './I18nContext';
import {renderToStaticMarkup} from 'react-dom/server';
import fs from 'node:fs';
import type {ReactTestRendererJSON} from 'react-test-renderer';

const original = {name:'Daily', startup:false, closedown:false, future:{keep:[null,9]},tasks:[
  {name:'fight',type:'Fight',params:{stage:'1-7',times:2,medicine_expire_days:0,expiring_medicine:4,unknown:{keep:true}},variants:[{condition:{type:'Weekday',weekdays:['Mon']},params:{stage:'CE-6'}}],future:42},
  {name:'reward',type:'Award',params:{award:true,unknown:9}},
]};
const text = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.children.map(text).join('');
const flush = () => new Promise<void>(resolve=>setImmediate(resolve));

async function harness(runDisabledReason = '') {
  const listeners = new Set<(event:any)=>void>();
  const oldWindow = globalThis.window, oldFetch=globalThis.fetch, oldDocument=globalThis.document;
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'), oldLocalStorage=(globalThis as any).localStorage;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  (globalThis as any).window={addEventListener:(_type:string,fn:any)=>listeners.add(fn),removeEventListener:(_type:string,fn:any)=>listeners.delete(fn)};
  (globalThis as any).document={documentElement:{lang:''}};
  // The host locale must not leak into the rendered console: this machine reports ja-JP through
  // Node's navigator, while the fixture strings below are the Chinese source keys.
  Object.defineProperty(globalThis,'navigator',{value:{languages:['zh-CN'],language:'zh-CN'},configurable:true,writable:true});
  (globalThis as any).localStorage={getItem:()=>null,setItem:()=>{}};
  const requests: {url:string;method:string;body:any}[]=[];
  const runs:string[]=[];
  let response: ((body:any)=>Promise<any>) | undefined;
  globalThis.fetch=async (input,init)=>{
    const url=String(input),method=init?.method || 'GET',body=init?.body ? JSON.parse(String(init.body)):undefined;
    requests.push({url,method,body});
    if(method==='GET') return new Response(JSON.stringify({name:url.endsWith('/other')?'other':'daily',version:'version-1',raw:JSON.stringify(original)}));
    if(response) return response(body);
    return new Response(JSON.stringify({name:body.name || 'daily',version:'version-2',raw:body.raw}));
  };
  let view!:ReactTestRenderer;
  await act(async()=>{view=create(React.createElement(I18nProvider,{children:React.createElement(TaskConfig,{tasks:[{name:'daily',displayName:'Daily',editable:true},{name:'other',displayName:'Other',editable:true}],reloadTasks:async()=>{},submit:async id=>{runs.push(id);},runDisabledReason,deviceLabel:'Fake device'})}));});
  const node=(type:string,predicate:(n:ReactTestInstance)=>boolean)=>view.root.findAllByType(type as any).find(predicate)!;
  const button=(label:string)=>node('button',n=>text(n)===label);
  const click=async(label:string)=>{await act(async()=>{button(label).props.onClick();await flush();});};
  const open=async(name='daily')=>{await act(async()=>{node('select',n=>n.props['aria-label']==='当前预设').props.onChange({target:{value:name}});await flush();});};
  const rename=async(value:string)=>{await act(async()=>{node('label',n=>text(n)==='任务名称').findByType('input').props.onChange({target:{value}});});};
  const json=async()=>{await click('原始 JSON');return node('textarea',n=>n.props['aria-label']==='任务 JSON');};
  return {requests,runs,view,node,button,click,open,rename,json,listeners,setResponse:(fn:typeof response)=>{response=fn;},
    close:async()=>{await act(async()=>view.unmount());globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).document=oldDocument;(globalThis as any).localStorage=oldLocalStorage;if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete (globalThis as any).navigator;}};
}

test('classic editor renders list/detail, keeps unknown data, disables and reorders persisted tasks',async()=>{
  const h=await harness();try{
    await h.open();
    assert.ok(h.node('aside',n=>n.props['aria-label']==='任务执行顺序'));
    assert.equal(h.view.root.findAllByType('input').filter(n=>n.props['aria-label']?.startsWith('启用任务')).length,2);
    await act(async()=>h.node('input',n=>n.props['aria-label']==='启用任务 fight').props.onChange({target:{checked:false}}));
    await h.click('↓');
    await h.click('保存');
    const request=h.requests.find(r=>r.method==='PUT')!;
    const saved=JSON.parse(request.body.raw);
    assert.equal(request.url,'/api/tasks/daily');assert.equal(request.body.version,'version-1');
    assert.equal(saved.tasks[0].type,'Award');assert.equal(saved.tasks[1].name,'fight');
    assert.deepEqual(saved.tasks[1].params,original.tasks[0].params);
    assert.equal(saved.tasks[1].variants[0].condition.type,'And');
    assert.deepEqual(saved.future,original.future);assert.equal(saved.startup,false);
    await h.click('运行');assert.deepEqual(h.runs,['daily']);
  }finally{await h.close();}
});

test('unsaved edits block preset switch, execution and browser unload; no automatic save',async()=>{
  const h=await harness();try{
    await h.open();await h.rename('draft');
    assert.equal(h.button('运行').props.disabled,true);
    await h.open('other');await h.click('运行');
    await new Promise(resolve=>setTimeout(resolve,850));
    assert.equal(h.requests.length,1);assert.deepEqual(h.runs,[]);
    let prevented=false;const event={preventDefault:()=>{prevented=true;},returnValue:undefined};
    h.listeners.forEach(fn=>fn(event));assert.equal(prevented,true);
    const area=await h.json();assert.equal(JSON.parse(area.props.value).tasks[0].name,'draft');
  }finally{await h.close();}
});

for(const status of [403,409,500]) test(`save failure ${status} preserves draft/version and never executes old configuration`,async()=>{
  const h=await harness();try{
    await h.open();await h.rename('draft');
    h.setResponse(async()=>new Response(JSON.stringify({message:status===409?'Version conflict':'Denied or unavailable'}),{status}));
    await h.click('保存');await h.click('运行');
    assert.deepEqual(h.runs,[]);assert.equal(h.button('运行').props.disabled,true);
    const area=await h.json();assert.equal(JSON.parse(area.props.value).tasks[0].name,'draft');
    assert.match(text(h.view.root),status===409?/Version conflict/:/Denied or unavailable/);
    h.setResponse(undefined);await h.click('保存');
    assert.equal(h.requests.filter(r=>r.method==='PUT').at(-1)!.body.version,'version-1');
  }finally{await h.close();}
});

test('rapid save/run/switch clicks serialize; no duplicate save or execution while saving',async()=>{
  const h=await harness();try{
    await h.open();await h.rename('draft');
    let finish!:(v:Response)=>void;
    h.setResponse(()=>new Promise(resolve=>{finish=resolve;}));
    const save=h.button('保存').props.onClick, run=h.button('运行').props.onClick;
    const switchPreset=h.node('select',n=>n.props['aria-label']==='当前预设').props.onChange;
    await act(async()=>{save();save();run();switchPreset({target:{value:'other'}});await flush();});
    assert.equal(h.requests.filter(r=>r.method==='PUT').length,1);assert.equal(h.requests.filter(r=>r.method==='GET').length,1);assert.deepEqual(h.runs,[]);
    const raw=h.requests.find(r=>r.method==='PUT')!.body.raw;
    await act(async()=>{finish(new Response(JSON.stringify({name:'daily',version:'version-2',raw})));await flush();});
    assert.equal(h.button('运行').props.disabled,false);
  }finally{await h.close();}
});

test('raw JSON round-trip retains templates, future fields and historical medicine without overwriting another preset',async()=>{
  const h=await harness();try{
    await h.open();const area=await h.json();
    const doc=JSON.parse(area.props.value);doc.tasks[0].params.times={default:7};doc.tasks[0].unknown={nested:[1,2]};
    await act(async()=>area.props.onChange({target:{value:JSON.stringify(doc)}}));
    await h.click('可视化');
    assert.match(text(h.view.root),/复杂值已保留/);
    await h.click('保存');
    const saved=JSON.parse(h.requests.find(r=>r.method==='PUT')!.body.raw);
    assert.deepEqual(saved.tasks[0].params.times,{default:7});assert.equal(saved.tasks[0].params.expiring_medicine,4);
    assert.deepEqual(saved.tasks[0].unknown,{nested:[1,2]});assert.equal(h.requests.some(r=>r.url.includes('other')),false);
  }finally{await h.close();}
});

test('deleting a task requires confirmation; duplication retains independent params and advanced metadata',async()=>{
  const h=await harness();try{
    await h.open();await h.click('复制任务');await h.rename('copy');
    await h.click('删除任务');await h.click('取消');
    await h.click('保存');
    let doc=JSON.parse(h.requests.filter(r=>r.method==='PUT').at(-1)!.body.raw);
    assert.equal(doc.tasks.length,3);assert.equal(doc.tasks[0].name,'fight');assert.equal(doc.tasks[1].name,'copy');
    assert.deepEqual(doc.tasks[0].variants,doc.tasks[1].variants);
    await h.click('删除任务');
    await act(async()=>{h.view.root.findAllByType('button').filter(n=>text(n)==='删除任务').at(-1)!.props.onClick();});
    await h.click('保存');doc=JSON.parse(h.requests.filter(r=>r.method==='PUT').at(-1)!.body.raw);assert.equal(doc.tasks.length,2);
  }finally{await h.close();}
});

test('paused environment has disabled run control and direct handler cannot submit',async()=>{
  const h=await harness('队列已暂停，不能运行');try{
    await h.open();assert.equal(h.button('运行').props.disabled,true);await h.click('运行');assert.deepEqual(h.runs,[]);
  }finally{await h.close();}
});

test('desktop and narrow-screen preview uses the actual rendered editor with synthetic data only',async()=>{
  const h=await harness();try{
    await h.open();
    assert.ok(h.node('div',n=>n.props.className==='classic-workbench'));
    if(process.env.MAA_UI_PREVIEW==='1') {
      const toElement=(node:ReactTestRendererJSON|string):React.ReactNode=>typeof node==='string'?node:React.createElement(node.type,node.props,...(node.children||[]).map(toElement));
      const tree=h.view.toJSON() as ReactTestRendererJSON;
      const markup=renderToStaticMarkup(toElement(tree));
      const css=fs.readFileSync(new URL('./style.css',import.meta.url),'utf8');
      fs.mkdirSync('outputs/classic-task-ui',{recursive:true});
      fs.writeFileSync('outputs/classic-task-ui/preview.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Classic task editor — synthetic preview</title><style>${css}</style><body><main>${markup}</main></body></html>`);
    }
  }finally{await h.close();}
});

test('new and cloned presets create distinct IDs instead of overwriting an existing preset',async()=>{
  const h=await harness();try{
    await h.click('新建预设');
    await act(async()=>h.node('input',n=>n.props.autoFocus).props.onChange({target:{value:'fresh'}}));
    await h.click('确定');assert.equal(h.button('运行').props.disabled,true);
    await h.click('保存');assert.equal(h.requests[0].method,'POST');assert.equal(h.requests[0].body.name,'fresh');
    await h.click('复制预设');
    await act(async()=>h.node('input',n=>n.props.autoFocus).props.onChange({target:{value:'fresh-copy'}}));
    await h.click('确定');
    assert.deepEqual(h.requests.map(r=>[r.method,r.body?.name]),[['POST','fresh'],['POST','fresh-copy']]);
    assert.equal(JSON.parse(h.requests[1].body.raw).name,'fresh-copy');
  }finally{await h.close();}
});

test('invalid raw JSON cannot be normalized or saved, while unknown task/parameter fields remain editable as JSON',async()=>{
  const h=await harness();try{
    await h.open();const area=await h.json();
    await act(async()=>area.props.onChange({target:{value:'{"tasks":[{"type":""}]}'}}));
    await h.click('可视化');await h.click('保存');assert.equal(h.requests.length,1);
    const unknown={name:'Daily',future:{flag:false},tasks:[{type:'FutureTask',name:'future',params:{future:[null,{x:1}]},extension:{x:3}}]};
    await act(async()=>h.node('textarea',()=>true).props.onChange({target:{value:JSON.stringify(unknown)}}));
    await h.click('可视化');assert.match(text(h.view.root),/暂不支持可视化编辑/);
    await h.click('保存');assert.deepEqual(JSON.parse(h.requests.at(-1)!.body.raw),unknown);
  }finally{await h.close();}
});
