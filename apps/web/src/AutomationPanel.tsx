import React,{useEffect,useState} from 'react';
import {api} from './api';
import {serverTimeZone} from './timeZone';

const date=(value:string)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:serverTimeZone()}):'—';
export default function AutomationPanel({tasks}:{tasks:any[]}) {
  const [runs,setRuns]=useState<any[]>([]),[queue,setQueue]=useState<any>(),[schedules,setSchedules]=useState<any[]>([]);
  const [page,setPage]=useState(1),[error,setError]=useState(''),[selected,setSelected]=useState(''),[logs,setLogs]=useState('');
  const empty={name:'',taskId:'',type:'daily',expression:'06:00',enabled:true};
  const [schedule,setSchedule]=useState<any>(empty);
  const refresh=async()=>{const [r,q,s]=await Promise.all([api(`my/runs?page=${page}`),api('my/queue'),api('my/schedules')]);setRuns(r);setQueue(q);setSchedules(s);};
  const act=async(fn:()=>Promise<unknown>)=>{try{setError('');await fn();await refresh();}catch(e:any){setError(e.message);}};
  useEffect(()=>{let cancelled=false,busy=false;const load=async()=>{if(busy||cancelled)return;busy=true;try{await refresh();}catch(e:any){if(!cancelled)setError(e.message);}finally{busy=false;}};void load();const timer=setInterval(()=>void load(),3000);return()=>{cancelled=true;clearInterval(timer);};},[page]);
  useEffect(()=>{
    setLogs('');if(!selected)return;
    const decoder=new TextDecoder(),source=new EventSource(`/api/my/runs/${selected}/events`);
    source.addEventListener('log',event=>{const {base64}=JSON.parse((event as MessageEvent).data);const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const text=decoder.decode(bytes,{stream:true});setLogs(old=>(old+text).slice(-200000));});
    return()=>source.close();
  },[selected]);
  return <>
    {error&&<p role="alert" className="alert">{error}</p>}
    <section className="panel"><h2>我的执行队列</h2><p className="notice">已支持持久排队与取消。账号切换验收尚未完成，排队任务不会操作手机。</p>
      {queue?.items.map((run:any)=><div className="row" key={run.id}><span>{run.taskName} · {run.status}{run.cancelRequested?' · 正在取消':''}</span><button disabled={run.cancelRequested} onClick={()=>void act(()=>api(`my/runs/${run.id}/stop`,'POST',{}))}>取消 / 停止</button></div>)}
    </section>
    <div className="editor-grid"><form className="panel" onSubmit={event=>{event.preventDefault();void act(async()=>{await api(schedule.id?`my/schedules/${schedule.id}`:'my/schedules',schedule.id?'PUT':'POST',schedule);setSchedule(empty);});}}>
      <h2>{schedule.id?'编辑':'新建'}调度 · {serverTimeZone()}</h2><label>名称<input required value={schedule.name} onChange={e=>setSchedule({...schedule,name:e.target.value})}/></label>
      <label>任务<select required value={schedule.taskId} onChange={e=>setSchedule({...schedule,taskId:e.target.value})}><option value="">请选择</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label>类型<select value={schedule.type} onChange={e=>setSchedule({...schedule,type:e.target.value,expression:({daily:'06:00',weekly:'0,6 06:00',interval:'360',cron:'0 6 * * *'} as any)[e.target.value]})}>{['daily','weekly','interval','cron'].map(t=><option key={t}>{t}</option>)}</select></label>
      <label>规则<input required value={schedule.expression} onChange={e=>setSchedule({...schedule,expression:e.target.value})}/></label><p>最小间隔 10 分钟，停机或暂停期间不补跑。</p><button>保存</button><button type="button" onClick={()=>setSchedule(empty)}>重置</button>
    </form><section className="panel"><h2>我的调度</h2>{schedules.map(s=><div className="schedule" key={s.id}><strong>{s.name}</strong><p>{s.type} · {s.expression} · {s.enabled?date(s.nextAt):'已禁用'}</p><button onClick={()=>setSchedule(s)}>编辑</button><button onClick={()=>void act(()=>api(`my/schedules/${s.id}`,'PUT',{...s,enabled:!s.enabled}))}>{s.enabled?'禁用':'启用'}</button><button onClick={()=>void act(()=>api(`my/schedules/${s.id}`,'DELETE',{}))}>删除</button></div>)}</section></div>
    <section className="panel"><h2>我的运行历史</h2>{runs.map(r=><div className="row" key={r.id}><span>{r.taskName} · {r.status} · {date(r.createdAt)}<small>{r.reason}</small></span><button onClick={()=>setSelected(r.id)}>日志</button></div>)}<button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span> {page} </span><button disabled={runs.length<30} onClick={()=>setPage(page+1)}>下一页</button></section>
    {selected&&<section className="panel log-panel"><h2>任务日志</h2><button onClick={()=>setSelected('')}>关闭</button><pre>{logs||'尚无日志；任务可能仍在等待验收与派发。'}</pre></section>}
  </>;
}
