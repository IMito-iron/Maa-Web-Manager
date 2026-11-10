import {useEffect} from 'react';
import {useI18n} from './I18nContext';

/**
 * Run log as an in-page drawer.
 *
 * The log used to occupy a panel under the page, which pushed the content down and coupled "which
 * run am I reading" to the tab. A drawer keeps the page in place, can be dismissed with Escape or a
 * click outside, and makes the run being read unambiguous.
 */
export default function RunDrawer({title,run,log,onClose}:{title:string;run:any;log:string;onClose:()=>void}) {
  const {t}=useI18n();
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[onClose]);
  return <div className="drawer-backdrop" onClick={onClose}><aside className="drawer" role="dialog" aria-modal="true" aria-label={t('运行日志')}
    onClick={event=>event.stopPropagation()}>
    <div className="drawer-head">
      <div>
        <div className="eyebrow">RUN LOG</div>
        <h2>{title}</h2>
        <p className="muted">{run.status}{run.source?` · ${run.source}`:''}{run.reason?` · ${run.reason}`:''}</p>
      </div>
      <div className="actions"><a href={`/api/runs/${run.id}/log`} target="_blank" rel="noreferrer">{t('完整日志 ↗')}</a><button onClick={onClose}>{t('关闭')}</button></div>
    </div>
    <pre className="drawer-log">{log||t('等待日志输出…')}</pre>
  </aside></div>;
}
