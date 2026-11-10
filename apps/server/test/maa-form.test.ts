// Coverage of the schema-driven editor: every Windows option is either rendered or excluded with a
// reason, every condition evaluates with known bindings, and every model default has a field.
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyUiRules, choicesOf, condition, defaultGui, FORM_SPEC, GUI_TASK_TYPES, SCHEMA_OPTIONS, specFor, visible, widgetOf} from '../src/maa-model';

test('every schema option is rendered or excluded with a reason', () => {
  assert.equal(SCHEMA_OPTIONS.length, 234);
  for (const [id, field, reason] of SCHEMA_OPTIONS) assert.ok(field || reason, id);
  const fields = new Set(Object.entries(FORM_SPEC).flatMap(([t, fs]) => fs.map(f => `${t}.${f.key}`)));
  for (const [id, field] of SCHEMA_OPTIONS) if (field) assert.ok(fields.has(field), `${id} → ${field}`);
});

test('all visibility/enabled conditions evaluate on defaults and edge configs', () => {
  for (const type of GUI_TASK_TYPES) {
    for (const g of [defaultGui(type), {...defaultGui(type), Mode: 'Collectible', Theme: 'Sami', UseWeeklySchedule: true}]) {
      for (const f of specFor(type)) {
        for (const e of [...f.visible, ...f.enabled]) assert.doesNotThrow(() => condition(e, g, {client: 'Official'}), `${type}.${f.key}: ${e}`);
        assert.ok(widgetOf(f), `${type}.${f.key}`);
      }
    }
  }
});

test('every model default field has an editor field (or is documented internal)', () => {
  const internal: Record<string, string[]> = {
    Fight: [], Infrast: [], Recruit: [], Mall: [], StartUp: [], Award: [], Custom: [], SwitchTheme: [],
    Roguelike: ['BlackFlowCultivationTarget'], // legacy migration source only
  };
  for (const type of GUI_TASK_TYPES) {
    const keys = new Set(specFor(type).map(f => f.key));
    for (const key of Object.keys(defaultGui(type))) assert.ok(keys.has(key) || internal[type].includes(key), `${type}.${key}`);
  }
});

test('conditions follow the XAML bindings', () => {
  const field = (t: any, k: string) => specFor(t).find(f => f.key === k)!;
  const infrast = defaultGui('Infrast');
  assert.equal(visible(field('Infrast', 'PlanSelect'), infrast, {client: 'Official'}), false);
  assert.equal(visible(field('Infrast', 'PlanSelect'), {...infrast, Mode: 'Custom'}, {client: 'Official'}), true);
  assert.equal(visible(field('Infrast', 'DormThreshold'), {...infrast, Mode: 'Rotation'}, {client: 'Official'}), false);
  assert.equal(visible(field('StartUp', 'AccountName'), {AccountSwitchEnabled: true}, {client: 'Official'}), true);
  assert.equal(visible(field('StartUp', 'AccountName'), {AccountSwitchEnabled: true}, {client: 'YoStarEN'}), false);
  const rogue = defaultGui('Roguelike');
  assert.equal(visible(field('Roguelike', 'RefreshTraderWithDice'), {...rogue, Theme: 'Mizuki'}, {client: 'Official'}), true);
  assert.equal(visible(field('Roguelike', 'RefreshTraderWithDice'), rogue, {client: 'Official'}), false);
});

test('dynamic choices and UI side effects', () => {
  const mode = specFor('Roguelike').find(f => f.key === 'Mode')!;
  assert.deepEqual(choicesOf('Roguelike', mode, {Theme: 'BlackFlow'}).map(c => c.value), ['Exp', 'Investment', 'BlackFlowStartRun']);
  const squad = specFor('Roguelike').find(f => f.key === 'Squad')!;
  assert.ok(choicesOf('Roguelike', squad, {Theme: 'Phantom'}).some(c => c.value === '研究分队'));
  assert.ok(!choicesOf('Roguelike', squad, {Theme: 'BlackFlow'}).some(c => c.value === '高规格分队'));
  const fight = applyUiRules('Fight', 'UseStone', true, defaultGui('Fight'), {client: 'Official'});
  assert.deepEqual([fight.MedicineCount, fight.UseMedicine], [999, true]);
  const rogue = applyUiRules('Roguelike', 'Theme', 'BlackFlow', {...defaultGui('Roguelike'), Mode: 'Collectible', Squad: '研究分队', Difficulty: 18}, {client: 'Official'});
  assert.deepEqual([rogue.Mode, rogue.Squad, rogue.Difficulty], ['Exp', '指挥分队', -1]);
});
