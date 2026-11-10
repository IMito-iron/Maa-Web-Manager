import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {useI18n} from './I18nContext';
import {api} from './api';
import {vncUrl as url} from './vncUrl';
import {panelLayout, videoRect} from './vncFit';
import type {Rect, Size} from './vncFit';

/**
 * The mirrored phone.
 *
 * noVNC is driven directly rather than through its own page in an iframe, and it keeps ownership of
 * the scaling (`scaleViewport`): it converts pointer positions from the canvas's layout box through
 * its own display transform, so a CSS transform applied here would be invisible to it and every
 * click would be off by that factor. The panel therefore reshapes the *layout* instead — the RFB
 * target is sized to `box / f` and shifted so the phone's rectangle lands on the box's origin
 * (vncFit.panelLayout) — which fills the panel with the phone's picture while leaving the pointer
 * mapping exactly right.
 *
 * The phone's rectangle comes from measuring the canvas pixels, because scrcpy does not always cover
 * the X canvas: it was measured drawing the phone into 976x549 of a 1920x1080 canvas. The supervisor
 * now forces the scrcpy window to the canvas size, so the rectangle normally equals the canvas and
 * this layout degenerates to a plain fit.
 *
 * RFB's target must be a container, not a canvas: noVNC 1.6 always creates its own canvas and
 * appends its screen div to the target, so a canvas target would nest it as fallback content that
 * browsers never render — a black panel.
 */
export default function DevicePanel({ready,canvas,video,dark,windowSize,modeBar}:{ready:boolean;canvas?:Size|null;video?:Size|null;dark?:any;windowSize?:Size|null;modeBar?:ReactNode}) {
  const {t} = useI18n();
  const [control,setControl]=useState<any>(null),[error,setError]=useState(''),[connected,setConnected]=useState(false);
  const [available,setAvailable]=useState(0),[maxHeight,setMaxHeight]=useState(600);
  const [nonce,setNonce]=useState(0),[sessionCanvas,setSessionCanvas]=useState<HTMLCanvasElement|null>(null);
  const [rect,setRect]=useState<Rect|null>(null),[notice,setNotice]=useState('');
  const boxRef=useRef<HTMLDivElement>(null),targetRef=useRef<HTMLDivElement>(null),rfbRef=useRef<any>(null);

  useEffect(()=>{let live=true,busy=false;const poll=async()=>{if(busy)return;busy=true;try{const value=await api('control');if(live){setControl(value);setError('');}}catch(e:any){if(live){setError(e.message);setControl(null);}}finally{busy=false;}};void poll();const timer=setInterval(()=>void poll(),1500);return()=>{live=false;clearInterval(timer);};},[]);

  // How much width the panel can give the picture, and a cap so a tall picture cannot dominate.
  useEffect(()=>{
    const element=boxRef.current?.parentElement;if(!element)return;
    const measure=()=>{const style=getComputedStyle(element);
      setAvailable(Math.max(120,element.clientWidth-parseFloat(style.paddingLeft||'0')-parseFloat(style.paddingRight||'0')));
      setMaxHeight(Math.max(240,Math.round(globalThis.innerHeight*0.62)));};
    measure();
    const observer=new ResizeObserver(measure);observer.observe(element);
    globalThis.addEventListener('resize',measure);
    return()=>{observer.disconnect();globalThis.removeEventListener('resize',measure);};
  },[]);

  // Where the phone sits inside the framebuffer, read from the pixels that were drawn. Retried
  // because the first frames may not have arrived.
  useEffect(()=>{
    if(!sessionCanvas)return;
    let cancelled=false,attempts=0,timer:any;
    const measure=()=>{
      if(cancelled)return;
      const element=targetRef.current?.querySelector('canvas');
      if(!element||!element.width||!element.height)return;
      let pixels:Uint8ClampedArray|null=null;
      try {
        const context=element.getContext('2d');
        pixels=context?context.getImageData(0,0,element.width,element.height).data:null;
      } catch {pixels=null;}
      const found=pixels?videoRect(pixels,element.width,element.height,video??null):null;
      setRect(found);
      if(!found&&attempts++<5)timer=setTimeout(measure,1500);
    };
    timer=setTimeout(measure,1200);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[sessionCanvas,video?.width,video?.height]);

  // One session per nonce. The server decides read-only vs interactive (the x11vnc lease), so the
  // session is shared and never view-only client side; input is dropped at the source.
  useEffect(()=>{
    let disposed=false,timer:any;
    (async()=>{
      if(!targetRef.current)return;
      let RFB:any;
      try {
        // Not a literal specifier: the module is served by the device web root at runtime.
        const modulePath='/vnc/core/rfb.js';
        const module=await import(/* @vite-ignore */ modulePath);
        RFB=module.default;
      } catch(e:any) { if(!disposed)setError(t('无法加载 noVNC 客户端')); return; }
      if(disposed||!targetRef.current)return;
      const protocol=location.protocol==='https:'?'wss':'ws';
      const session=new RFB(targetRef.current,`${protocol}://${location.host}/vnc/websockify`,{shared:true});
      rfbRef.current=session;
      // noVNC owns the scaling so that its pointer mapping stays correct; the layout does the rest.
      session.scaleViewport=true;
      session.clipViewport=false;
      session.viewOnly=false;
      session.addEventListener('connect',()=>{
        if(disposed)return;
        setError('');
        setConnected(true);
        setSessionCanvas(targetRef.current?.querySelector('canvas') ?? null);
      });
      session.addEventListener('disconnect',(event:any)=>{
        if(disposed)return;
        setConnected(false);
        if(event?.detail?.clean===false){setError(t('画面连接中断，正在重连…'));timer=setTimeout(()=>setNonce(value=>value+1),3000);}
      });
    })();
    return()=>{disposed=true;clearTimeout(timer);try{rfbRef.current?.disconnect();}catch{}rfbRef.current=null;setSessionCanvas(null);setRect(null);setConnected(false);};
  },[nonce]);

  const act=async(method:string)=>{try{setError('');setControl(await api('control',method,{}));}catch(e:any){setError(e.message);}};
  const owned=control?.owned;
  // A lease only survives while something heartbeats it, so an attended session must say so.
  useEffect(()=>{
    if(!owned)return;
    const timer=setInterval(()=>{void api('control/heartbeat','POST',{}).then(next=>{setControl(next);setError('');}).catch(()=>{});},20000);
    return()=>clearInterval(timer);
  },[owned]);
  // A live countdown, so the remaining control time is visible instead of surprising.
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{if(!owned)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[owned]);
  const remaining=owned&&control?.expiresAt?Math.max(0,new Date(control.expiresAt).getTime()-clock):0;
  const remainingText=remaining?t('{minutes} 分 {seconds} 秒',{minutes:Math.floor(remaining/60000),seconds:Math.floor(remaining%60000/1000)}):'—';
  const screenOff=async()=>{
    try{setError('');await api('control/screen-off','POST',{});
      setNotice(t('已请求熄屏：正在用镜像自身的显示断电关闭手机屏幕（画面保持可用，自动任务不受影响）。'));}
    catch(e:any){setError(e.message);}
  };
  const darkText=dark?(dark.mode==='none'||!dark.mode?t('已关闭熄屏策略'):t(dark.verified===false?'{mode} · 校验失败':dark.verified?'{mode} · 已校验':'{mode} · 待校验',{mode:dark.mode})+(dark.fallback?t('{mode}（回退 {fallback}）',{mode:'',fallback:dark.fallback}):'')):'—';
  // The picture reset does three things: it reconnects this viewer, asks scrcpy to reset its
  // capture/encoding (the remedy for a mirror with no frames) and re-fits the mirror window.
  const resetPicture=async()=>{
    setNonce(value=>value+1);
    try{setError('');await api('control/capture-reset','POST',{});setNotice(t('已重置画面：重新连接显示，并要求镜像重设采集/编码与窗口大小。'));}
    catch(e:any){setError(e.message);}
  };

  const layout=panelLayout({framebuffer:canvas,rect,available,maxHeight});
  const message=!ready?t('显示后端未就绪'):control?.running?t('自动任务占用 · 仅显示'):owned?(connected?t('控制中 · 已连接'):t('控制中 · 等待画面连接')):control?.held?t('其他浏览器正在控制 · 仅显示'):connected?t('显示中 · 只读（任务照常）'):t('显示中 · 正在连接画面');
  const geometry=t('画面 {video} · 画布 {canvas}',{video:video?`${video.width}×${video.height}`:'—',canvas:canvas?`${canvas.width}×${canvas.height}`:'—'})
    +(windowSize?t(' · 窗口 {size}',{size:`${windowSize.width}×${windowSize.height}`}):'')
    +(rect?t(' · 画面区 {rect}',{rect:`${rect.width}×${rect.height}@${rect.x},${rect.y}`}):'');
  const share=rect&&canvas&&canvas.width>0?rect.width/canvas.width:1;
  const scaled=share<0.98;
  const boxStyle=layout?{width:`${Math.round(layout.box.width)}px`,height:`${Math.round(layout.box.height)}px`}:{width:'100%',height:'56.25%'};
  const targetStyle=layout
    ?{position:'absolute' as const,width:`${Math.round(layout.target.width)}px`,height:`${Math.round(layout.target.height)}px`,left:`${Math.round(layout.target.left)}px`,top:`${Math.round(layout.target.top)}px`}
    :{position:'absolute' as const,inset:0};
  return <section className="panel android"><div className="panel-title"><h2>Android</h2>{modeBar}<div>{owned?<><button onClick={()=>void act('DELETE')}>{t('释放控制')}</button><button onClick={()=>void act('POST')} title={t('重新计时 30 分钟')}>{t('延长控制')}</button><a href={url} target="_blank" rel="noreferrer">{t('全屏 ↗')}</a></>:<button disabled={!ready||!control||control.running||control.held} onClick={()=>void act('POST')}>{t('进入控制')}</button>}<button onClick={()=>void resetPicture()} title={t('重新连接画面并让镜像重设采集/编码')}>{t('重置画面大小')}</button></div></div><p role="status">{message}</p>{error&&<p role="alert" className="warn">{error}</p>}<p className="muted">{owned?t('控制至 {time}（剩余 {left}），期间自动任务已暂停；心跳每 20 秒自动续期，30 分钟上限后点「延长控制」继续。',{time:new Date(control.expiresAt).toLocaleTimeString(),left:remainingText}):t('只读查看画面，任务照常运行；点击「进入控制」才交互并暂停自动任务。')}</p><p className="muted">熄屏策略 {darkText} <button onClick={()=>void screenOff()}>{t('熄屏')}</button></p>{notice&&<p className="muted">{notice}</p>}<p className="muted">{geometry}{scaled?t(' · 手机内容未铺满画布（{percent}%），面板已放大到手机画面',{percent:Math.round(share*100)}):''}</p><div ref={boxRef} style={{position:'relative',overflow:'hidden',background:'#080d0a',borderRadius:6,...boxStyle}}><div ref={targetRef} style={targetStyle}/></div></section>;
}
