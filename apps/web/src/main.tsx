import React,{useState,useEffect,useRef} from 'react';
import {useI18n, LocaleSwitch, I18nProvider} from './I18nContext';
import{createRoot}from'react-dom/client';
import './style.css';
import {api} from './api';
import TaskConfig from './TaskConfig';
import {runBlock} from './taskEditor';
import AndroidPanel from './AndroidPanel';
import SchedulePanel from './SchedulePanel';
import {useRunnerStatus} from './useRunnerStatus';
import {dispatchLabel,taskLabel} from './runnerStatus';
import RunDrawer from './RunDrawer';
import {serverTimeZone} from './timeZone';
// Dates follow the browser's locale, in the scheduler's time zone reported by the server.
const date=(v:string)=>v?new Date(v).toLocaleString(undefined,{timeZone:serverTimeZone()}):'—';
function App(){
 const {t}=useI18n();
 const configBusy=useRef(false);
 const [tab,setTab]=useState('总览'),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const {status,fresh,pending,toggle}=useRunnerStatus();
 const [tasks,setTasks]=useState<any[]>([]);
 const [history,setHistory]=useState<any>({items:[],total:0}),[page,setPage]=useState(1),[schedules,setSchedules]=useState<any[]>([]);
 const [selectedRun,setSelectedRun]=useState(''),[logs,setLogs]=useState('');
 const [devices,setDevices]=useState<any[]>([]);
 const safe=async(fn:()=>Promise<any>)=>{try{setError('');await fn();}catch(e:any){setError(e.message);}};
 const reloadTasks=async()=>setTasks(await api('tasks'));
 const reloadSchedules=async()=>setSchedules(await api('schedules'));
 const reloadDevices=async()=>setDevices(await api('devices'));
 const reloadHistory=async()=>setHistory(await api(`runs?page=${page}`));
 useEffect(()=>{void safe(async()=>{await reloadTasks();await reloadSchedules();});},[]);
 useEffect(()=>{if(tab==='历史')void safe(reloadHistory);},[tab,page]);
 useEffect(()=>{if(tab==='Android')void safe(reloadDevices);},[tab]);
 const active=status?.queue?.items?.find((r:any)=>r.status==='running');
 const runId=selectedRun||active?.id;
 // The drawer reads the run that was asked for, by id, from the page that is already loaded.
 const drawerRun=(history.items as any[]).find((r:any)=>r.id===selectedRun);
 // Device truth the supervisor publishes: which USB function the phone exposes, and
 // whether the darkness strategy actually verified (a black screencap would break OCR).
 const usb=status?.deviceUsb;
 const usbLabel=!usb?'—':!usb.present?t('未枚举（数据线/供电）'):usb.adbCapable?t('已暴露 ADB 接口'):t('无 ADB 接口（{ids}）',{ids:`${Number(usb.vid??0).toString(16).padStart(4,'0')}:${Number(usb.pid??0).toString(16).padStart(4,'0')}`});
 const dark=status?.displayDark;
 // No mode yet means the mirror has not started (e.g. no device bound): nothing to report.
 const darkLabel=!dark||!dark.mode?'—':dark.mode==='none'?t('未启用'):dark.verified===false?t('{mode} · 截图变黑已降级',{mode:dark.mode}):dark.verified===true?t('{mode} · 已校验',{mode:dark.mode}):t('{mode} · 待校验',{mode:dark.mode});
 // "started" is not "rendering": scrcpy can run while producing no frames at all.
 const render=status?.displayRender;
 const renderNote=render&&render.healthy===false?t(' · 画面未出帧（已尝试恢复 {count} 次）',{count:render.recoveries}):'';
 useEffect(()=>{setLogs('');if(!runId)return;const decoder=new TextDecoder();const s=new EventSource(`/api/runs/${runId}/events`);s.addEventListener('log',e=>{const {base64}=JSON.parse((e as MessageEvent).data);const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const text=decoder.decode(bytes,{stream:true});setLogs(old=>(old+text).slice(-200000));});return()=>s.close();},[runId]);
 const submit=async(name:string,overrides?:Record<string,Record<string,boolean>>)=>{const r=await api(`tasks/${name}/run`,'POST',overrides?{overrides}:{});setSelectedRun(r.id);setNotice(r.status==='skipped'?t('已有相同任务，已跳过重复提交'):t('已加入队列'));};
 return <div className="shell"><aside><div className="brand"><span>◈</span> MAA<span className="muted"> / MANAGER</span></div><p className="eyebrow">ARKNIGHTS AUTOMATION</p><nav>{['总览','任务配置','调度','历史','Android'].map(x=><button className={tab===x?'active':''} onClick={()=>{if(tab==='任务配置'&&x!==tab&&configBusy.current){setError(t('有未保存的修改或操作进行中，请先保存成功后再继续'));return;}setTab(x);}} key={x}>{t(x)}<span>↗</span></button>)}</nav><div className="aside-foot">{t('单实例 · Docker Compose')}<br/>{serverTimeZone()} <LocaleSwitch/></div></aside>
 <main><header><div><div className="eyebrow">CONTROL ROOM / {tab==='总览'?'OVERVIEW':tab}</div><h1>{tab}</h1></div><span className="badge">{!fresh?t('同步状态中…'):status?.queue?.paused?t('派发已暂停'):t('派发已启用')}</span></header>
 {error&&<div role="alert" className="alert">{error}<button onClick={()=>setError('')}>{t('关闭')}</button></div>}{notice&&<div className="notice">{notice}</div>}
 {(tab==='总览'||tab==='Android')&&<><div className="metrics">{[['Android',status?.android],['ADB',status?.adb],['MAA',status?.maa],[t('显示服务'),status?.display]].map(([name,ok])=><div className="metric" key={String(name)}><span>{name}</span><strong className={ok?'good':'warn'}>{ok?t('● 就绪'):t('○ 未就绪')}</strong></div>)}<div className="metric"><span>{t('显示帧率')}</span><strong className={status?.displayFps!=null?'good':'warn'}>{status?.displayFps!=null?`${Math.round(status.displayFps)} fps`:'—'}</strong></div><div className="metric"><span>{t('画面尺寸')}</span><strong className={status?.displayVideo?'good':'warn'}>{status?.displayVideo?`${status.displayVideo.width}×${status.displayVideo.height}`:'—'}</strong></div><div className="metric"><span>{t('熄屏策略')}</span><strong className={dark&&dark.mode!=='none'&&dark.verified!==false?'good':'warn'}>{darkLabel}</strong></div></div>
 {tab==='Android'&&<section className="panel device-info"><div className="panel-title"><h2>{t('Android 设备')}</h2><small>{t('{transport} · 状态自动刷新',{transport:status?.deviceTransport==='tcp'?t('网络 ADB'):'USB'})}</small></div><div className="device-state"><span className="muted">{t('设备状态')}</span><strong className={status?.deviceState==='CONNECTED'?'good':'warn'}>{status?.deviceState==='CONNECTED'?t('已连接'):status?.deviceState==='DISCONNECTED'?t('未连接'):(status?.deviceState||'—')}</strong>{status?.deviceReason&&<p className="warn">{status.deviceReason}</p>}<p className="muted">{status?.deviceTransport!=='tcp'&&t('USB 组合：{usb}',{usb:usbLabel})}{status?.adbServer?.restarts!=null?t(' · adb 服务已自动重启 {count} 次',{count:status.adbServer.restarts}):''}{renderNote}</p></div><div className="device-list"><div className="panel-title"><h3>{t('ADB 设备列表')}</h3><button onClick={()=>void safe(reloadDevices)}>{t('刷新')}</button></div>{(devices||[]).length===0?<p className="muted">{t('未发现设备')}</p>:devices.map((d:any)=><div className="row" key={d.serial}><span>{d.model||d.serial}</span><strong className={d.state==='device'?'good':'warn'}>{d.state==='device'?t('已授权'):d.state}</strong><small>{d.serial}</small><small>{d.selected?t('已配置'):t('未绑定')}</small></div>)}</div>{status?.device&&<div className="device-grid">{[[t('设备型号'),status.device.model],[t('连接方式'),status.device.connectionType==='usb'?'USB':status.device.connectionType==='tcp'?t('网络 ADB'):'—'],[t('设备 Serial'),status.device.serial],[t('Android 版本'),status.device.androidVersion],['CPU ABI',status.device.abi],[t('屏幕分辨率'),status.device.resolution],[t('电池'),status.device.batteryLevel!=null?`${status.device.batteryLevel}%`:'—'],[t('充电状态'),status.device.batteryStatus],[t('电池温度'),status.device.batteryTemp!=null?`${status.device.batteryTemp}°C`:'—']].map(([k,v])=><div key={String(k)}><span className="muted">{k}</span><strong>{v||'—'}</strong></div>)}</div>}{(status?.deviceEvents||[]).length>0&&<div className="device-events"><div className="panel-title"><h3>{t('连接事件')}</h3></div>{status.deviceEvents.slice(0,10).map((e:any,i:number)=><div className="row" key={i}><span>{date(e.at)}</span><strong>{e.state}</strong>{e.reason&&<small className="reason">{e.reason}</small>}</div>)}</div>}</section>}
 <div className={tab==='Android'?'':'dashboard'}><section className="panel"><div className="panel-title"><h2>{t('执行中心')}</h2><button disabled={!fresh||pending||!status?.queue} onClick={()=>void safe(toggle)}>{dispatchLabel(status,fresh,pending)}</button></div><p className="muted">{t('暂停派发不会停止正在执行的任务。')}</p><p className="muted">{t('理智作战：优先跟随游戏「上次作战」；符合安全重试条件且未用尽理智时，用 {stage} 重试一次',{stage:status?.sanity?.stage?t('{stage}（已记住）',{stage:status.sanity.stage}):t('{stage}（兜底）',{stage:status?.sanity?.fallback??'—'})})}</p>{status?.queue?.blocked&&<p className="warn">{t('环境未就绪，队列等待连接恢复。')}</p>}<div className="current"><span className="eyebrow">CURRENT TASK</span><h2>{active?.task||t('等待任务')}</h2><p>{active?date(active.startedAt):t('从任务配置页面启动，或设置定时调度。')}</p>{active&&<button className="danger" onClick={()=>void safe(()=>api(`runs/${active.id}/stop`,'POST',{}))}>{t('停止任务')}</button>}</div><div className="panel-title"><h3>{t('待执行队列')}</h3><small>{t('{count} 项',{count:status?.queue?.items?.length||0})}</small></div>{status?.queue?.items?.map((r:any)=><div className="row" key={r.id}><span>{r.task}<small> {r.status}</small></span><button onClick={()=>void safe(()=>api(`runs/${r.id}/stop`,'POST',{}))}>{r.status==='running'?t('停止'):t('取消')}</button></div>)}<p className="muted">{t('下次调度：{next}',{next:status?.nextSchedule?`${status.nextSchedule.name} · ${date(status.nextSchedule.nextAt)}`:t('未设置')})}</p></section>
 <AndroidPanel ready={!!status?.display} canvas={status?.displayCanvas} video={status?.displayVideo} dark={status?.displayDark} windowSize={status?.displayWindow}/></div></>}
 {tab==='任务配置'&&<TaskConfig accountPolicy={status?.accountPolicy} runDisabledReason={runBlock(status,fresh,pending)} deviceLabel={status?.device?.model || status?.device?.serial || status?.deviceReason || t('设备未连接')} tasks={tasks} reloadTasks={reloadTasks} submit={submit} onBusyChange={busy=>{configBusy.current=busy;}}/>}
 {tab==='调度'&&<SchedulePanel schedules={schedules} tasks={tasks} reloadSchedules={reloadSchedules} safe={safe}/>}{tab==='历史'&&<section className="panel"><div className="panel-title"><h2>{t('运行记录')}</h2><button onClick={()=>void safe(reloadHistory)}>{t('刷新')}</button></div><div className="table-wrap"><table><thead><tr><th>{t('任务预设')}</th><th>{t('状态')}</th><th>{t('开始/创建')}</th><th>{t('来源')}</th><th>{t('日志')}</th></tr></thead><tbody>{history.items.map((r:any)=><tr key={r.id}><td title={r.task}>{taskLabel(r.task,tasks)}</td><td title={r.reason||''}>{r.status}{r.reason&&<small className="reason">{r.reason}</small>}</td><td>{date(r.startedAt||r.createdAt)}</td><td>{r.source}</td><td><button onClick={()=>setSelectedRun(r.id)}>{t('查看')}</button></td></tr>)}</tbody></table></div><div className="actions"><button disabled={page===1} onClick={()=>setPage(page-1)}>{t('上一页')}</button><span>{page} / {Math.max(1,Math.ceil(history.total/30))}</span><button disabled={page*30>=history.total} onClick={()=>setPage(page+1)}>{t('下一页')}</button></div></section>}{drawerRun&&<RunDrawer run={drawerRun} title={taskLabel(drawerRun.task,tasks)} log={logs} onClose={()=>setSelectedRun('')}/>}
 {tab==='总览'&&<section className="panel log-panel"><div className="panel-title"><h2>{t('运行日志')} <small>{runId?.slice(0,8)||t('暂无运行')}</small></h2><div>{selectedRun&&<button onClick={()=>setSelectedRun('')}>{t('跟随当前任务')}</button>}{runId&&<a href={`/api/runs/${runId}/log`} target="_blank" rel="noreferrer">{t('完整日志 ↗')}</a>}</div></div><pre>{logs||t('等待日志输出…')}</pre></section>}
 <footer>MAA Web Manager <span>{t('单任务串行执行 · 时间均为 {zone}',{zone:serverTimeZone()})}</span></footer></main></div>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><App/></I18nProvider>);
