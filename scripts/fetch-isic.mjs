#!/usr/bin/env node
/**
 * 抓取 ISIC Rev.5 官方结构，生成 src/data/isicRev5.generated.ts
 *
 *   node scripts/fetch-isic.mjs            正常：联网抓取，成功则写缓存
 *   node scripts/fetch-isic.mjs --offline  只读 scripts/cache/，不发请求
 *
 * 设计要点：
 *   1. **只用官方源**。UN Statistics Division 的英语结构 CSV 是唯一真值，
 *      URL 写死在下面，方便人工核对。
 *   2. **断言而非降级**。层级数量、父子前缀关系任何一条对不上就中止报错，
 *      绝不产出半棵树（结构错了比缺数据更危险）。
 *   3. **幂等**。生成文件里不放抓取时刻（那会让每次重跑都 diff），只放来源
 *      URL 与内容 SHA-256；抓取时刻写在 scripts/cache/ 的元数据里。
 *   4. 缓存以 URL 为键。URL 写错时查不到缓存，直接中止 —— 不会静默用旧数据。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'scripts', 'cache');
const OUT_FILE = join(ROOT, 'src', 'data', 'isicRev5.generated.ts');

const SOURCE = {
  name: 'ISIC Rev.5 (UN Statistics Division)',
  url: 'https://unstats.un.org/unsd/classifications/Econ/Download/In%20Text/ISIC_Rev_5_english_structure.csv',
};

/** ISIC Rev.5 官方层级规模 —— 对不上说明源文件变了，必须人工过目 */
const EXPECTED = { section: 22, division: 87, group: 258, class: 463 };

const offline = process.argv.includes('--offline');
const cacheFile = join(CACHE_DIR, `${createHash('sha256').update(SOURCE.url).digest('hex').slice(0, 12)}.csv`);
const metaFile = join(CACHE_DIR, 'isic.meta.json');

/* ---------- HTTP ---------- */

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30_000 }, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error('重定向次数过多'));
        return resolve(fetchText(new URL(headers.location, url).href, redirects + 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
  });
}

async function getCsv() {
  if (!offline) {
    try {
      const text = await fetchText(SOURCE.url);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, text, 'utf8');
      await writeFile(metaFile, JSON.stringify({ fetchedAt: new Date().toISOString(), url: SOURCE.url }, null, 2) + '\n', 'utf8');
      console.log(`· 已抓取 ${SOURCE.url}`);
      return text;
    } catch (err) {
      console.warn(`· 联网抓取失败（${err.message}），尝试本地缓存`);
    }
  }
  try {
    const text = await readFile(cacheFile, 'utf8');
    console.log('· 使用本地缓存');
    return text;
  } catch {
    const hint = offline ? '加 --offline 也读不到' : '且无本地缓存';
    throw new Error(`拿不到 ISIC 结构数据（${hint}）：${SOURCE.url}`);
  }
}

/* ---------- 解析 ---------- */

/** 解析为 [code, title][]，保持官方顺序 */
function parseCsv(csv) {
  const rows = [];
  const lines = csv.replace(/^﻿/, '').trim().split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const cells = line.match(/"([^"]*)"/g);
    if (!cells || cells.length < 2) continue;
    const code = cells[0].slice(1, -1).trim();
    const title = normalizeTitle(cells[1].slice(1, -1).trim());
    if (!code || !title) continue;
    rows.push([code, title]);
  }
  return rows;
}

/* 官方 CSV 里混进了几个 U+FFFD 替换字符（源文件的编码缺陷，落在词与词之间，
   例如 "Telecommunication reselling�activities"）。按其原始占位还原为空格，
   并把出现次数报到控制台 —— 这是对源缺陷的**确定性**修补，不是猜测。 */
let replacementChars = 0;
function normalizeTitle(title) {
  const count = (title.match(/�/g) ?? []).length;
  if (count === 0) return title;
  replacementChars += count;
  return title.replace(/�/g, ' ').replace(/\s+/g, ' ');
}

const LEVEL_NAME = { 1: '门类', 2: '大类', 3: '中类', 4: '小类' };

const sectionName = (code) => `section ${code}`;

function validate(rows) {
  const problems = [];
  const byLen = new Map();
  for (const [code] of rows) {
    byLen.set(code.length, (byLen.get(code.length) ?? 0) + 1);
  }

  for (const [level, expected] of Object.entries(EXPECTED)) {
    const len = level === 'section' ? 1 : level === 'division' ? 2 : level === 'group' ? 3 : 4;
    const actual = byLen.get(len) ?? 0;
    if (actual !== expected) {
      problems.push(`${LEVEL_NAME[len]} 数量 ${actual}，期望 ${expected}`);
    }
  }

  const seen = new Set();
  for (const [code] of rows) {
    if (seen.has(code)) problems.push(`重复代码 ${code}`);
    seen.add(code);
  }

  /* 官方文件是深度优先排布：门类 → 其大类 → 其中类 → 其小类 → 下一个中类……
     所以父子关系由「文档顺序」决定，而不是由代码切片导出 —— 大类的父级是
     一个字母门类，切不出来。这里按顺序维护「最近出现的上一层节点」。 */
  const lastAt = new Map(); // 层级长度 → 最近出现的代码
  const childCount = new Map(); // 代码 → 子节点数
  let sectionsInOrder = true;
  let previousSection = '';

  for (const [code] of rows) {
    const len = code.length;

    if (len === 1) {
      if (!/^[A-Z]$/.test(code)) problems.push(`门类代码非法：${code}`);
      if (previousSection && code <= previousSection) sectionsInOrder = false;
      previousSection = code;
      lastAt.set(1, code);
      continue;
    }

    if (!/^\d+$/.test(code)) problems.push(`数字层级代码非法：${code}`);

    const parentLen = len - 1;
    const parent = lastAt.get(parentLen);
    if (!parent) {
      problems.push(`${code} 之前没有出现任何${LEVEL_NAME[parentLen]}作为其父级`);
      continue;
    }
    if (parentLen >= 2 && !code.startsWith(parent)) {
      problems.push(`${code} 的父级应为 ${parent}，前缀不匹配`);
    }
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    lastAt.set(len, code);
  }
  if (!sectionsInOrder) problems.push('门类未按字母顺序排列');

  // 每个非叶子节点都必须至少有一个子节点（否则是断枝）
  for (const [code] of rows) {
    if (code.length === 4) continue;
    if ((childCount.get(code) ?? 0) === 0) {
      problems.push(`${code} 没有任何子节点`);
    }
  }

  // 占位信息：确认第一个门类确实是大写字母（防止解析把表头吃进来）
  if (!/^[A-Z]$/.test(rows[0][0])) problems.push(`首个节点 ${rows[0][0]} 不是门类代码，可能解析错了表头`);

  if (problems.length > 0) {
    throw new Error(`ISIC 结构校验失败（${problems.length} 项）：\n  - ${problems.slice(0, 20).join('\n  - ')}`);
  }
  return byLen;
}

/* ---------- 输出 ---------- */

function render(rows, sha256) {
  const body = rows
    .map(([code, title]) => `  [${JSON.stringify(code)}, ${JSON.stringify(title)}],`)
    .join('\n');

  return `/* 本文件由 scripts/fetch-isic.mjs 生成，请勿手工编辑。
 * 重新生成：npm run fetch:isic
 *
 * 来源：${SOURCE.name}
 * ${SOURCE.url}
 * SHA-256：${sha256}
 * 规模：22 门类 / 87 大类 / 258 中类 / 463 小类
 */

export const ISIC_REV5_SOURCE = {
  name: ${JSON.stringify(SOURCE.name)},
  url: ${JSON.stringify(SOURCE.url)},
  sha256: ${JSON.stringify(sha256)},
} as const;

/** [代码, 官方英文名]，保持 UN 文件原序。代码长度即层级：1 门类 / 2 大类 / 3 中类 / 4 小类 */
export const ISIC_REV5_ROWS: readonly (readonly [string, string])[] = [
${body}
];
`;
}

/* ---------- 主流程 ---------- */

const csv = await getCsv();
const rows = parseCsv(csv);
if (rows.length === 0) throw new Error('解析结果为空 —— CSV 格式可能已变化，请人工检查来源文件');

const counts = validate(rows);
const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
const output = render(rows, sha256);

await writeFile(OUT_FILE, output, 'utf8');

console.log(
  `✓ 已写出 src/data/isicRev5.generated.ts\n` +
    `  ${counts.get(1)} 门类 / ${counts.get(2)} 大类 / ${counts.get(3)} 中类 / ${counts.get(4)} 小类\n` +
    `  sha256 ${sha256.slice(0, 16)}…`,
);
if (replacementChars > 0) {
  console.log(`  ⚠ 源文件含 ${replacementChars} 个 U+FFFD 替换字符，已按空格还原（见 parseCsv 注释）`);
}
