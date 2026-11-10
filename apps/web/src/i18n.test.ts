import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JA,LOCALES,detectLocale,format,missingTranslations,translate} from './i18n';

const here = path.dirname(fileURLToPath(import.meta.url));
const CJK = /[\u4e00-\u9fff]/;
// i18n.ts holds the dictionary itself, test files are not console text, and Auth/Workspace/
// AutomationPanel are the archived account UI that no longer ships in the shared console.
const skipped = (file: string) => /\.test\./.test(file) || file.startsWith('i18n.')
  || ['Auth.tsx', 'Workspace.tsx', 'AutomationPanel.tsx'].includes(file);

function uiSources() {
  return fs.readdirSync(here)
    .filter(file => /\.(ts|tsx)$/.test(file) && !skipped(file))
    .map(file => ({file, text: fs.readFileSync(path.join(here, file), 'utf8')}));
}

/** Quoted strings: the Chinese source text components hand to `t()` (and the schema's own data). */
function literals(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (CJK.test(value)) found.push(value);
  }
  return found;
}

/** Chinese sitting directly in JSX would bypass `t()` entirely. */
function untranslatedJsx(text: string) {
  return [...text.matchAll(/>([^<>{]*[\u4e00-\u9fff][^<>{]*)</g)].map(match => match[1].trim());
}

test('chinese is the default, and a missing japanese string falls back to it', () => {
  assert.deepEqual(LOCALES, ['zh', 'ja']);
  assert.equal(translate('zh', '总览'), '总览');
  assert.equal(translate('ja', '总览'), '概要');
  // Never a raw key or an empty cell: an untranslated string stays Chinese.
  assert.equal(translate('ja', '尚未翻译的文本'), '尚未翻译的文本');
  assert.equal(translate('zh', '尚未翻译的文本'), '尚未翻译的文本');
});

test('parameters are interpolated and unknown placeholders survive', () => {
  assert.equal(translate('zh', '控制至 {time}', {time: '10:00'}), '控制至 10:00');
  assert.equal(translate('ja', '{count} 项', {count: 3}), '3 件');
  assert.equal(format('{a} {b}', {a: 'x'}), 'x {b}');
  assert.equal(format('no placeholders'), 'no placeholders');
});

test('the stored choice wins, then the browser, then chinese', () => {
  assert.equal(detectLocale('ja', ['en-US']), 'ja');
  assert.equal(detectLocale('zh', ['ja-JP']), 'zh');
  assert.equal(detectLocale(null, ['ja-JP', 'en']), 'ja');
  assert.equal(detectLocale(null, ['fr-FR']), 'zh');
  assert.equal(detectLocale('klingon', ['en-US']), 'zh');
  assert.equal(detectLocale(undefined), 'zh');
});

// "Translate as much as possible" as a checked property: every Chinese string the UI can show is
// expected in the Japanese dictionary, and Chinese must not hide in JSX text where `t()` cannot see it.
test('every chinese string in the console has a japanese translation', () => {
  const missing: string[] = [];
  for (const {file, text} of uiSources()) missing.push(...missingTranslations(literals(text)).map(x => `${file}: ${x}`));
  assert.deepEqual(missing, [], `未翻译：\n${missing.join('\n')}`);
});

test('no chinese text bypasses the translation function', () => {
  const offenders: string[] = [];
  for (const {file, text} of uiSources()) offenders.push(...untranslatedJsx(text).map(x => `${file}: ${x}`));
  assert.deepEqual(offenders, [], `未包在 t() 里：\n${offenders.join('\n')}`);
});

test('client labels distinguish Traditional Chinese, Japanese and Korean across locale changes', () => {
  const labels = ['繁中服 txwy', '日服 YoStarJP', '韩服 YoStarKR'];
  for (const locale of ['zh', 'ja', 'zh', 'ja'] as const) {
    assert.deepEqual(labels.map(label => translate(locale, label)), locale === 'zh' ? labels :
      ['繁体字中国語版 txwy', '日本版 YoStarJP', '韓国版 YoStarKR']);
  }
  assert.equal(JA['繁中服 txwy'], '繁体字中国語版 txwy');
  assert.equal(Object.hasOwn(JA, '日服/韩服 txwy'), false);
});
