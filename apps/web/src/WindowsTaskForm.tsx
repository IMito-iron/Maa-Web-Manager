// Schema-driven editor for tasks in Windows mode. Fields, groups, labels, ranges, choices and
// visibility come from the generated Windows schema spec; only the composite widgets are hand-made.
import React from 'react';
import {useI18n} from './I18nContext';
import {
  applyUiRules, choicesOf, enabled, flagsOf, specFor, stageOptions, visible, widgetOf,
  WEEK_DAYS, type ClientType, type Gui, type GuiTaskType, type SpecField,
} from './maaModel';

// MaaWpfGui zh-cn.xaml TaskQueue.Stage.*; "Annihilation" follows the v6.21.4 screenshot (当期剿灭).
const STAGE_LABEL: Record<string, string> = {
  '': '当前/上次', Annihilation: '当期剿灭', 'CE-6': '龙门币-6/5', 'AP-5': '红票-5', 'CA-5': '技能-5', 'LS-6': '经验-6/5', 'SK-5': '碳-5',
  'PR-A-1': '奶/盾芯片', 'PR-A-2': '奶/盾芯片组', 'PR-B-1': '术/狙芯片', 'PR-B-2': '术/狙芯片组',
  'PR-C-1': '先/辅芯片', 'PR-C-2': '先/辅芯片组', 'PR-D-1': '近/特芯片', 'PR-D-2': '近/特芯片组',
};
const DAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface StageEntry { value: string; display: string; open: boolean; activity?: boolean; }
interface Props { type: GuiTaskType; gui: Gui; client: ClientType; onChange: (next: Gui) => void; /** Server stage list (GET /api/stages); falls back to the permanent table. */ stages?: StageEntry[] | null; }

export default function WindowsTaskForm({type, gui, client, onChange, stages}: Props) {
  const {t: tr} = useI18n();
  const env = {client};
  const set = (key: string, value: unknown) => onChange(applyUiRules(type, key, value, gui, env));
  const fields = specFor(type).filter(f => widgetOf(f) !== 'hidden' && visible(f, gui, env));
  const groups = [...new Set(fields.map(f => f.group))];
  return <div className="win-form">
    {groups.map(group => <section key={group} className="win-group">
      <h4>{tr(group)}</h4>
      <div className="param-grid">
        {fields.filter(f => f.group === group).map(f => <Field key={f.key} type={type} field={f} gui={gui} disabled={!enabled(f, gui, env)} set={set} stages={stages} />)}
      </div>
    </section>)}
  </div>;
}

function Field({type, field: f, gui, disabled, set, stages}: {type: GuiTaskType; field: SpecField; gui: Gui; disabled: boolean; set: (k: string, v: unknown) => void; stages?: StageEntry[] | null}) {
  const {t: tr} = useI18n();
  const value = gui[f.key];
  const label = tr(f.label || f.key);
  const min = f.range?.Minimum !== undefined ? Number(f.range.Minimum) : undefined;
  const max = f.range?.Maximum !== undefined ? Number(f.range.Maximum) : undefined;
  switch (widgetOf(f)) {
    case 'bool': {
      // UseStone without UseStoneAllowSave is "this run only" in Windows (never saved).
      const runOnly = type === 'Fight' && f.key === 'UseStone' && !gui.UseStoneAllowSave;
      return <label className="check" title={runOnly ? tr('未勾选“允许使用源石保存状态”时，源石选项不会被保存') : undefined}>
        <input type="checkbox" checked={value === true} disabled={disabled || runOnly} onChange={e => set(f.key, e.target.checked)} />
        <span>{label}{runOnly ? '*' : ''}</span>
      </label>;
    }
    case 'number':
      return <label className="fld"><span>{label}</span>
        <input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} disabled={disabled}
          onChange={e => { if (e.target.value === '') return; let n = Number(e.target.value); if (min !== undefined) n = Math.max(min, n); if (max !== undefined) n = Math.min(max, n); set(f.key, n); }} /></label>;
    case 'select': {
      const choices = choicesOf(type, f, gui);
      const known = choices.some(c => String(c.value) === String(value));
      return <label className="fld"><span>{label}</span>
        <select value={String(value ?? '')} disabled={disabled} onChange={e => { const c = choices.find(c => String(c.value) === e.target.value); set(f.key, c ? c.value : e.target.value); }}>
          {!known && <option value={String(value ?? '')}>{String(value ?? '') || tr('未指定')}</option>}
          {choices.map(c => <option key={String(c.value)} value={String(c.value)}>{tr(c.label)}</option>)}
        </select></label>;
    }
    case 'stringList': {
      const list: string[] = Array.isArray(value) ? value : [];
      return <label className="fld"><span>{label}</span>
        <input type="text" value={list.join(', ')} disabled={disabled} placeholder={tr('逗号分隔')}
          onChange={e => set(f.key, e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean))} /></label>;
    }
    case 'flags': {
      const list = flagsOf(value);
      return <div className="fld"><span className="lbl">{label}</span><div className="chips">
        {choicesOf(type, f, gui).map(c => <label key={String(c.value)} className={'chip' + (list.includes(String(c.value)) ? ' on' : '')}>
          <input type="checkbox" disabled={disabled} checked={list.includes(String(c.value))}
            onChange={() => set(f.key, list.includes(String(c.value)) ? list.filter(v => v !== c.value) : [...list, String(c.value)])} />{tr(c.label)}
        </label>)}
      </div></div>;
    }
    case 'ordered': {
      const list: string[] = Array.isArray(value) ? value : [];
      return <div className="fld"><span className="lbl">{label}</span><ol className="win-list">
        {list.map((v, i) => <li key={v}>{v}
          <button disabled={disabled || i === 0} aria-label={tr('上移')} onClick={() => set(f.key, move(list, i, i - 1))}>↑</button>
          <button disabled={disabled || i === list.length - 1} aria-label={tr('下移')} onClick={() => set(f.key, move(list, i, i + 1))}>↓</button></li>)}
      </ol></div>;
    }
    case 'stagePlan': return <StagePlan gui={gui} label={label} set={set} stages={stages} />;
    case 'rooms': {
      const rooms: {Room: string; IsEnabled?: boolean}[] = Array.isArray(value) ? value : [];
      return <div className="fld"><span className="lbl">{label}</span>
        {gui.Mode === 'Normal' && <small>{tr('常规模式按固定设施顺序执行，排序仅对队列轮换/自定义生效')}</small>}
        <ol className="win-list">{rooms.map((r, i) => <li key={r.Room}>
          <label className="check"><input type="checkbox" checked={r.IsEnabled !== false} disabled={disabled}
            onChange={e => set(f.key, rooms.map((x, j) => j === i ? {...x, IsEnabled: e.target.checked} : x))} />{r.Room}</label>
          <button disabled={disabled || i === 0} aria-label={tr('上移')} onClick={() => set(f.key, move(rooms, i, i - 1))}>↑</button>
          <button disabled={disabled || i === rooms.length - 1} aria-label={tr('下移')} onClick={() => set(f.key, move(rooms, i, i + 1))}>↓</button>
        </li>)}</ol></div>;
    }
    case 'weekly': {
      const week = value && typeof value === 'object' ? value : {};
      return <div className="fld"><span className="lbl">{label}</span><div className="chips">
        {WEEK_DAYS.map((d, i) => <label key={d} className={'chip' + (week[d] !== false ? ' on' : '')}>
          <input type="checkbox" disabled={disabled} checked={week[d] !== false} onChange={e => set(f.key, {...week, [d]: e.target.checked})} />{tr(DAY_LABEL[i])}
        </label>)}
      </div></div>;
    }
    case 'opers': {
      const opers: {Name: string; UseSupport: boolean}[] = Array.isArray(value) ? value : [];
      const rows = gui.UseAdditionalStartingOpers ? 3 : 1;
      const at = (i: number) => opers[i] ?? {Name: '', UseSupport: false};
      const put = (i: number, patch: object) => {
        const next = Array.from({length: Math.max(opers.length, i + 1)}, (_, j) => j === i ? {...at(j), ...patch} : at(j));
        while (next.length && !next[next.length - 1].Name && !next[next.length - 1].UseSupport) next.pop();
        set(f.key, next);
      };
      return <div className="fld"><span className="lbl">{label}</span>
        {Array.from({length: rows}, (_, i) => <div key={i} className="win-row">
          <input type="text" value={at(i).Name} disabled={disabled || (i > 0 && !at(i - 1).Name)} placeholder={tr('干员名')} onChange={e => put(i, {Name: e.target.value})} />
          <label className="check"><input type="checkbox" checked={at(i).UseSupport} disabled={disabled || !at(i).Name} onChange={e => put(i, {UseSupport: e.target.checked})} />{tr('使用助战')}</label>
        </div>)}</div>;
    }
    case 'recruitTime': {
      const minutes = Number.isFinite(value) ? value : 540;
      const h = Math.floor(minutes / 60), m = minutes % 60;
      return <div className="fld"><span className="lbl">{label}</span><div className="win-row">
        <input type="number" min={1} max={9} value={h} disabled={disabled} aria-label={tr('时')} onChange={e => set(f.key, clampTime(Number(e.target.value), m))} />
        <span>:</span>
        <input type="number" min={0} max={50} step={10} value={m} disabled={disabled} aria-label={tr('分')} onChange={e => set(f.key, clampTime(h, Number(e.target.value)))} />
      </div></div>;
    }
    default:
      return <label className="fld"><span>{label}</span>
        <input type="text" value={value === undefined || value === null ? '' : String(value)} disabled={disabled} onChange={e => set(f.key, e.target.value)} /></label>;
  }
}

/** Windows recruit time boxes: hour 1–9, minute 0–50 in steps of 10; 9:xx clamps to 9:00. */
function clampTime(h: number, m: number) {
  const hour = Math.min(9, Math.max(1, Math.round(h || 1)));
  const minute = hour === 9 ? 0 : Math.min(50, Math.max(0, Math.round((m || 0) / 10) * 10));
  return hour * 60 + minute;
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function StagePlan({gui, label, set, stages}: {gui: Gui; label: string; set: (k: string, v: unknown) => void; stages?: StageEntry[] | null}) {
  const {t: tr} = useI18n();
  // Windows GetStageList; HideUnavailableStage applies only without a weekly schedule.
  const hideClosed = !!gui.HideUnavailableStage && !gui.UseWeeklySchedule;
  const entries: StageEntry[] = (stages ?? stageOptions().map(value => ({value, display: value, open: true}))).filter(s => !hideClosed || s.open);
  const values = entries.map(s => s.value);
  const text = (s: StageEntry) => (STAGE_LABEL[s.value] !== undefined ? tr(STAGE_LABEL[s.value]) : s.display) + (s.open ? '' : ' ' + tr('（今日未开放）'));
  const plan: string[] = Array.isArray(gui.StagePlan) && gui.StagePlan.length ? gui.StagePlan : [''];
  const multi = !!gui.UseOptionalStage;
  const rows = multi ? plan : plan.slice(0, 1);
  const put = (i: number, v: string) => set('StagePlan', rows.map((s, j) => j === i ? v : s));
  return <div className="fld"><span className="lbl">{label}</span>
    {multi && <small>{tr('从上到下选择当天第一个开放的关卡')}</small>}
    {rows.map((stage, i) => <div key={i} className="win-row">
      {gui.IsStageManually
        ? <input type="text" value={stage} placeholder={tr('关卡名')} onChange={e => put(i, e.target.value.trim())} />
        : <select value={stage} onChange={e => put(i, e.target.value)}>
            {!values.includes(stage) && <option value={stage}>{stage}</option>}
            {entries.map(s => <option key={s.value} value={s.value}>{text(s)}</option>)}
          </select>}
      {multi && <>
        <button disabled={i === 0} aria-label={tr('上移')} onClick={() => set('StagePlan', move(rows, i, i - 1))}>↑</button>
        <button disabled={i === rows.length - 1} aria-label={tr('下移')} onClick={() => set('StagePlan', move(rows, i, i + 1))}>↓</button>
        <button disabled={rows.length === 1} onClick={() => set('StagePlan', rows.filter((_, j) => j !== i))}>{tr('删除')}</button>
      </>}
    </div>)}
    {multi && <button onClick={() => set('StagePlan', [...rows, ''])}>{tr('添加关卡')}</button>}
  </div>;
}
