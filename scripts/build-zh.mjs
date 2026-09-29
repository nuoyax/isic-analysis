#!/usr/bin/env node
/**
 * 生成 src/data/isicRev5.zh.ts —— 代码 → 中文名。
 *
 *   node scripts/build-zh.mjs           生成并报告
 *   node scripts/build-zh.mjs --check   只报告，不写文件（CI / 提交前用）
 *
 * 中文名的两个来源，按优先级：
 *   1. scripts/seed/isicRev4.zh.ts   —— 旧版 Rev.4 同代码的中文名，直接继承（4 位同码）
 *   2. scripts/seed/titles.zh.json   —— 英文标题 → 中文译名（人工译，覆盖 Rev.5 新增/改名项）
 * 第 1 条优先，因为它是这个项目里已经在用的叫法，换了反而会让老用户困惑。
 *
 * 这个脚本会做三件事，缺一不可：
 *   · 报出 titles.zh.json 里**用不上的键**（英文标题在 Rev.5 里不存在 → 多半是我拼错了）
 *   · 报出重复键（JSON.parse 会静默取最后一个，必须显式查）
 *   · 报出**还没译到的代码**并列出层级分布
 * 任一为「有问题的」都只警告不中止 —— 未译的会回落显示英文名，页面仍然可用。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = join(ROOT, 'src', 'data', 'isicRev5.generated.ts');
const OUT_FILE = join(ROOT, 'src', 'data', 'isicRev5.zh.ts');
const TITLES = join(ROOT, 'scripts', 'seed', 'titles.zh.json');
const LEGACY = join(ROOT, 'scripts', 'seed', 'isicRev4.zh.ts');

const LEVEL_ZH = { 1: '门类', 2: '大类', 3: '中类', 4: '小类' };

function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\[(.+)\],\s*$/);
    if (m) rows.push(JSON.parse(`[${m[1]}]`));
  }
  return rows;
}

function parseZhModule(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*"([A-Z0-9]+)":\s*"([^"]*)",\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/** JSON.parse 对重复键静默取最后一个，所以先做一次文本层面的重复检测 */
function findDuplicateKeys(text) {
  const seen = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*"((?:[^"\\]|\\.)+)":\s*"/);
    if (!m) continue;
    const key = m[1];
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

const rows = parseRows(await readFile(GENERATED, 'utf8'));
if (rows.length === 0) throw new Error('未从 isicRev5.generated.ts 解析到行，先跑 npm run fetch:isic');

const titlesText = await readFile(TITLES, 'utf8');
const dupes = findDuplicateKeys(titlesText);
const titles = new Map(Object.entries(JSON.parse(titlesText)).filter(([k]) => !k.startsWith('_')));
const legacy = parseZhModule(await readFile(LEGACY, 'utf8'));

const rev5Titles = new Set(rows.map(([, t]) => t));
const unusedKeys = [...titles.keys()].filter((k) => !rev5Titles.has(k));

const resolved = rows.map(([code, title]) => {
  const fromLegacy = (legacy.get(code) ?? '').trim();
  const fromTitles = (titles.get(title) ?? '').trim();
  return { code, title, zh: fromLegacy || fromTitles, source: fromLegacy ? 'legacy' : fromTitles ? 'titles' : '' };
});

const missing = resolved.filter((r) => !r.zh);
const byLevel = new Map();
for (const { code } of missing) byLevel.set(code.length, (byLevel.get(code.length) ?? 0) + 1);

const fromLegacyCount = resolved.filter((r) => r.source === 'legacy').length;
console.log(`· 中文名来源：继承旧表 ${fromLegacyCount} 条，新译 ${resolved.filter((r) => r.source === 'titles').length} 条`);
console.log(`· 覆盖 ${resolved.length - missing.length} / ${resolved.length}`);

if (dupes.length > 0) {
  console.warn(`⚠ titles.zh.json 有 ${dupes.length} 个重复键（后者覆盖前者）：\n    ${dupes.join('\n    ')}`);
}
if (unusedKeys.length > 0) {
  console.warn(`⚠ titles.zh.json 有 ${unusedKeys.length} 个键在 Rev.5 里找不到对应标题（拼写错误？）：`);
  for (const k of unusedKeys.slice(0, 15)) console.warn(`    ${k}`);
  if (unusedKeys.length > 15) console.warn(`    …还有 ${unusedKeys.length - 15} 条`);
}
if (missing.length > 0) {
  console.warn(`⚠ 仍有 ${missing.length} 个代码没有中文名，将回落显示英文名：`);
  for (const len of [1, 2, 3, 4]) {
    if (byLevel.has(len)) console.warn(`    ${LEVEL_ZH[len]} ${byLevel.get(len)} 个：${missing.filter((m) => m.code.length === len).map((m) => m.code).join(' ')}`);
  }
} else {
  console.log('✓ 全部代码都有中文名');
}

if (process.argv.includes('--check')) {
  if (dupes.length || unusedKeys.length || missing.length) process.exitCode = 1;
} else {
  const lines = resolved
    .map(({ code, title, zh }) =>
      zh
        ? `  ${JSON.stringify(code)}: ${JSON.stringify(zh)},`
        : `  // TODO 待译：${title}\n  ${JSON.stringify(code)}: '',`,
    )
    .join('\n');

  const out = `/**
 * ISIC Rev.5 中文名 —— **人工译名**，不是机器翻译。
 *
 * 本文件由 scripts/build-zh.mjs 生成，请勿手工编辑；改译名请改
 *   scripts/seed/isicRev4.zh.ts（继承旧表）或 scripts/seed/titles.zh.json（新译）
 * 然后重新执行 npm run build:zh。
 *
 * 结构（层级、顺序、代码）一律以 isicRev5.generated.ts 的官方英文结构为准，
 * 这里只提供中文名。空字符串 = 尚未翻译，界面回落显示英文名。
 */

import { ISIC_REV5_ROWS } from './isicRev5.generated';

export const ISIC_REV5_ZH: Readonly<Record<string, string>> = {
${lines}
};

/** 取中文名；未译时回落英文官方名，绝不空着 */
export function zhNameOf(code: string): string {
  return ISIC_REV5_ZH[code] || (ISIC_REV5_ROWS.find((r) => r[0] === code)?.[1] ?? code);
}

/** 未翻译的代码（开发期用；上线后应为空数组） */
export const ISIC_REV5_UNTRANSLATED: readonly string[] = ISIC_REV5_ROWS.filter(
  ([code]) => !ISIC_REV5_ZH[code],
).map(([code]) => code);
`;
  await writeFile(OUT_FILE, out, 'utf8');
  console.log(`· 已写出 src/data/isicRev5.zh.ts（${resolved.length} 条）`);
}
