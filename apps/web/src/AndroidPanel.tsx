import {useCallback,useEffect,useRef,useState} from 'react';
import type {ReactNode,PointerEvent as ReactPointerEvent} from 'react';
import {useI18n} from './I18nContext';
import {api} from './api';
import DevicePanel from './DevicePanel';
import {MediaSession} from './mediaClient';
import type {ClientStats,Mode} from './mediaClient';
import {containRect,normalisePoint,PointerTracker,regionDiff,lowerProfile} from './streamInput';
import type {Size} from './vncFit';

/**
 * The Android panel with three modes:
 *  - 观看模式: WebRTC (or H.264 WebSocket) video, never takes the control lease, input impossible;
 *  - 控制模式: takes the existing exclusive lease, low-latency tier, touch input over its own channel;
 *  - 兼容模式: the original noVNC panel, unchanged, as the fallback.
 * One media session serves view and control: switching between them changes the server-side mode
 * and tier on the same connection, so no second capture or stray input session is left behind.
 */
type PanelMode='view'|'control'|'compat';
const VIEW_TIERS=['p15','p30','p60'];
const CONTROL_TIERS=['p30','p60'];
const tierFps=(p:string)=>Number(p.slice(1));
const MODE_KEY='maa.android.mode',TIER_KEY='maa.android.tier';
const read=(k:string)=>{try{return localStorage.getItem(k);}catch{return null;}};
const write=(k:string,v:string)=>{try{localStorage.setItem(k,v);}catch{}};

export default function AndroidPanel(props:{ready:boolean;canvas?:Size|null;video?:Size|null;dark?:any;windowSize?:Size|null}) {
  const {t}=useI18n();
  // Control is never restored from storage: entering it must be a deliberate click.
  const [mode,setMode]=useState<PanelMode>(()=>read(MODE_KEY)==='compat'?'compat':'view');
  const bar=<div className="seg android-modes" role="tablist">{([['view','观看模式'],['control','控制模式'],['compat','兼容模式']] as const).map(([m,label])=>
    <button key={m} role="tab" aria-selected={mode===m} className={mode===m?'on':''} onClick={()=>{setMode(m);if(m!=='control')write(MODE_KEY,m);}}>{t(label)}</button>)}</div>;
  if(mode==='compat')return <DevicePanel {...props} modeBar={bar}/>;
  return <StreamPanel ready={props.ready} mode={mode} bar={bar} onLeaveControl={()=>setMode('view')}/>;
}

function StreamPanel({ready,mode,bar,onLeaveControl}:{ready:boolean;mode:Mode;bar:ReactNode;onLeaveControl:()=>void}) {
  const {t}=useI18n();
  const videoRef=useRef<HTMLVideoElement>(null),canvasRef=useRef<HTMLCanvasElement>(null),boxRef=useRef<HTMLDivElement>(null);
  const sessionRef=useRef<MediaSession|null>(null),trackerRef=useRef<PointerTracker|null>(null);
  const [viewTier,setViewTier]=useState(()=>VIEW_TIERS.includes(read(TIER_KEY)??'')?read(TIER_KEY)!:'p15');
  const [controlTier,setControlTier]=useState('p30');
  const [profile,setProfile]=useState(viewTier);
  const [state,setState]=useState('connecting'),[detail,setDetail]=useState('');
  const [stats,setStats]=useState<ClientStats|null>(null),[server,setServer]=useState<any>(null);
  const [control,setControl]=useState<any>(null),[controlActive,setControlActive]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const [nonce,setNonce]=useState(0),[hidden,setHidden]=useState(false);
  const [measuring,setMeasuring]=useState(false),[latencies,setLatencies]=useState<number[]>([]);
  const weak=useRef(0),credentialRetry=useRef(false);
  const wantTier=mode==='control'?controlTier:viewTier;
  const tierRef=useRef(wantTier);tierRef.current=wantTier;
  const modeRef=useRef(mode);modeRef.current=mode;

  // Lease status, as the noVNC panel polls it (owner, expiry, automation running).
  useEffect(()=>{let live=true;const poll=async()=>{try{const v=await api('control');if(live)setControl(v);}catch{if(live)setControl(null);}};void poll();const timer=setInterval(()=>void poll(),1500);return()=>{live=false;clearInterval(timer);};},[]);

  // A hidden tab stops watching after a minute so an idle viewer costs nothing; a controller only
  // lifts its fingers, because the lease is still theirs.
  useEffect(()=>{
    let timer:any;
    const onVis=()=>{
      if(document.hidden){trackerRef.current?.releaseAll();if(modeRef.current==='view')timer=setTimeout(()=>setHidden(true),60000);}
      else{clearTimeout(timer);setHidden(false);}
    };
    document.addEventListener('visibilitychange',onVis);
    return()=>{document.removeEventListener('visibilitychange',onVis);clearTimeout(timer);};
  },[]);

  // The media session: one per mount/reconnect, never per mode switch.
  useEffect(()=>{
    if(!videoRef.current||!canvasRef.current||hidden)return;
    let reconnect:any;
    const session=new MediaSession(videoRef.current,canvasRef.current,tierRef.current,modeRef.current,{
      onState:(s,d)=>{setState(s);setDetail(d??'');
        if(s==='closed'){setControlActive(false);reconnect=setTimeout(()=>setNonce(n=>n+1),3000);}},
      onControl:(active,reason)=>{setControlActive(active);
        // The lease cookie is created by the first "进入控制"; a media socket opened before it has no
        // credential, so reconnect once (the new socket carries it) instead of reporting an error.
        if(!active&&reason==='没有控制凭据，请先进入控制'&&modeRef.current==='control'&&!credentialRetry.current){credentialRetry.current=true;setNonce(n=>n+1);return;}
        if(!active&&reason&&modeRef.current==='control')setError(t(reason));},
      onStats:(c,s)=>{setStats(c);setServer(s);},
      onProfile:p=>setProfile(p),
    });
    sessionRef.current=session;
    trackerRef.current=new PointerTracker(e=>session.sendInput(e));
    session.connect();
    return()=>{clearTimeout(reconnect);trackerRef.current?.releaseAll();session.close();sessionRef.current=null;trackerRef.current=null;};
  },[nonce,hidden]);

  // Tier changes are applied on the same connection (server switches the capture it forwards).
  useEffect(()=>{if(profile!==wantTier)sessionRef.current?.setProfile(wantTier);},[wantTier,state]);

  // Entering control mode: take the existing exclusive lease first, then ask the media service to
  // accept input (it re-checks the lease itself). Leaving it releases both.
  useEffect(()=>{
    let cancelled=false;
    if(mode!=='control'){sessionRef.current?.setMode('view');setControlActive(false);credentialRetry.current=false;return;}
    (async()=>{
      try{setError('');const v=await api('control','POST',{});if(cancelled)return;setControl(v);sessionRef.current?.setMode('control');}
      catch(e:any){if(!cancelled){setError(e.message);onLeaveControl();}}
    })();
    return()=>{cancelled=true;trackerRef.current?.releaseAll();sessionRef.current?.setMode('view');void api('control','DELETE',{}).catch(()=>{});};
  },[mode]);
  // The session may reconnect while in control mode; ask again once it is up.
  useEffect(()=>{if(mode==='control'&&state==='playing'&&!controlActive&&control?.owned)sessionRef.current?.setMode('control');},[state]);
  const owned=!!control?.owned;
  // The lease ended elsewhere (expired, released in another tab, revoked): back to watching.
  const wasOwned=useRef(false);
  useEffect(()=>{if(mode==='control'&&wasOwned.current&&!owned){setNotice(t('控制已释放或过期，已回到观看模式'));onLeaveControl();}wasOwned.current=owned;},[owned]);
  useEffect(()=>{if(!owned||mode!=='control')return;const timer=setInterval(()=>{void api('control/heartbeat','POST',{}).then(setControl).catch(()=>{});},20000);return()=>clearInterval(timer);},[owned,mode]);

  // Adaptive quality for watchers: sustained loss or a delivery far below the tier steps down once.
  useEffect(()=>{
    if(mode!=='view'||!stats||stats.receiveFps==null)return;
    const sourceFps=server?.source?.window?.fps??0,static_=server?.source?.window?.static;
    const behind=!static_&&sourceFps>5&&stats.receiveFps<sourceFps*0.6;
    weak.current=(stats.lossPct??0)>8||behind?weak.current+1:0;
    if(weak.current>=6){weak.current=0;const lower=lowerProfile(viewTier);
      if(lower){setViewTier(lower);setNotice(t('网络或解码跟不上 {from} fps，已自动降到 {to} fps',{from:tierFps(viewTier),to:tierFps(lower)}));}}
  },[stats]);

  // Input: pointer events → normalised picture coordinates → ordered, coalesced stream.
  const picture=()=>{
    const box=boxRef.current,video=videoRef.current,canvas=canvasRef.current;if(!box)return null;
    const r=box.getBoundingClientRect();
    const w=session()?.currentTransport==='ws'?canvas?.width:video?.videoWidth,h=session()?.currentTransport==='ws'?canvas?.height:video?.videoHeight;
    return containRect({left:r.left,top:r.top,width:r.width,height:r.height},w||0,h||0);
  };
  const session=()=>sessionRef.current;
  const canInput=mode==='control'&&controlActive;
  useEffect(()=>{if(!canInput)return;let raf=0;const loop=()=>{trackerRef.current?.flush();raf=requestAnimationFrame(loop);};raf=requestAnimationFrame(loop);
    const hb=setInterval(()=>session()?.sendInput({t:'hb'}),(trackerRef.current?.active??0)>0?500:2000);
    return()=>{cancelAnimationFrame(raf);clearInterval(hb);trackerRef.current?.releaseAll();};},[canInput]);
  // Fingers held down must keep the server's dead-man timer fed.
  useEffect(()=>{if(!canInput)return;const timer=setInterval(()=>{if((trackerRef.current?.active??0)>0)session()?.sendInput({t:'hb'});},500);return()=>clearInterval(timer);},[canInput]);
  const onPointer=(kind:'down'|'move'|'up'|'cancel')=>(e:ReactPointerEvent)=>{
    if(!canInput)return;
    const pic=picture();if(!pic)return;
    const point=normalisePoint(e.clientX,e.clientY,pic,kind!=='down');if(!point)return;
    const tracker=trackerRef.current;if(!tracker)return;
    e.preventDefault();
    if(kind==='down'){(e.target as Element).setPointerCapture?.(e.pointerId);if(measuring)startMeasure(e.clientX,e.clientY,pic);tracker.down(e.pointerId,point.x,point.y,e.pressure||1);}
    else if(kind==='move')tracker.move(e.pointerId,point.x,point.y,e.pressure||1);
    else tracker.up(e.pointerId,point.x,point.y,kind==='cancel');
  };
  const key=(k:'back'|'home'|'apps')=>{if(canInput)session()?.sendInput({t:'k',k});};

  // End-to-end latency: time from this browser's pointerdown to the first presented frame whose
  // pixels around the touch point change. It includes input transport, Android's reaction, capture,
  // encoding, network, decoding and display — the whole loop the user feels.
  const startMeasure=useCallback((cx:number,cy:number,pic:{left:number;top:number;width:number;height:number})=>{
    setMeasuring(false);
    const source:any=session()?.currentTransport==='ws'?canvasRef.current:videoRef.current;if(!source)return;
    const sw=source.videoWidth||source.width,sh=source.videoHeight||source.height;if(!sw||!sh)return;
    const sx=Math.round((cx-pic.left)/pic.width*sw),sy=Math.round((cy-pic.top)/pic.height*sh),size=48;
    const probe=document.createElement('canvas');probe.width=size;probe.height=size;const ctx=probe.getContext('2d',{willReadFrequently:true});if(!ctx)return;
    const grab=()=>{ctx.drawImage(source,Math.max(0,sx-size/2),Math.max(0,sy-size/2),size,size,0,0,size,size);return ctx.getImageData(0,0,size,size).data;};
    const reference=grab(),t0=performance.now();
    const check=(at:number)=>{
      if(at-t0>3000){setNotice(t('3 秒内触点附近画面未变化，未得到延迟样本'));return;}
      if(regionDiff(reference,grab())>10){const ms=Math.round(at-t0);setLatencies(l=>[ms,...l].slice(0,8));return;}
      next();
    };
    const next=()=>{if(source===videoRef.current&&typeof (source as any).requestVideoFrameCallback==='function')(source as any).requestVideoFrameCallback((now:number)=>check(now));else requestAnimationFrame(check);};
    next();
  },[]);

  const remaining=owned&&control?.expiresAt?Math.max(0,new Date(control.expiresAt).getTime()-Date.now()):0;
  const fmtLeft=t('{minutes} 分 {seconds} 秒',{minutes:Math.floor(remaining/60000),seconds:Math.floor(remaining%60000/1000)});
  const transportLabel=!stats?'—':stats.transport==='webrtc'?`WebRTC${stats.pair?` (${stats.pair})`:''}`:t('兼容 H.264（WebSocket）');
  const src=server?.source;
  const message=!ready?t('显示后端未就绪'):state==='error'&&detail==='nowebcodecs'?t('此浏览器不支持 WebCodecs，请改用兼容模式'):state==='error'?t('媒体服务错误：{error}',{error:detail}):state==='closed'?t('媒体连接中断，正在重连…'):state==='connecting'?t('正在连接媒体服务…'):
    mode==='control'?(controlActive?t('控制中 · 低延迟 {fps} fps',{fps:tierFps(profile)}):control?.running?t('自动任务占用 · 不能控制'):t('正在取得控制…')):t('观看中 · {fps} fps · 不占用控制权',{fps:tierFps(profile)});
  const num=(v:any,digits=0,unit='')=>v==null||!Number.isFinite(v)?'—':`${Number(v).toFixed(digits)}${unit}`;
  const tiers=mode==='control'?CONTROL_TIERS:VIEW_TIERS;
  const pickTier=(p:string)=>{if(mode==='control')setControlTier(p);else{setViewTier(p);write(TIER_KEY,p);}setNotice('');};
  const estimate=stats&&src?.window?(src.window.deviceToServerQueueMs??0)+(stats.rttMs??0)/2+(stats.jitterBufferMs??0)+(stats.decodeMs??0)+1000/Math.max(1,stats.renderFps||tierFps(profile)):null;

  return <section className="panel android stream">
    <div className="panel-title"><h2>Android</h2>{bar}<div>
      {mode==='control'&&owned&&<><button onClick={()=>void api('control','POST',{}).then(setControl).catch((e:any)=>setError(e.message))} title={t('重新计时 30 分钟')}>{t('延长控制')}</button><button onClick={onLeaveControl}>{t('释放控制')}</button></>}
      <button onClick={()=>setNonce(n=>n+1)} title={t('重新建立媒体连接')}>{t('重新连接')}</button></div></div>
    <p role="status">{message}{state==='fallback'||stats?.transport==='ws'?t(' · 已回退到兼容 H.264 传输'):''}</p>
    {error&&<p role="alert" className="warn">{error}</p>}
    {notice&&<p className="muted">{notice}</p>}
    <div className="stream-bar">
      <div className="seg">{tiers.map(p=><button key={p} className={wantTier===p?'on':''} onClick={()=>pickTier(p)}>{tierFps(p)} fps</button>)}</div>
      <small className="muted">{t('连接方式')}：{transportLabel} · {t('接收')} {num(stats?.receiveFps,0,' fps')} · {t('渲染')} {num(stats?.renderFps,0,' fps')}{src?.window?.static?t(' · 画面静止（源帧率低属正常）'):''}</small>
      {mode==='control'&&<small className="muted">{owned?t('控制剩余 {left}',{left:fmtLeft}):''}</small>}
    </div>
    <div ref={boxRef} className={`stream-box${canInput?' interactive':''}`} onPointerDown={onPointer('down')} onPointerMove={onPointer('move')} onPointerUp={onPointer('up')} onPointerCancel={onPointer('cancel')} onLostPointerCapture={onPointer('up')} onContextMenu={e=>e.preventDefault()}>
      <video ref={videoRef} muted playsInline autoPlay style={{display:stats?.transport==='ws'?'none':'block'}}/>
      <canvas ref={canvasRef} style={{display:stats?.transport==='ws'?'block':'none'}}/>
    </div>
    {mode==='control'&&<div className="actions stream-keys">
      <button disabled={!canInput} onClick={()=>key('back')}>{t('返回')}</button><button disabled={!canInput} onClick={()=>key('home')}>{t('主页')}</button><button disabled={!canInput} onClick={()=>key('apps')}>{t('最近任务')}</button>
      <span className="sp"/><button disabled={!canInput} className={measuring?'on':''} onClick={()=>setMeasuring(m=>!m)} title={t('下一次点击时，测量从按下到触点附近画面变化的真实耗时')}>{measuring?t('请点击画面…'):t('测量点击延迟')}</button>
      {latencies.length>0&&<small className="muted">{t('点击→画面 {values} ms（中位数 {median} ms）',{values:latencies.join(' / '),median:[...latencies].sort((a,b)=>a-b)[Math.floor(latencies.length/2)]})}</small>}
    </div>}
    <p className="muted">{mode==='control'?t('控制期间自动任务已暂停；断线、超时或撤销控制后立即停止接受输入并松开所有触点。'):t('观看不占用控制权，点击画面不会产生输入；任务照常运行。')}</p>
    <details className="stream-stats"><summary>{t('统计')}</summary>
      <table><tbody>
        <tr><th>{t('Android 采集/编码')}</th><td>{t('源帧率 {fps} · 码率 {kbps} · 档位 {tier} fps',{fps:num(src?.window?.fps,1),kbps:num(src?.window?.bitRate/1000,0,' kbps'),tier:src?.fpsTier??'—'})}{src?.window?.static?t(' · 静止画面'):''}</td></tr>
        <tr><th>{t('手机→服务器')}</th><td>{t('排队估计 {ms}（抖动 {jitter}）',{ms:num(src?.window?.deviceToServerQueueMs,1,' ms'),jitter:num(src?.window?.deviceToServerJitterMs,1,' ms')})}</td></tr>
        <tr><th>{t('网络')}</th><td>{t('{transport} · 码率 {kbps} · 丢包 {loss} · RTT {rtt}',{transport:transportLabel,kbps:num(stats?.kbps,0,' kbps'),loss:num(stats?.lossPct,2,'%'),rtt:num(stats?.rttMs,0,' ms')})}</td></tr>
        <tr><th>{t('解码')}</th><td>{t('接收 {recv} · 解码 {dec} · 缓冲 {jb} · 解码耗时 {dms} · 丢帧 {dropped}',{recv:num(stats?.receiveFps,1,' fps'),dec:num(stats?.decodeFps,1,' fps'),jb:num(stats?.jitterBufferMs,0,' ms'),dms:num(stats?.decodeMs,1,' ms'),dropped:stats?.framesDropped??'—'})}</td></tr>
        <tr><th>{t('浏览器显示')}</th><td>{t('渲染 {fps} · 分辨率 {size}',{fps:num(stats?.renderFps,1,' fps'),size:stats?.width?`${stats.width}×${stats.height}`:'—'})}</td></tr>
        <tr><th>{t('估计画面延迟')}</th><td>{t('{ms}（不含手机编码与触控处理；真实点击延迟请用「测量点击延迟」）',{ms:num(estimate,0,' ms')})}</td></tr>
        <tr><th>{t('服务端')}</th><td>{t('采集状态 {state} · 本档位观看者 {subs} · 关键帧请求 {resets}',{state:src?.state??'—',subs:src?.subscribers??'—',resets:src?.keyFrameRequests??'—'})}{server?.ws?t(' · WS 队列 {queued} 丢弃 {dropped}',{queued:server.ws.queued,dropped:server.ws.dropped}):''}</td></tr>
      </tbody></table>
      {detail&&state!=='playing'&&<p className="muted">{t('诊断：{detail}',{detail})}</p>}
    </details>
  </section>;
}
