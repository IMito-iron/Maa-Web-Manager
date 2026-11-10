import {setServerTimeZone} from './timeZone';
import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {mergeRunnerStatus} from './runnerStatus';
export function useRunnerStatus() {
  const [status,setStatus]=useState<any>(null),[fresh,setFresh]=useState(false),[pending,setPending]=useState(false);
  const lastSeen=useRef(0),busy=useRef(false);
  const accept=(value:any)=>{setServerTimeZone(value?.timezone);setStatus((old:any)=>mergeRunnerStatus(old,value));lastSeen.current=Date.now();setFresh(true);};
  useEffect(()=>{
    let live=true,refreshing=false,lastRefresh=-Infinity;
    const refresh=async()=>{
      if(refreshing)return;
      refreshing=true;lastRefresh=Date.now();
      try{const value=await api('status');if(live)accept(value);}
      catch{if(live)setFresh(false);}
      finally{refreshing=false;}
    };
    void refresh();
    const source=new EventSource('/api/events');
    source.addEventListener('status',e=>{try{accept(JSON.parse((e as MessageEvent).data));}catch{setFresh(false);}});
    source.onerror=()=>setFresh(false);source.onopen=()=>{void refresh();};
    const timer=setInterval(()=>{
      const now=Date.now(),stale=now-lastSeen.current>5000;
      if(stale)setFresh(false);
      // A proxied 502 can permanently close EventSource. Keep recovery read-only,
      // bounded to one in-flight read and one attempt per three seconds.
      if((source.readyState!==EventSource.OPEN||stale)&&now-lastRefresh>=3000)void refresh();
    },1000);
    return()=>{live=false;source.close();clearInterval(timer);};
  },[]);
  const toggle=async()=>{
    if(busy.current||!fresh||!status?.queue)return;
    busy.current=true;setPending(true);
    try {
      const queue=await api('queue','POST',{action:status.queue.paused?'resume':'pause'});
      setStatus((old:any)=>mergeRunnerStatus(old,{...old,queue}));
      lastSeen.current=Date.now();setFresh(true);
    } catch(e) {setFresh(false);throw e;}
    finally {busy.current=false;setPending(false);}
  };
  return {status,fresh,pending,toggle};
}
