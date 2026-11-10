import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildOperatorIndex, compileTask, defaultGui} from '../src/maa-model';
import {cfg} from '../src/config';
import {operatorIndex, runtimeContext} from '../src/maa-runtime';

const fixture = path.join(__dirname, 'fixtures', 'battle_data.subset.json');
const settings = {StartGame: true, ReportToPenguin: false, PenguinId: '', ReportToYituliu: false};

test('DataHelper index on real battle_data entries: any server name → CN name, ignoring case', async () => {
  const index = buildOperatorIndex(JSON.parse(await fs.readFile(fixture, 'utf8')));
  assert.equal(index.resolve("Wiš'adel"), '维什戴尔');
  assert.equal(index.resolve("WIŠ'ADEL"), '维什戴尔');
  assert.equal(index.resolve('ウィシャデル'), '维什戴尔');
  assert.equal(index.resolve('위셔델'), '维什戴尔');
  assert.equal(index.resolve('維什戴爾'), '维什戴尔');
  assert.equal(index.resolve('la pluma'), '羽毛笔');
  assert.equal(index.resolve('阿米娅'), '阿米娅');
  assert.equal(index.resolve('不存在的干员'), undefined);
  assert.equal(index.resolve(''), undefined);
});

test('first entry wins on duplicate names (Dictionary.TryAdd in file order)', () => {
  const index = buildOperatorIndex({chars: {a: {name: '甲', name_en: 'Same'}, b: {name: '乙', name_en: 'same'}, c: {name: null, name_en: 'Nameless'}}});
  assert.equal(index.resolve('SAME'), '甲');
  assert.equal(index.resolve('Nameless'), undefined, 'entry without a CN name: the typed name is kept');
  assert.equal(buildOperatorIndex(null).size, 0);
});

test('runtime: maa-cli resource order (later overrides), cache invalidation, Roguelike compile and notice', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maa-ops-'));
  const previous = {...cfg};
  try {
    Object.assign(cfg, {maaData: dir, battleData: ''});
    assert.equal(operatorIndex(), null, 'no battle_data → names are sent as typed');
    await fs.mkdir(path.join(dir, 'resource'), {recursive: true});
    await fs.copyFile(fixture, path.join(dir, 'resource', 'battle_data.json'));
    assert.equal(operatorIndex()?.resolve('Pallas'), '帕拉斯');
    const hot = path.join(dir, 'MaaResource', 'resource');
    await fs.mkdir(hot, {recursive: true});
    await fs.writeFile(path.join(hot, 'battle_data.json'), JSON.stringify({chars: {x: {name: '新干员', name_en: 'Newcomer'}}}));
    assert.equal(operatorIndex()?.resolve('Newcomer'), '新干员', 'the later (hot-update) directory wins');
    assert.equal(operatorIndex()?.resolve('Pallas'), undefined);
    await fs.rm(path.join(hot, 'battle_data.json'));

    const ctx = runtimeContext(JSON.stringify({client_type: 'YoStarEN', tasks: []}));
    const out = compileTask({type: 'Roguelike', gui: {...defaultGui('Roguelike'), UseAdditionalStartingOpers: true,
      StartingOpers: [{Name: 'La Pluma', UseSupport: true}, {Name: 'Unknown Op', UseSupport: false}]}, index: 0, client: 'YoStarEN', settings, ctx, enabledFights: [], stateKey: ''}) as any;
    assert.deepEqual(out.params.core_char_list, [{name: '羽毛笔', use_support: true}, {name: 'Unknown Op', use_support: false}]);
    assert.deepEqual(out.notes, ['开局干员「Unknown Op」未在 battle_data 中，按原样下发']);

    Object.assign(cfg, {battleData: fixture});
    assert.equal(operatorIndex()?.resolve('Amiya'), '阿米娅', 'MAA_BATTLE_DATA_FILE overrides the search');
  } finally {
    Object.assign(cfg, previous);
    await fs.rm(dir, {recursive: true, force: true});
  }
});
