import {useEffect, useState} from 'react';
import {useI18n} from './I18nContext';
import {api} from './api';
import {composeExpression, cronFields, describeSchedule, emptyFields, scheduleTypes, weekdayLabels,
  splitExpression, type ScheduleFields, type Translate} from './schedule';
import {serverTimeZone} from './timeZone';

interface Schedule {id: string; name: string; task: string; type: string; expression: string;
  enabled: boolean; nextAt: string;}
interface Draft {id: string | null; name: string; task: string; type: string; enabled: boolean;
  fields: ScheduleFields;}
interface Props {schedules: Schedule[]; tasks: any[]; reloadSchedules: () => Promise<void>;
  safe: (fn: () => Promise<any>) => Promise<void>;}

const localTime = (value: string) =>
  value ? new Date(value).toLocaleString('zh-CN', {timeZone: serverTimeZone()}) : '—';

const relative = (t: Translate, value: string) => {
  if (!value) return '';
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60000);
  if (minutes < 0) return t('已过期，等待派发');
  if (minutes < 60) return t('{minutes} 分钟后',{minutes});
  if (minutes < 60 * 36) return t('{hours} 小时后',{hours:Math.round(minutes / 60)});
  return t('{days} 天后',{days:Math.round(minutes / 1440)});
};

/**
 * Schedules as a list plus a structured editor. The rule is never typed as a raw expression
 * by hand, and the next run is computed by the server (the same code that stores it), so the
 * preview cannot disagree with what will actually happen.
 */
export default function SchedulePanel({schedules, tasks, reloadSchedules, safe}: Props) {
  const {t} = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState('');
  const [preview, setPreview] = useState<{nextAt: string; error: string}>({nextAt: '', error: ''});
  const [saving, setSaving] = useState(false);
  const editable = (tasks || []).filter((task: any) => task.editable);
  const nameOf = (name: string) => tasks?.find((task: any) => task.name === name)?.displayName || name;
  const expression = draft ? composeExpression(draft.type, draft.fields) : '';

  useEffect(() => {
    if (!draft || !expression) { setPreview({nextAt: '', error: ''}); return; }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api('schedules/preview', 'POST', {type: draft.type, expression});
        if (live) setPreview({nextAt: result.nextAt, error: ''});
      } catch (e: any) { if (live) setPreview({nextAt: '', error: e.message}); }
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [draft?.type, expression]);

  const startNew = () => setDraft({id: null, name: '', task: editable[0]?.name || '', type: 'daily',
    enabled: true, fields: emptyFields()});
  const startEdit = (schedule: Schedule) => setDraft({id: schedule.id, name: schedule.name,
    task: schedule.task, type: schedule.type, enabled: schedule.enabled,
    fields: splitExpression(schedule.type, schedule.expression)});
  const patch = (value: Partial<Draft>) => setDraft(current => current && {...current, ...value});

  const save = () => safe(async () => {
    if (!draft || !expression || saving) return;
    setSaving(true);
    try {
      const body = {name: draft.name.trim(), task: draft.task, type: draft.type,
        expression: composeExpression(draft.type, draft.fields), enabled: draft.enabled};
      await api(draft.id ? `schedules/${draft.id}` : 'schedules', draft.id ? 'PUT' : 'POST', body);
      setDraft(null);
      await reloadSchedules();
    } finally { setSaving(false); }
  });
  const toggle = (schedule: Schedule) => safe(async () => {
    await api(`schedules/${schedule.id}`, 'PUT', {...schedule, enabled: !schedule.enabled});
    await reloadSchedules();
  });
  const remove = (schedule: Schedule) => safe(async () => {
    await api(`schedules/${schedule.id}`, 'DELETE', {});
    setConfirming('');
    await reloadSchedules();
  });

  const typeFields = draft && (
    <>
      {draft.type === 'interval' && (
        <label>{t('间隔')}<input type="number" min={1} max={525600} value={draft.fields.minutes}
          onChange={e => patch({fields: {...draft.fields, minutes: Number(e.target.value)}})}/> {t('分钟')}</label>
      )}
      {(draft.type === 'daily' || draft.type === 'weekly') && (
        <label>{t('时间')}<input type="time" value={draft.fields.time}
          onChange={e => patch({fields: {...draft.fields, time: e.target.value}})}/></label>
      )}
      {draft.type === 'weekly' && (
        <label>{t('星期')}
          <div className="actions">
            {weekdayLabels(t).map((label, day) => <button key={day} type="button"
              className={draft.fields.weekdays.includes(day) ? 'primary' : ''}
              onClick={() => patch({fields: {...draft.fields, weekdays:
                draft.fields.weekdays.includes(day)
                  ? draft.fields.weekdays.filter(value => value !== day)
                  : [...draft.fields.weekdays, day]}})}>{label}</button>)}
          </div>
        </label>
      )}
      {draft.type === 'cron' && (
        <div className="device-grid">
          {cronFields(t).map((field, index) => (
            <div key={field.label}>
              <span className="muted">{field.label}（{field.hint}）</span>
              <input value={draft.fields.cron[index] ?? ''} placeholder="*"
                onChange={e => patch({fields: {...draft.fields,
                  cron: draft.fields.cron.map((value, at) => at === index ? e.target.value : value)}})}/>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return <div className="editor-grid">
    <section className="panel">
      <div className="panel-title"><h2>{t('计划 · {zone}',{zone:serverTimeZone()})}</h2>
        <button className="primary" onClick={startNew}>{t('新建调度')}</button></div>
      <p className="muted">{t('按顺序显示下次触发最近的一条；错过的触发不会补跑。')}</p>
      {schedules.length === 0 && <p className="muted">{t('还没有调度。点「新建调度」把某个预设按时间自动派发。')}</p>}
      {schedules.map(schedule => <div className="schedule" key={schedule.id}>
        <div className="panel-title">
          <strong>{schedule.name}</strong>
          <button onClick={() => void toggle(schedule)}>{schedule.enabled ? t('停用') : t('启用')}</button>
        </div>
        <p>{nameOf(schedule.task)} · {describeSchedule(schedule.type, schedule.expression)}</p>
        <small className={schedule.enabled ? '' : 'muted'}>
          {schedule.enabled ? t('下次 {time}（{relative}）',{time:localTime(schedule.nextAt),relative:relative(t, schedule.nextAt)}) : t('已停用')}
        </small>
        <small className="reason">{t('原始规则 {expression}',{expression:schedule.expression})}</small>
        <div className="actions">
          <button onClick={() => startEdit(schedule)}>{t('编辑')}</button>
          {confirming === schedule.id
            ? <><button className="danger" onClick={() => void remove(schedule)}>{t('确认删除')}</button>
              <button onClick={() => setConfirming('')}>{t('取消')}</button></>
            : <button className="danger" onClick={() => setConfirming(schedule.id)}>{t('删除')}</button>}
        </div>
      </div>)}
    </section>
    <section className="panel">
      <h2>{draft?.id ? t('编辑调度') : t('新建调度')}</h2>
      {!draft && <p className="muted">{t('选择左侧的「编辑」，或新建一条调度。')}</p>}
      {draft && <>
        <label>{t('名称')}<input value={draft.name} maxLength={120} placeholder={t('如 日常')}
          onChange={e => patch({name: e.target.value})}/></label>
        <label>{t('任务')}<select value={draft.task} onChange={e => patch({task: e.target.value})}>
          <option value="">{t('选择任务')}</option>
          {editable.map((task: any) => <option key={task.name} value={task.name}>{task.displayName || task.name}</option>)}
        </select></label>
        <label>{t('类型')}<select value={draft.type}
          onChange={e => patch({type: e.target.value, fields: e.target.value === 'weekly' && draft.type !== 'weekly' ? {...emptyFields(), time: draft.fields.time} : splitExpression(e.target.value, expression)})}>
          {scheduleTypes(t).map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
        </select></label>
        {typeFields}
        <p className={preview.error ? 'warn' : 'muted'}>
          {!expression && draft.type === 'weekly' ? t('至少选择一个星期，并填写有效时间') : preview.error ? t('规则无效：{error}',{error:preview.error})
            : preview.nextAt ? t('下次触发 {time} · {expression}',{time:localTime(preview.nextAt),expression}) : t('填写完成后在此预览下次触发时间')}
        </p>
        <div className="actions">
          <button className="primary" disabled={saving || !expression || !draft.name.trim() || !draft.task || !!preview.error}
            onClick={() => void save()}>{saving ? t('保存中…') : t('保存调度')}</button>
          <button onClick={() => setDraft(null)}>{t('取消')}</button>
        </div>
      </>}
    </section>
  </div>;
}
