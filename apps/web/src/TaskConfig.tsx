import React, { useEffect, useRef, useState } from 'react';
import {useI18n} from './I18nContext';

import { api, slugify } from './api';
import Modal from './Modal';
import {
  TASK_TYPES, getTaskType, deserializeParams,
  parsePreset, serializePreset, type FieldDef, type PresetDoc, type TaskEntry,
} from './taskSchema';
import {basicFields, duplicateTask, fieldEditable, setTaskEnabled, startupNotices, taskDisabled, toggleBlock, validateEditorRaw} from './taskEditor';
import {serverTimeZone} from './timeZone';

interface TaskConfigProps {
  tasks: any[];
  reloadTasks: () => Promise<void>;
  /** `overrides`: Windows run-only options keyed by task index (manual runs only). */
  submit: (name: string, overrides?: Record<string, Record<string, boolean>>) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  runDisabledReason: string;
  deviceLabel: string;
  accountPolicy?: 'require-verified' | 'warn-continue';
}

function FieldHelp({text}: {text: string}) {
  const {t: tr} = useI18n();
  return text.length > 80 ? <details className="field-help"><summary>{tr('参数说明')}</summary><small>{tr(text)}</small></details> : <small>{tr(text)}</small>;
}

function StageField({ field, value, onChange }: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const {t: tr} = useI18n();
  const str = value === undefined || value === null ? '' : String(value);
  const opts = field.options ?? [];
  const [custom, setCustom] = useState(() => str !== '' && !opts.some(o => String(o.value) === str));
  return (
    <label className="fld">
      <span>{tr(field.label)}</span>
      <select value={custom ? '__custom__' : str} onChange={e => {
        const v = e.target.value;
        if (v === '__custom__') { setCustom(true); onChange(''); }
        else { setCustom(false); onChange(v); }
      }}>
        {opts.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        <option value="__custom__">{tr('自定义关卡…')}</option>
      </select>
      {custom && (
        <input type="text" value={str} placeholder={field.placeholder ? tr(field.placeholder) : tr('如 1-7 / PR-A-1 / SSReopen-IC')}
          onChange={e => onChange(e.target.value)} />
      )}
      {field.help && <FieldHelp text={field.help} />}
    </label>
  );
}

function FieldControl({ field, value, onChange }: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const {t: tr} = useI18n();
  if (field.kind === 'boolean') {
    return (
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
        <span>{tr(field.label)}</span>
      </label>
    );
  }
  if (field.kind === 'number') {
    return (
      <label className="fld">
        <span>{tr(field.label)}</span>
        <input type="number" value={value === undefined || value === null ? '' : String(value)}
          min={field.min} max={field.max} step={field.step}
          onChange={e => onChange(e.target.value === '' ? (field.default ?? 0) : Number(e.target.value))} />
        {field.help && <FieldHelp text={field.help} />}
      </label>
    );
  }
  if (field.kind === 'select') {
    return (
      <label className="fld">
        <span>{tr(field.label)}</span>
        <select value={String(value ?? '')} onChange={e => {
          const raw = e.target.value;
          const opt = field.options?.find(o => String(o.value) === raw);
          onChange(opt ? opt.value : raw);
        }}>
          {!field.options?.some(o => String(o.value) === String(value ?? '')) && <option value={String(value ?? '')}>{String(value ?? '') || tr('未指定')}</option>}
          {(field.options ?? []).map(o => <option key={String(o.value)} value={String(o.value)}>{field.key === 'client_type' ? tr(o.label) : o.label}</option>)}
        </select>
        {field.help && <FieldHelp text={field.help} />}
      </label>
    );
  }
  if (field.kind === 'stage') {
    return <StageField field={field} value={value} onChange={onChange} />;
  }
  if (field.kind === 'multi-select') {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (v: string | number) => {
      const has = arr.some(x => x === v);
      onChange(has ? arr.filter(x => x !== v) : [...arr, v]);
    };
    return (
      <div className="fld">
        <span className="lbl">{tr(field.label)}</span>
        <div className="chips">
          {(field.options ?? []).map(o => (
            <label key={String(o.value)} className={'chip' + (arr.some(x => x === o.value) ? ' on' : '')}>
              <input type="checkbox" checked={arr.some(x => x === o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (field.kind === 'tags') {
    const arr = Array.isArray(value) ? value : [];
    const text = arr.map(String).join(', ');
    return (
      <label className="fld">
        <span>{tr(field.label)}</span>
        <input type="text" value={text} placeholder={field.placeholder}
          onChange={e => onChange(e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean))} />
        {field.help && <FieldHelp text={field.help} />}
      </label>
    );
  }
  // string
  return (
    <label className="fld">
      <span>{tr(field.label)}</span>
      <input type="text" value={value === undefined || value === null ? '' : String(value)} placeholder={field.placeholder}
        onChange={e => onChange(e.target.value)} />
      {field.help && <FieldHelp text={field.help} />}
    </label>
  );
}

import {reorder} from './reorder';
import WindowsTaskForm, {type StageEntry} from './WindowsTaskForm';
import {RUN_ONLY_FIELDS, specFor} from './maaModel';
import {clientOf, compilePreset, defaultGui, DEFAULT_SETTINGS, inferSettings, isGuiTaskType, migrateTask, neutralContext, taskInactive, type Gui, type Migration, type PresetSettings} from './maaModel';

/** Windows-mode preset settings (Configurations.<cfg>.Gui.* equivalent). */
function PresetSettingsFields({settings, onChange, disabled}: {settings: PresetSettings; onChange: (s: PresetSettings) => void; disabled: boolean}) {
  const {t: tr} = useI18n();
  return <div className="preset-fields win-settings">
    <label className="check"><input type="checkbox" disabled={disabled} checked={settings.StartGame} onChange={e => onChange({...settings, StartGame: e.target.checked})} />{tr('开始唤醒时启动客户端')}</label>
    <label className="check"><input type="checkbox" disabled={disabled} checked={settings.ReportToPenguin} onChange={e => onChange({...settings, ReportToPenguin: e.target.checked})} />{tr('企鹅物流：上报掉落与公招数据')}</label>
    <label className="fld"><span>{tr('企鹅物流汇报 ID')}</span><input disabled={disabled || !settings.ReportToPenguin} value={settings.PenguinId} onChange={e => onChange({...settings, PenguinId: e.target.value})} /></label>
    <label className="check"><input type="checkbox" disabled={disabled} checked={settings.ReportToYituliu} onChange={e => onChange({...settings, ReportToYituliu: e.target.checked})} />{tr('一图流：上报掉落与公招数据')}</label>
  </div>;
}

/** Windows tri-state check boxes ticked for the next manual run only (scheduled runs never use them). */
function RunOnlyOptions({type, gui, value, onChange}: {type: string; gui: Gui; value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void}) {
  const {t: tr} = useI18n();
  const fields = RUN_ONLY_FIELDS[type] ?? [];
  const label = (key: string) => specFor(type as any).find(f => f.key === key)?.label ?? key;
  return <fieldset className="win-run-only"><legend>{tr('仅本次运行（不保存；定时运行不使用；运行后清除）')}</legend>
    {fields.map(key => {
      const saved = gui[key] === true;
      return <label className="check" key={key}>
        <input type="checkbox" checked={saved || value[key] === true} disabled={saved} onChange={e => onChange({...value, [key]: e.target.checked})} />
        <span>{tr(label(key))}{saved ? ' · ' + tr('已在配置中启用') : ''}</span>
      </label>;
    })}
    {type === 'Fight' && value.UseStone && <small>{tr('与 Windows 一致：本次使用源石时药剂数量按 999 计算并同时启用药剂')}</small>}
  </fieldset>;
}

/** Compiled Core params of one Windows-mode task, as saved (neutral: no date/history rules). */
function previewParams(doc: PresetDoc, index: number): unknown {
  try {
    const compiled = compilePreset(JSON.parse(serializePreset(doc)), neutralContext(clientOf(doc.client_type)));
    const r = compiled.reports.find(x => x.index === index)?.result;
    return r?.kind === 'append' ? r.params : r ? {[r.kind]: r.reason} : null;
  } catch (e: any) { return {error: e.message}; }
}

/** Lossless migration check of a raw task of a modelled type. */
function migrationOf(doc: PresetDoc, index: number): Migration | null {
  const task = doc.tasks[index];
  if (!task || task.gui || !isGuiTaskType(task.type)) return null;
  if (Array.isArray(task.variants) && task.variants.length && !taskInactive(task)) return null;
  const raw = {...doc, tasks: doc.tasks.map(({gui: _g, guiStale: _s, ...t}) => t)};
  const fights = doc.tasks.filter(t => t.type === 'Fight' && !taskInactive(t)).map(t => t.gui ?? migrateTask('Fight', t.params, clientOf(doc.client_type), inferSettings(raw)).gui);
  let params = task.params;
  if (task.type === 'StartUp' && doc.startup === true) params = {...params, start_game_enabled: true};
  return migrateTask(task.type, params, clientOf(doc.client_type), doc.settings ?? inferSettings(raw), task.type === 'Mall' ? fights : []);
}
export default function TaskConfig({ tasks, reloadTasks, submit, onBusyChange, runDisabledReason, deviceLabel, accountPolicy = 'require-verified' }: TaskConfigProps) {
  const {t: tr, locale} = useI18n();
  const drag=useRef<number|null>(null);
  const [drop,setDrop]=useState<number|null>(null);
  const [selected, setSelected] = useState<string>('');
  const [doc, setDoc] = useState<PresetDoc | null>(null);
  const [version, setVersion] = useState<string>('');
  const [mode, setMode] = useState<'visual' | 'raw'>('visual');
  const [rawDraft, setRawDraft] = useState('');
  const [taskIdx, setTaskIdx] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [mutating, setMutating] = useState(false);
  const mutatingRef = useRef(false);
  const [modal, setModal] = useState<null | { kind: 'new' | 'clone' | 'delete' }>(null);
  const [modalName, setModalName] = useState('');
  const [removeTask, setRemoveTask] = useState<number | null>(null);
  // Windows tri-state "this run only" (null) values: never saved, cleared after a run like ResetFightVariables.
  const [runOnly, setRunOnly] = useState<Record<string, Record<string, boolean>>>({});
  // Stage dropdown from the Manager (activity stages from the cached MAA API data); null → permanent table.
  const [stageList, setStageList] = useState<StageEntry[] | null>(null);
  const stageClient = doc?.client_type || 'Official';
  // Only needed while a Windows-mode Fight task is open.
  const needStages = !!doc?.tasks[taskIdx]?.gui && doc?.tasks[taskIdx]?.type === 'Fight';
  useEffect(() => {
    if (!needStages) return;
    let live = true;
    api('stages?client=' + encodeURIComponent(stageClient)).then(r => { if (live) setStageList(Array.isArray(r?.stages) ? r.stages : null); }).catch(() => { if (live) setStageList(null); });
    return () => { live = false; };
  }, [stageClient, needStages]);

  // Save/run/switch guards also cover clicks before React has rendered a state update.
  const stateRef = useRef({ doc, rawDraft, mode, version, selected });
  useEffect(() => { stateRef.current = { doc, rawDraft, mode, version, selected }; });
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const loadingRef = useRef(false);
  const runningRef = useRef(false);
  const notifyBusy = () => onBusyChange?.(dirtyRef.current || savingRef.current || loadingRef.current || runningRef.current || mutatingRef.current);
  const blocked = () => {
    if (!dirtyRef.current && !savingRef.current && !loadingRef.current && !runningRef.current && !mutatingRef.current) return false;
    setError(previous => previous || tr('有未保存的修改或操作进行中，请先保存成功后再继续'));
    return true;
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || savingRef.current || mutatingRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const [, setSaveFlag] = useState(0);

  const markDirty = () => { revisionRef.current++; dirtyRef.current = true; notifyBusy(); setSaveFlag(f => f + 1); };
  const patchDoc = (next: PresetDoc) => { stateRef.current = {...stateRef.current, doc: next}; setDoc(next); markDirty(); };

  const safe = async (fn: () => Promise<any>) => {
    try { setError(''); await fn(); } catch (e: any) { setError(e.message); }
  };

  const open = async (name: string) => {
    if (blocked()) return;
    loadingRef.current = true; notifyBusy();
    const revision = revisionRef.current;
    try { await safe(async () => {
      const t = await api('tasks/' + name);
      // An edit made while the request was pending takes priority over the response.
      if (revision !== revisionRef.current) return;
      // Unsupported documents stay available in raw mode, without normalization.
      let nextMode: 'raw' | 'visual' = 'visual';
      try { validateEditorRaw(t.raw); } catch { nextMode = 'raw'; }
      const nextDoc = parsePreset(t.raw);
      stateRef.current = {doc: nextDoc, rawDraft: t.raw, mode: nextMode, version: t.version, selected: name};
      setSelected(name); setVersion(t.version); setDoc(nextDoc); setRunOnly({});
      setRawDraft(t.raw); setTaskIdx(0); setMode(nextMode); setSaveStatus('');
    }); } finally { loadingRef.current = false; notifyBusy(); }
  };

  const run = async (name: string) => {
    if (runDisabledReason || !version || name !== selected) { setError(tr(runDisabledReason || '请先保存当前预设')); return; }
    if (blocked()) return;
    runningRef.current = true; notifyBusy();
    const picked = Object.fromEntries(Object.entries(runOnly).map(([i, o]) => [i, Object.fromEntries(Object.entries(o).filter(([, v]) => v))]).filter(([, o]) => Object.keys(o).length));
    try { await safe(async () => { await submit(name, Object.keys(picked).length ? picked : undefined); setRunOnly({}); }); }
    finally { runningRef.current = false; notifyBusy(); }
  };

  const createPreset = (name: string) => {
    if (blocked()) return;
    const id = slugify(name);
    const d: PresetDoc = {
      name,
      client_type: 'Official',
      startup: true,
      closedown: false,
      tasks: [{ name: tr('开始唤醒'), type: 'StartUp', params: {}, gui: defaultGui('StartUp') }],
    };
    setSelected(id);
    setVersion('');
    setDoc(d);
    setRawDraft(serializePreset(d));
    setTaskIdx(0);
    setMode('visual');
    stateRef.current = {doc: d, rawDraft: serializePreset(d), mode: 'visual', version: '', selected: id};
    setNotice(tr('新预设尚未保存，请点击保存'));
    markDirty();
  };

  const doClone = async (name: string) => {
    if (!doc || blocked()) return;
    mutatingRef.current = true; setMutating(true); notifyBusy();
    try { await safe(async () => {
      const id = slugify(name);
      const raw = serializePreset({ ...doc, name });
      const t = await api('tasks', 'POST', { name: id, raw });
      setNotice(tr('已复制为 {name}',{name:t.displayName || t.name}));
      await reloadTasks();
    }); } finally { mutatingRef.current = false; setMutating(false); notifyBusy(); }
  };

  const doDelete = async () => {
    if (blocked()) return;
    if (!selected) return;
    mutatingRef.current = true; setMutating(true); notifyBusy();
    try { await safe(async () => {
      await api('tasks/' + selected, 'DELETE', { version });
      dirtyRef.current = false;
      setDoc(null); setSelected(''); setVersion('');
      setNotice(tr('已删除'));
      await reloadTasks();
    }); } finally { mutatingRef.current = false; setMutating(false); notifyBusy(); }
  };

  const confirmModal = () => {
    const kind = modal?.kind;
    const name = modalName.trim();
    setModal(null);
    if (kind === 'new') { if (name) createPreset(name); }
    else if (kind === 'clone') { if (name) void doClone(name); }
    else if (kind === 'delete') { void doDelete(); }
  };

  const doSaveNow = async () => {
    const s = stateRef.current;
    const revision = revisionRef.current;
    if (!s.doc) return;
    const raw = s.mode === 'visual' ? serializePreset(s.doc) : s.rawDraft;
    validateEditorRaw(raw);
    const parsed = parsePreset(raw);
    if (parsed.tasks.length === 0) throw new Error(tr('任务列表不能为空，未保存'));
    for (const task of parsed.tasks) {
      if (task.type === 'Fight' && Object.hasOwn(task.params, 'medicine_expire_days')) {
        const days = task.params.medicine_expire_days;
        if (days && typeof days === 'object' && !Array.isArray(days)) continue; // Preserve opaque CLI templates.
        if (!Number.isInteger(days) || (days as number) < 0 || (days as number) > 2147483647) throw new Error(tr('临期药有效期必须为 0 到 2147483647 的整数天数'));
      }
    }
    const id = s.selected;
    const t = id && s.version
      ? await api('tasks/' + id, 'PUT', { name: id, raw, version: s.version })
      : await api('tasks', 'POST', { name: id || slugify(parsed.name || 'preset'), raw });
    dirtyRef.current = revisionRef.current !== revision;
    stateRef.current = {...stateRef.current, selected: t.name, version: t.version};
    setSelected(t.name);
    setVersion(t.version);
    const nd = parsePreset(t.raw);
    if (!dirtyRef.current) { stateRef.current = {...stateRef.current, doc: nd, rawDraft: t.raw}; setDoc(nd); setRawDraft(t.raw); }
    try { await reloadTasks(); } catch (e: any) { setNotice(tr('配置已保存，但列表刷新失败：{error}', {error: e.message})); }
  };

  const runSave = async () => {
    if (savingRef.current || loadingRef.current || runningRef.current || mutatingRef.current) return;
    savingRef.current = true; notifyBusy();
    setSaving(true);
    setError('');
    setSaveStatus(tr('保存中…'));
    let succeeded = false;
    try {
      await doSaveNow();
      succeeded = true;
      setSaveStatus(tr('已保存 {time}',{time:new Date().toLocaleTimeString(locale==='ja'?'ja-JP':'zh-CN', { timeZone: serverTimeZone() })}));
    } catch (e: any) {
      setError(e.message);
      setSaveStatus(tr('保存失败'));
    } finally {
      savingRef.current = false; notifyBusy();
      setSaving(false);
      if (succeeded && dirtyRef.current) setSaveFlag(f => f + 1);
    }
  };

  // Explicit save: editing a shared preset must not silently persist changes.

  const updateTask = (patch: Partial<TaskEntry>) => {
    if (!doc) return;
    const tasks = doc.tasks.slice();
    tasks[taskIdx] = { ...tasks[taskIdx], ...patch };
    patchDoc({ ...doc, tasks });
  };

  const updateGui = (gui: Gui) => {
    if (!doc) return;
    const tasks = doc.tasks.slice();
    tasks[taskIdx] = { ...tasks[taskIdx], gui };
    patchDoc({ ...doc, tasks });
  };

  const updateParam = (key: string, v: unknown) => {
    if (!doc) return;
    const tasks = doc.tasks.slice();
    tasks[taskIdx] = { ...tasks[taskIdx], params: { ...tasks[taskIdx].params, [key]: v } };
    patchDoc({ ...doc, tasks });
  };

  const addTask = (type: string) => {
    if (!doc) return;
    const def = getTaskType(type);
    // Task types with a Windows model start in Windows mode with the Windows defaults.
    const entry: TaskEntry = isGuiTaskType(type) ? { name: def?.label || type, type, params: {}, gui: defaultGui(type) } : { name: def?.label || type, type, params: {} };
    patchDoc({ ...doc, tasks: [...doc.tasks, entry] });
    setTaskIdx(doc.tasks.length);
  };

  const moveTask = (from: number, to: number) => {
    if (!doc || to < 0 || to >= doc.tasks.length) return;
    const moved=reorder(doc.tasks,from,to,taskIdx);
    if(moved.items===doc.tasks)return;
    patchDoc({ ...doc, tasks:moved.items });
    setTaskIdx(moved.selected);
  };

  const task = doc?.tasks[taskIdx];
  const taskDef = task ? getTaskType(task.type) : undefined;
  const { form } = task ? deserializeParams(task.type, task.params) : { form: {} as Record<string, unknown> };

  const presetName = (t: any) => t.displayName || t.name || t.file;
  const basic = taskDef ? basicFields(taskDef.type, taskDef.fields) : [];
  const advanced = taskDef?.fields.filter(f => !basic.includes(f)) ?? [];
  const renderField = (f: FieldDef) => fieldEditable(f, form[f.key])
    ? <FieldControl key={`${taskIdx}-${f.key}`} field={f} value={form[f.key]} onChange={v => updateParam(f.key, v)} />
    : <div className="fld" key={f.key}><span>{tr(f.label)}</span><small>{tr('复杂值已保留，请使用原始 JSON 编辑')}</small><code>{JSON.stringify(form[f.key])}</code></div>;

  return (
    <div className="classic-editor">
      <section className="panel editor-context" aria-label={tr('配置上下文')}>
        <div><span className="eyebrow">TASK WORKBENCH</span><h2>{tr('任务配置')}</h2><small>{tr('当前访问：入口认证 · 共享工作区')}</small></div>
        <label className="fld"><span>{tr('当前预设')}</span><select aria-label={tr('当前预设')} value={selected} onChange={e => void open(e.target.value)}>
          <option value="" disabled>{tr('选择预设')}</option>
          {selected && !tasks.some(t => t.name === selected) && <option value={selected}>{doc?.name || selected} · {tr('未保存')}</option>}
          {tasks.map(t => <option key={t.name || t.file} value={t.name} disabled={!t.editable}>{presetName(t)}{!t.editable ? ' · JSON only' : ''}</option>)}
        </select></label>
        <div className="context-device"><small>{tr('当前设备')}</small><strong>{deviceLabel}</strong></div>
        <button onClick={() => { if (!blocked()) { setModal({kind:'new'}); setModalName(''); } }}>{tr('新建预设')}</button>
      </section>
      {error && <div role="alert" className="alert">{error}<button onClick={() => setError('')}>{tr('关闭')}</button></div>}
      {notice && <div role="status" className="notice">{notice}</div>}
      {!doc ? <section className="panel editor-empty"><h3>{tr('选择一套预设开始配置')}</h3><p className="muted">{tr('任务顺序、参数和原始 JSON 将在同一处管理。')}</p></section> : (
        <section className="panel classic-preset">
          {accountPolicy === 'warn-continue' && <p className="notice" role="status">{tr('账号身份兼容模式（全局）：带 account_name 的预设会在开始唤醒完成后继续执行，但不会验证当前登录账号；存在任务作用在旧账号上的风险。这是显式配置的风险模式，不代表身份已验证；可改为 require-verified 关闭。')}</p>}
          <fieldset disabled={mutating || saving} className="editor-fieldset">
            <div className="preset-fields editor-preset-fields">
              <label className="fld"><span>{tr('预设显示名')}</span><input value={doc.name || ''} disabled={mode === 'raw'} onChange={e => patchDoc({...doc, name:e.target.value})} /></label>
              <label className="fld"><span>{tr('客户端版本')}</span><select value={doc.client_type || ''} disabled={mode === 'raw'} onChange={e => patchDoc({...doc, client_type:e.target.value})}>
                <option value="">{tr('未指定（由 CLI 推断）')}</option>
                {!['', 'Official','Bilibili','txwy','YoStarEN','YoStarJP','YoStarKR'].includes(doc.client_type || '') && <option value={doc.client_type}>{doc.client_type}</option>}
                <option value="Official">{tr('官方服 Official')}</option><option value="Bilibili">{tr('B 服 Bilibili')}</option><option value="txwy">{tr('繁中服 txwy')}</option><option value="YoStarEN">{tr('国际服 YoStarEN')}</option><option value="YoStarJP">{tr('日服 YoStarJP')}</option><option value="YoStarKR">{tr('韩服 YoStarKR')}</option>
              </select></label>
              <label className="check"><input type="checkbox" disabled={mode === 'raw'} checked={!!doc.startup} onChange={e => patchDoc({...doc, startup:e.target.checked})} />{tr('自动启动游戏')}</label>
              <label className="check"><input type="checkbox" disabled={mode === 'raw'} checked={!!doc.closedown} onChange={e => patchDoc({...doc, closedown:e.target.checked})} />{tr('结束后关闭游戏')}</label>
            </div>
            <div className="editor-mode"><div className="seg" aria-label={tr('编辑模式')}>
              <button aria-pressed={mode === 'visual'} className={mode === 'visual' ? 'on' : ''} onClick={() => { if (mode === 'visual') return; try { validateEditorRaw(rawDraft); const next = parsePreset(rawDraft); stateRef.current = {...stateRef.current, doc:next, mode:'visual'}; setDoc(next); setMode('visual'); setTaskIdx(0); } catch(e:any) { setError(e.message); } }}>{tr('可视化')}</button>
              <button aria-pressed={mode === 'raw'} className={mode === 'raw' ? 'on' : ''} onClick={() => { if (mode === 'raw') return; const raw = serializePreset(doc); stateRef.current = {...stateRef.current, rawDraft:raw, mode:'raw'}; setRawDraft(raw); setMode('raw'); }}>{tr('原始 JSON')}</button>
            </div><small>{tr('取消勾选保留配置；删除会移除整个任务。')}</small></div>
            {mode === 'raw' ? <textarea className="preset-json" spellCheck={false} value={rawDraft} onChange={e => { stateRef.current = {...stateRef.current, rawDraft:e.target.value}; setRawDraft(e.target.value); markDirty(); }} aria-label={tr('任务 JSON')} /> : (
              <div className="classic-workbench">
                <aside className="classic-task-list" aria-label={tr('任务执行顺序')}>
                  <div className="panel-title"><h3>{tr('任务列表')} <small>{doc.tasks.length}</small></h3></div>
                  <p className="muted">{tr('从上到下执行 · 拖动或使用箭头排序')}</p>
                  {doc.tasks.map((entry, i) => (
                    <div className={'classic-task-row' + (i === taskIdx ? ' selected' : '') + (taskDisabled(entry) ? ' is-disabled' : '') + (drop === i ? ' drop-target' : '')} key={i}
                      onDragOver={e => { if (drag.current !== null) { e.preventDefault(); e.dataTransfer.dropEffect='move'; setDrop(i); } }}
                      onDrop={e => { e.preventDefault(); if (drag.current !== null) moveTask(drag.current,i); drag.current=null; setDrop(null); }}>
                      <button className="drag-handle" draggable aria-label={tr('拖动排序 {name}',{name:entry.name || entry.type})} onDragStart={e => { drag.current=i; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',String(i)); }} onDragEnd={() => { drag.current=null; setDrop(null); }}>⠿</button>
                      <input type="checkbox" aria-label={tr('启用任务 {name}',{name:entry.name || entry.type})} checked={!taskDisabled(entry)} disabled={!taskDisabled(entry) && !!toggleBlock(doc,entry)} title={tr(toggleBlock(doc,entry) || '启用或禁用任务，配置仍会保留')} onChange={e => { try { patchDoc(setTaskEnabled(doc,i,e.target.checked)); } catch(err:any) { setError(err.message); } }} />
                      <button className="task-choice" aria-pressed={i === taskIdx} onClick={() => setTaskIdx(i)}><span>{entry.name || entry.type}</span><small>{tr(getTaskType(entry.type)?.label || entry.type)}{taskDisabled(entry) ? ' · ' + tr('已禁用') : Array.isArray(entry.variants) && entry.variants.length ? ' · ' + tr('条件任务') : ''}</small></button>
                      <button className="task-gear" aria-label={tr('设置 {name}',{name:entry.name || entry.type})} onClick={() => setTaskIdx(i)}>⚙</button>
                    </div>
                  ))}
                  <label className="fld"><span className="sr-only">{tr('添加任务')}</span><select aria-label={tr('添加任务')} value="" onChange={e => { if(e.target.value) addTask(e.target.value); }}><option value="" disabled>{tr('＋ 添加任务')}</option>{TASK_TYPES.map(t => <option key={t.type} value={t.type}>{tr(t.label)}</option>)}</select></label>
                  <small>{tr('禁用状态保存后同样适用于已有排程。')}</small>
                </aside>
                <div className="classic-task-detail" key={taskIdx}>
                  {!task ? <p className="muted">{tr('请添加一个任务。')}</p> : <>
                    <div className="panel-title"><div><span className="eyebrow">{task.type}</span><h3>{tr(taskDef?.label || task.type)}</h3></div><div className="task-tools">
                      <button aria-label={tr('上移任务')} disabled={taskIdx === 0} onClick={() => moveTask(taskIdx,taskIdx-1)}>↑</button>
                      <button aria-label={tr('下移任务')} disabled={taskIdx === doc.tasks.length-1} onClick={() => moveTask(taskIdx,taskIdx+1)}>↓</button>
                      <button onClick={() => { patchDoc(duplicateTask(doc,taskIdx,tr(' 副本'))); setTaskIdx(taskIdx+1); }}>{tr('复制任务')}</button>
                      <button className="danger" onClick={() => setRemoveTask(taskIdx)}>{tr('删除任务')}</button>
                    </div></div>
                    {taskDisabled(task) && <p className="notice">{tr('此任务已禁用，参数仍保留。保存后不会执行此任务。')}</p>}
                    {toggleBlock(doc,task) && <p className="muted">{tr(toggleBlock(doc,task))}</p>}
                    {startupNotices(doc,task,accountPolicy).map(text => <p className="notice" key={text}>{tr(text)}</p>)}
                    {task.type === 'StartUp' && <p className="muted">{tr('切换账号填写游戏已记忆的登录名，留空保持当前账号；指定账号时必须放在首个任务。开始唤醒完成只代表任务链结束，不代表身份已验证：Manager 无法确认当前账号时不会继续执行账号专属任务（当前 fail-closed）。')}</p>}
                    <label className="fld"><span>{tr('任务名称')}</span><input value={task.name || ''} onChange={e => updateTask({name:e.target.value})} /></label>
                    {task.gui ? <>
                      <p className="muted">{tr('Windows 模式：选项与 MAA Windows 版一致，运行时由 Manager 生成 Core 参数（含周计划、备选关卡等规则）。')}</p>
                      {doc.tasks.some(t => t.gui) && <details className="advanced-params" open={false}><summary>{tr('预设设置（Windows 模式任务共用）')}</summary>
                        <PresetSettingsFields settings={doc.settings ?? DEFAULT_SETTINGS} disabled={false} onChange={settings => patchDoc({...doc, settings})} /></details>}
                      <WindowsTaskForm type={task.type as any} gui={task.gui} client={clientOf(doc.client_type)} onChange={updateGui} stages={stageList} />
                      {RUN_ONLY_FIELDS[task.type] && <RunOnlyOptions type={task.type} gui={task.gui} value={runOnly[String(taskIdx)] ?? {}} onChange={v => setRunOnly({...runOnly, [String(taskIdx)]: v})} />}
                      <details className="advanced-params"><summary>{tr('生成的 Core 参数（保存时的中性预览，不含日期和历史相关规则）')}</summary><pre>{JSON.stringify(previewParams(doc, taskIdx), null, 2)}</pre></details>
                      <button onClick={() => { const tasks = doc.tasks.slice(); const {gui: _g, ...rest} = tasks[taskIdx]; tasks[taskIdx] = rest as TaskEntry; patchDoc({...doc, tasks}); }}>{tr('切换为原始参数模式')}</button>
                    </> : <>
                    {task.guiStale && <p className="notice">{tr('参数已在 Windows 模式之外被修改，此任务按原始参数运行；Windows 模式配置未被使用。')}</p>}
                    {(() => { const m = migrationOf(doc, taskIdx); return m && <div className="notice win-migrate">
                      {m.lossless
                        ? <><span>{tr('可无损转换为 Windows 模式（生成的参数与当前参数对 MaaCore 等效）。')}</span> <button onClick={() => { const tasks = doc.tasks.slice(); tasks[taskIdx] = {...tasks[taskIdx], gui: m.gui}; patchDoc({...doc, tasks, settings: doc.settings ?? inferSettings({...doc, tasks: doc.tasks.map(({gui: _g, guiStale: _s, ...t}) => t)})}); }}>{tr('转换为 Windows 模式')}</button></>
                        : <><span>{tr('转换为 Windows 模式会改变以下参数，因此保持原始参数模式：')}</span><ul>{m.differences.map(d => <li key={d.key}><code>{d.key}</code>: {JSON.stringify(d.before)} → {JSON.stringify(d.after)}</li>)}</ul></>}
                    </div>; })()}
                    <h4>{tr('基础配置')}</h4><div className="param-grid">{basic.map(renderField)}</div>
                    {!taskDef && <p className="muted">{tr('此任务类型暂不支持可视化编辑；所有字段已保留，可在原始 JSON 中编辑。')}</p>}
                    {taskDef?.fields.length === 0 && <p className="muted">{tr('该任务无额外参数。')}</p>}
                    <details className="advanced-params"><summary>{tr('高级配置')} · {advanced.length}</summary><div className="param-grid">{advanced.map(renderField)}</div><p className="muted">{tr('条件、变体与未知字段保持原样；使用顶部原始 JSON 编辑完整配置。')}</p><pre>{JSON.stringify(Object.fromEntries(Object.entries(task).filter(([key]) => !['type','name','params'].includes(key))),null,2)}</pre></details>
                    <p className="muted">{tr('未展示的参数也会原样保存。')}</p>
                    </>}
                  </>}
                </div>
              </div>
            )}
            <div className="actions editor-actions">
              <button className="primary" disabled={saving || !dirtyRef.current} onClick={() => void runSave()}>{saving ? tr('保存中…') : tr('保存')}</button>
              <span className={dirtyRef.current ? 'dirty-state' : 'muted'} role="status">{dirtyRef.current ? tr('有未保存的修改') : saveStatus || tr('未修改')}{saveStatus === tr('保存失败') ? ' · ' + saveStatus : ''}</span>
              <small>{tr('运行使用最后成功保存的版本')} {version ? version.slice(0,12) : '—'}</small>
              <span className="sp" />
              {selected && version && <button onClick={() => { if (!blocked()) { setModal({kind:'clone'}); setModalName((doc.name || selected)+tr(' 副本')); } }}>{tr('复制预设')}</button>}
              {selected && version && <button className="danger" onClick={() => { if (!blocked()) setModal({kind:'delete'}); }}>{tr('删除预设')}</button>}
              <button disabled={!!runDisabledReason || !version || dirtyRef.current || saving} title={tr(runDisabledReason || (dirtyRef.current ? '请先保存当前预设' : '运行使用最后成功保存的版本'))} onClick={() => void run(selected)}>{tr('运行')}</button>
            </div>
            {runDisabledReason && <p className="muted" role="status">{tr(runDisabledReason)}</p>}
          </fieldset>
        </section>
      )}
      <Modal open={removeTask !== null} title={tr('删除任务')} onClose={() => setRemoveTask(null)}>
        <p>{tr('删除会移除任务及其全部参数；如果只是暂不运行，请取消勾选。')}</p>
        <div className="actions"><button className="danger" onClick={() => { if (doc && removeTask !== null) { patchDoc({...doc,tasks:doc.tasks.filter((_,i) => i !== removeTask)}); setTaskIdx(Math.max(0,removeTask-1)); } setRemoveTask(null); }}>{tr('删除任务')}</button><button onClick={() => setRemoveTask(null)}>{tr('取消')}</button></div>
      </Modal>

      <Modal open={!!modal} title={modal?.kind === 'delete' ? tr('删除预设') : (modal?.kind === 'clone' ? tr('复制预设') : tr('新建预设'))} onClose={() => setModal(null)}>
        {modal?.kind === 'delete' ? (
          <div>
            <p>{tr('确定删除预设「{name}」？此操作不可撤销。',{name:doc?.name || selected})}</p>
            <div className="actions">
              <button className="danger" onClick={confirmModal}>{tr('删除')}</button>
              <button onClick={() => setModal(null)}>{tr('取消')}</button>
            </div>
          </div>
        ) : (
          <div>
            <label className="fld">
              <span>{tr('预设显示名')}</span>
              <input autoFocus value={modalName} onChange={e => setModalName(e.target.value)} placeholder={tr('如：日常挂机 / 剿灭作战')} onKeyDown={e => { if (e.key === 'Enter') confirmModal(); }} />
            </label>
            <div className="actions">
              <button className="primary" onClick={confirmModal}>{tr('确定')}</button>
              <button onClick={() => setModal(null)}>{tr('取消')}</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
