import {attachGuis, DEFAULT_SETTINGS, readGuis, readSettings, staleGuis, type Gui, type PresetSettings} from './maaModel';
// Task-type schema that drives the visual configuration form.
// Field definitions mirror the MAA integration protocol (docs.maa.plus).
// Unknown params (not listed here) are preserved verbatim through `extra`.

export type FieldKind = 'boolean' | 'number' | 'string' | 'select' | 'multi-select' | 'tags' | 'stage';

export interface FieldOption {
  value: string | number;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: FieldOption[];
  default?: unknown;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Omit this field from output when its value is empty ('' / [] / null). */
  omitEmpty?: boolean;
}

export interface TaskTypeDef {
  type: string;
  label: string;
  description?: string;
  fields: FieldDef[];
}

const CLIENT_TYPES: FieldOption[] = [
  { value: 'Official', label: '官方服 Official' },
  { value: 'Bilibili', label: 'B 服 Bilibili' },
  { value: 'txwy', label: '繁中服 txwy' },
  { value: 'YoStarEN', label: '国际服 YoStarEN' },
  { value: 'YoStarJP', label: '日服 YoStarJP' },
  { value: 'YoStarKR', label: '韩服 YoStarKR' },
];

const SERVERS: FieldOption[] = [
  { value: 'CN', label: '国服 CN' },
  { value: 'US', label: '美服 US' },
  { value: 'JP', label: '日服 JP' },
  { value: 'KR', label: '韩服 KR' },
];

const clientType: FieldDef = {
  key: 'client_type', label: '客户端版本', kind: 'select', options: CLIENT_TYPES,
  default: '', omitEmpty: true,
  help: '留空则继承预设顶部的客户端版本设置',
};

export const TASK_TYPES: TaskTypeDef[] = [
  {
    type: 'StartUp', label: '开始唤醒',
    description: '启动游戏客户端并进入主界面',
    fields: [
      clientType,
      { key: 'start_game_enabled', label: '自动启动客户端', kind: 'boolean', default: false },
      { key: 'account_name', label: '切换账号（登录名）', kind: 'string', default: '', omitEmpty: true, placeholder: '留空不切换' },
    ],
  },
  {
    type: 'CloseDown', label: '关闭游戏',
    description: '关闭游戏客户端',
    fields: [clientType],
  },
  {
    type: 'Fight', label: '理智作战',
    description: '刷取指定关卡',
    fields: [
      { key: 'stage', label: '关卡', kind: 'stage', default: '', omitEmpty: true, placeholder: '如 1-7 / PR-A-1 / SSReopen-IC', options: [
        { value: '', label: '识别当前/上次' },
        { value: 'Annihilation', label: '当期剿灭' },
        { value: 'Chernobog@Annihilation', label: '切尔诺伯格剿灭' },
        { value: 'LungmenOutskirts@Annihilation', label: '龙门外环剿灭' },
        { value: 'LungmenDowntown@Annihilation', label: '龙门市区剿灭' },
        { value: 'CE-6', label: '龙门币 CE-6' },
        { value: 'LS-6', label: '作战记录 LS-6' },
        { value: 'CA-5', label: '技能书 CA-5' },
        { value: 'AP-5', label: '采购凭证 AP-5' },
        { value: 'SK-5', label: '碳 SK-5' },
      ], help: '当期剿灭按本周合成玉上限停止。留空＝跟随游戏「上次作战」，因此会自动跟着你当前在刷的关卡（含活动关）；若这次未能用尽理智（该记忆会被剿灭作战改写成剿灭地图，或关卡已失效），仅当本任务为唯一无限理智作战（次数 2147483647）、位于最后一个 Fight、未设置药品/源石/掉落目标且无条件或变体时，管理器才会用记住的/兜底关卡（默认 LS-6）重试一次。有限次数及含糊配置不会自动重试。此处填明确关卡则始终用它，不做自动跟随与重试。' },
      { key: 'medicine', label: '理智药最大使用数', kind: 'number', default: 0, min: 0 },
      { key: 'medicine_expire_days', label: '临期理智药有效期（天）', kind: 'number', default: 0, min: 0, help: '使用有效期不超过此天数的理智药，0 表示不使用临期药；这不是数量上限。旧 expiring_medicine 非零等效 2 天；medicine_expire_days 优先，旧键保持原样，只有修改本控件才写入新键。条件、变体或输入模板可能覆盖基础值，请在原始 JSON 中检查。' },
      { key: 'stone', label: '碎石（源石）数量', kind: 'number', default: 0, min: 0 },
      { key: 'times', label: '战斗次数', kind: 'number', default: 2147483647, min: 0 },
      { key: 'series', label: '连战次数', kind: 'number', default: 1, min: -1, max: 10, help: '未配置时 MAA 默认 1；明确填 0 才自动选择当前可用最大倍率（不足时按 MAA 规则降档）；国服 1~10，旧外服 1~6；-1 不切换。与总战斗次数不同。注意：自动（0）依赖 MAA 识别游戏内连战图标，识别失败或该关卡不支持连战时 MAA 会静默按 1 倍执行；填固定倍率则理智不足一次满倍时会直接结束任务。' },
      { key: 'server', label: '服务器', kind: 'select', options: SERVERS, default: 'CN' },
      clientType,
      { key: 'DrGrandet', label: '节省理智碎石模式', kind: 'boolean', default: false },
      { key: 'report_to_penguin', label: '汇报企鹅数据', kind: 'boolean', default: false },
      { key: 'penguin_id', label: '企鹅数据汇报 ID', kind: 'string', default: '', omitEmpty: true },
      { key: 'report_to_yituliu', label: '汇报一图流数据', kind: 'boolean', default: false },
      { key: 'yituliu_id', label: '一图流汇报 ID', kind: 'string', default: '', omitEmpty: true },
    ],
  },
  {
    type: 'Recruit', label: '公开招募',
    description: '自动识别并招募干员',
    fields: [
      { key: 'refresh', label: '刷新三星 Tags', kind: 'boolean', default: false },
      { key: 'select', label: '点击标签的 Tag 等级', kind: 'multi-select', options: tagLevels(), default: [] },
      { key: 'confirm', label: '确认招募的 Tag 等级', kind: 'multi-select', options: tagLevels(), default: [] },
      { key: 'first_tags', label: '首选 Tags（逗号分隔）', kind: 'tags', default: [], omitEmpty: true, placeholder: '如：高级资深干员' },
      { key: 'extra_tags_mode', label: '额外 Tags 模式', kind: 'select', options: [
        { value: 0, label: '0 - 默认行为' },
        { value: 1, label: '1 - 选 3 个 Tags' },
        { value: 2, label: '2 - 尽可能多选高星组合' },
      ], default: 0 },
      { key: 'times', label: '招募次数', kind: 'number', default: 0, min: 0 },
      { key: 'set_time', label: '设置招募时限', kind: 'boolean', default: true },
      { key: 'expedite', label: '使用加急许可', kind: 'boolean', default: false },
      { key: 'skip_robot', label: '识别到小车词条时跳过', kind: 'boolean', default: true },
      { key: 'server', label: '服务器', kind: 'select', options: SERVERS, default: 'CN' },
    ],
  },
  {
    type: 'Infrast', label: '基建换班',
    description: '自动进行基建排班',
    fields: [
      { key: 'mode', label: '换班模式', kind: 'select', options: [
        { value: 0, label: '默认（单设施最优）' },
        { value: 10000, label: '自定义（读取配置文件）' },
        { value: 20000, label: '一键轮换' },
      ], default: 0 },
      { key: 'facility', label: '要换班的设施', kind: 'multi-select', options: [
        { value: 'Mfg', label: '制造站' }, { value: 'Trade', label: '贸易站' },
        { value: 'Power', label: '发电站' }, { value: 'Control', label: '控制中枢' },
        { value: 'Reception', label: '会客室' }, { value: 'Office', label: '办公室' },
        { value: 'Dorm', label: '宿舍' }, { value: 'Processing', label: '加工站' },
        { value: 'Training', label: '训练室' },
      ], default: ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm', 'Processing', 'Training'], help: '必选至少一项；一键轮换模式会自动跳过发电站/中枢/宿舍/办公室' },
      { key: 'drones', label: '无人机用途', kind: 'select', options: [
        { value: '_NotUse', label: '不使用' }, { value: 'Money', label: '龙门币' },
        { value: 'SyntheticJade', label: '合成玉' }, { value: 'CombatRecord', label: '作战记录' },
        { value: 'PureGold', label: '赤金' }, { value: 'OriginStone', label: '源石碎片' },
        { value: 'Chip', label: '芯片' },
      ], default: '_NotUse' },
      { key: 'threshold', label: '工作心情阈值', kind: 'number', default: 0.3, min: 0, max: 1, step: 0.1 },
      { key: 'replenish', label: '贸易站源石碎片自动补货', kind: 'boolean', default: false },
      { key: 'dorm_notstationed_enabled', label: '宿舍「未进驻」选项', kind: 'boolean', default: false },
      { key: 'dorm_trust_enabled', label: '宿舍填入信赖未满干员', kind: 'boolean', default: false },
      { key: 'reception_message_board', label: '领取会客室信息板信用', kind: 'boolean', default: true },
      { key: 'reception_clue_exchange', label: '线索交流', kind: 'boolean', default: true },
      { key: 'reception_send_clue', label: '赠送线索', kind: 'boolean', default: true },
      { key: 'filename', label: '自定义配置路径', kind: 'string', default: '', omitEmpty: true, placeholder: '如 schedules/base.json', help: '仅在自定义模式生效' },
      { key: 'plan_index', label: '方案序号', kind: 'number', default: 0, min: 0, help: '仅在自定义模式生效' },
    ],
  },
  {
    type: 'Mall', label: '信用购物',
    description: '访问好友、领取信用并购物',
    fields: [
      { key: 'visit_friends', label: '访问好友基建', kind: 'boolean', default: true },
      { key: 'shopping', label: '购物', kind: 'boolean', default: true },
      { key: 'buy_first', label: '优先购买（逗号分隔）', kind: 'tags', default: [], omitEmpty: true, placeholder: '如：招聘许可,龙门币' },
      { key: 'blacklist', label: '购物黑名单（逗号分隔）', kind: 'tags', default: [], omitEmpty: true, placeholder: '如：加急许可' },
      { key: 'force_shopping_if_credit_full', label: '信用溢出时无视黑名单', kind: 'boolean', default: false },
      { key: 'only_buy_discount', label: '只买折扣物品', kind: 'boolean', default: false },
      { key: 'reserve_max_credit', label: '信用低于 300 时停止购买', kind: 'boolean', default: false },
      { key: 'credit_fight', label: '借战打 OF-1 刷信用', kind: 'boolean', default: false },
      { key: 'formation_index', label: 'OF-1 编队栏位', kind: 'number', default: 0, min: 0, max: 4 },
    ],
  },
  {
    type: 'Award', label: '领取奖励',
    description: '领取每日/每周/邮件等奖励',
    fields: [
      { key: 'award', label: '领取每日/每周任务奖励', kind: 'boolean', default: true },
      { key: 'mail', label: '领取所有邮件奖励', kind: 'boolean', default: false },
      { key: 'recruit', label: '领取每日免费单抽', kind: 'boolean', default: false },
      { key: 'orundum', label: '领取幸运墙合成玉', kind: 'boolean', default: false },
      { key: 'mining', label: '领取限时开采许可', kind: 'boolean', default: false },
      { key: 'specialaccess', label: '领取月卡奖励', kind: 'boolean', default: false },
    ],
  },
  {
    type: 'Roguelike', label: '自动肉鸽',
    description: '无限刷肉鸽（集成战略）',
    fields: [
      { key: 'theme', label: '主题', kind: 'select', options: [
        { value: 'Phantom', label: '傀影与猩红血钻' }, { value: 'Mizuki', label: '水月与深蓝之树' },
        { value: 'Sami', label: '探索者的银凇止境' }, { value: 'Sarkaz', label: '萨卡兹的无终奇语' },
        { value: 'JieGarden', label: '岁的界园志异' },
      ], default: 'Phantom' },
      { key: 'mode', label: '模式', kind: 'select', options: [
        { value: 0, label: '0 - 刷分/奖励点数' }, { value: 1, label: '1 - 刷源石锭' },
        { value: 4, label: '4 - 凹开局' }, { value: 5, label: '5 - 刷坍缩范式' },
        { value: 6, label: '6 - 刷月度小队' }, { value: 7, label: '7 - 刷深入调查' },
      ], default: 0 },
      { key: 'squad', label: '开局分队', kind: 'string', default: '指挥分队', omitEmpty: true },
      { key: 'roles', label: '开局职业组', kind: 'string', default: '取长补短', omitEmpty: true },
      { key: 'core_char', label: '开局干员名', kind: 'string', default: '', omitEmpty: true, placeholder: '留空自动选择' },
      { key: 'use_support', label: '开局干员为助战', kind: 'boolean', default: false },
      { key: 'use_nonfriend_support', label: '允许非好友助战', kind: 'boolean', default: false },
      { key: 'starts_count', label: '开始探索次数', kind: 'number', default: 2147483647, min: 1 },
      { key: 'difficulty', label: '难度等级', kind: 'number', default: 0, min: 0 },
      { key: 'stop_at_final_boss', label: '第 5 层险路恶敌前停止', kind: 'boolean', default: false },
      { key: 'stop_at_max_level', label: '等级刷满后停止', kind: 'boolean', default: false },
      { key: 'investment_enabled', label: '投资源石锭', kind: 'boolean', default: true },
      { key: 'investments_count', label: '投资次数', kind: 'number', default: 2147483647, min: 0 },
      { key: 'stop_when_investment_full', label: '投资满后停止', kind: 'boolean', default: false },
      { key: 'start_with_elite_two', label: '凹精二直升', kind: 'boolean', default: false },
    ],
  },
  {
    type: 'Reclamation', label: '生息演算',
    description: '生息演算自动刷取',
    fields: [
      { key: 'theme', label: '主题', kind: 'select', options: [
        { value: 'Fire', label: '沙中之火' }, { value: 'Tales', label: '沙洲遗闻' },
      ], default: 'Fire' },
      { key: 'mode', label: '模式', kind: 'select', options: [
        { value: 0, label: '0 - 刷分与建造点' }, { value: 1, label: '1 - 刷赤金/货币' },
      ], default: 0 },
      { key: 'tools_to_craft', label: '自动制造物品（逗号分隔）', kind: 'tags', default: [], omitEmpty: true, placeholder: '如：荧光棒' },
      { key: 'increment_mode', label: '点击类型', kind: 'select', options: [
        { value: 0, label: '0 - 连点' }, { value: 1, label: '1 - 长按' },
      ], default: 0 },
      { key: 'num_craft_batches', label: '单次最大制造轮数', kind: 'number', default: 16, min: 1 },
    ],
  },
  {
    type: 'Copilot', label: '自动抄作业',
    description: '按作业 JSON 自动战斗',
    fields: [
      { key: 'filename', label: '作业文件路径', kind: 'string', default: '', placeholder: '如 copilot/1-7.json' },
      { key: 'loop_times', label: '循环次数', kind: 'number', default: 1, min: 1 },
      { key: 'use_sanity_potion', label: '理智不足时使用理智药', kind: 'boolean', default: false },
      { key: 'formation', label: '自动编队', kind: 'boolean', default: false },
      { key: 'formation_index', label: '编队栏位', kind: 'number', default: 0, min: 0, max: 4 },
      { key: 'add_trust', label: '以信赖升序填充空位', kind: 'boolean', default: false },
      { key: 'ignore_requirements', label: '忽视干员属性要求', kind: 'boolean', default: false },
      { key: 'support_unit_usage', label: '助战干员模式', kind: 'select', options: [
        { value: 0, label: '0 - 不使用' }, { value: 1, label: '1 - 缺员时补齐' },
        { value: 2, label: '2 - 缺员补齐或指定助战' }, { value: 3, label: '3 - 随机助战' },
      ], default: 0 },
      { key: 'support_unit_name', label: '指定助战干员名', kind: 'string', default: '', omitEmpty: true },
    ],
  },
  {
    type: 'SSSCopilot', label: '保全派驻',
    description: '自动抄保全作业',
    fields: [
      { key: 'filename', label: '作业文件路径', kind: 'string', default: '', placeholder: '如 sss/plan.json' },
      { key: 'loop_times', label: '循环次数', kind: 'number', default: 1, min: 1 },
    ],
  },
  {
    type: 'ParadoxCopilot', label: '悖论模拟',
    description: '自动抄悖论模拟作业',
    fields: [
      { key: 'filename', label: '作业文件路径', kind: 'string', default: '', placeholder: '如 paradox/exusiai.json' },
    ],
  },
  {
    type: 'Depot', label: '仓库识别',
    description: '识别仓库物品',
    fields: [],
  },
  {
    type: 'OperBox', label: '干员识别',
    description: '识别干员 box',
    fields: [],
  },
  {
    type: 'SwitchTheme', label: '更换主题',
    description: '更换游戏主界面主题',
    fields: [
      { key: 'themes', label: '主题名（逗号分隔）', kind: 'tags', default: [] },
    ],
  },
  {
    type: 'Custom', label: '自定义任务',
    description: '执行指定任务名（及后续 next）',
    fields: [
      { key: 'task_names', label: '任务名（逗号分隔）', kind: 'tags', default: [], placeholder: '如：StartUp,Infrast,Fight' },
    ],
  },
  {
    type: 'SingleStep', label: '单步任务',
    description: '单步作战（高级，建议用原始 JSON）',
    fields: [
      { key: 'type', label: '类型', kind: 'string', default: 'copilot' },
      { key: 'subtask', label: '子任务', kind: 'string', default: '', omitEmpty: true, placeholder: 'stage / start / action' },
    ],
  },
  {
    type: 'VideoRecognition', label: '视频识别',
    description: '识别作业视频',
    fields: [
      { key: 'filename', label: '视频文件路径', kind: 'string', default: '', placeholder: '如 videos/copilot.mp4' },
    ],
  },
];

function tagLevels(): FieldOption[] {
  return [1, 2, 3, 4, 5, 6].map(n => ({ value: n, label: `★${n}` }));
}

export function getTaskType(type: string): TaskTypeDef | undefined {
  return TASK_TYPES.find(t => t.type === type);
}

export interface ParsedParams {
  /** Known fields mapped to form state (defaults filled). */
  form: Record<string, unknown>;
  /** Unknown fields preserved verbatim. */
  extra: Record<string, unknown>;
}

export function deserializeParams(type: string, params: Record<string, unknown> | undefined): ParsedParams {
  const def = getTaskType(type);
  const p: Record<string, unknown> = params ?? {};
  const form: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  const keys = new Set(def?.fields.map(f => f.key) ?? []);
  for (const f of def?.fields ?? []) {
    form[f.key] = f.key in p ? p[f.key] : type === 'Fight' && f.key === 'medicine_expire_days' && typeof p.expiring_medicine === 'number' && p.expiring_medicine !== 0 ? 2 : f.default;
  }
  for (const [k, v] of Object.entries(p)) {
    if (!keys.has(k)) extra[k] = v;
  }
  return { form, extra };
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function serializeParams(type: string, form: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const def = getTaskType(type);
  const out: Record<string, unknown> = { ...extra };
  for (const f of def?.fields ?? []) {
    const v = form[f.key] ?? f.default;
    if (f.omitEmpty && isEmpty(v)) continue;
    out[f.key] = v;
  }
  return out;
}

export interface TaskEntry {
  [key: string]: unknown;
  name: string;
  type: string;
  params: Record<string, unknown>;
  /** In-memory only: Windows-mode GUI config (stored under the preset's `manager.tasks`). */
  gui?: Gui;
  /** In-memory only: a stored GUI config no longer matched the params (hand edit). */
  guiStale?: boolean;
}

export interface PresetDoc {
  name?: string;
  client_type?: string;
  startup?: boolean;
  closedown?: boolean;
  tasks: TaskEntry[];
  /** In-memory only: preset-level Windows settings (stored under `manager.settings`). */
  settings?: PresetSettings;
  [key: string]: unknown;
}

/** Parse a maa-cli preset JSON string into a structured doc, tolerating unknown top-level fields. */
export function parsePreset(raw: string): PresetDoc {
  let data: any;
  try { data = JSON.parse(raw); } catch { data = {}; }
  if (!data || typeof data !== 'object') data = {};
  const guis = readGuis(data), stale = staleGuis(data);
  const tasks = Array.isArray(data.tasks) ? data.tasks.map((t: any, i: number) => {
    const {gui: _gui, guiStale: _stale, ...task} = t ?? {};
    return {
      ...task,
      name: typeof t?.name === 'string' ? t.name : (typeof t?.type === 'string' ? t.type : ''),
      type: typeof t?.type === 'string' ? t.type : '',
      params: (t && typeof t.params === 'object' && t.params !== null) ? t.params : {},
      ...(guis[i] ? {gui: guis[i]} : {}),
      ...(stale[i] ? {guiStale: true} : {}),
    };
  }) : [];
  const {manager: _manager, ...rest} = data;
  return {
    ...rest,
    name: typeof data.name === 'string' ? data.name : '',
    client_type: typeof data.client_type === 'string' ? data.client_type : '',
    ...(data.manager && typeof data.manager === 'object' ? {settings: readSettings(data)} : {}),
    tasks,
  };
}

/** Serialize a structured doc back to a maa-cli JSON string, preserving unknown top-level fields. */
export function serializePreset(doc: PresetDoc): string {
  const { name, client_type, startup, closedown, tasks, settings, manager: _manager, ...rest } = doc;
  const out: Record<string, unknown> = { ...rest };
  if (name) out.name = name;
  if (client_type) out.client_type = client_type;
  if (typeof startup === 'boolean') out.startup = startup;
  if (typeof closedown === 'boolean') out.closedown = closedown;
  const kept = tasks.filter(t => t.type);
  out.tasks = kept.map(({gui: _gui, guiStale: _stale, ...t}) => ({
    ...t,
    name: t.name || t.type,
    type: t.type,
    params: t.params,
  }));
  // Windows-mode tasks: params become the neutral compile of the GUI config and the GUI config is
  // stored under the top-level `manager` key (maa-cli rejects unknown keys inside a task).
  const guis = kept.map(t => t.gui);
  const final = guis.some(Boolean) ? attachGuis(out, guis, settings ?? DEFAULT_SETTINGS) : out;
  return JSON.stringify(final, null, 2);
}
