#!/usr/bin/env node
/**
 * 离线采集：读种子 → 向 GLEIF / SEC 取权威字段 → 写 src/data/companies.generated.json
 *
 *   node scripts/enrich-companies.mjs              正常：有缓存用缓存，没有就联网
 *   node scripts/enrich-companies.mjs --offline    只读缓存，绝不联网
 *   node scripts/enrich-companies.mjs --fresh      忽略缓存重新抓（限量，慎用）
 *   node scripts/enrich-companies.mjs --limit 10   只处理前 N 家，便于试跑
 *
 * 两条铁律：
 *   1. **归类（classCode / ISIC 小类）永远来自种子**，任何外部源都没有这个信息，
 *      脚本不会去猜；GLEIF / SEC 只提供身份类字段。
 *   2. **匹配不上就保留种子值并记进报告**，不因为"差一点"就把字段硬改掉。
 *
 * 输出是可复现的：同一份缓存重跑两次，生成文件逐字节一致。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOffline } from './sources/http.mjs';
import * as gleif from './sources/gleif.mjs';
import * as sec from './sources/sec.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_FILE = join(ROOT, 'scripts', 'seed', 'companies.seed.json');
const OUT_FILE = join(ROOT, 'src', 'data', 'companies.generated.json');
const REPORT_FILE = join(ROOT, 'scripts', 'collect-report.md');

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const limit = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();

const seed = JSON.parse(await readFile(SEED_FILE, 'utf8'));

/* ---------- 已存在的结果（--offline 且抓不到时保留旧值，不把数据清空） ---------- */

let previous = new Map();
try {
  const old = JSON.parse(await readFile(OUT_FILE, 'utf8'));
  previous = new Map((old.companies ?? []).map((c) => [c.id, c]));
} catch {
  /* 首次运行，没有旧结果 */
}

/* ---------- 采集 ---------- */

const report = { matched: [], unmatched: [], errors: [], secMatched: [] };
const companies = [];

for (const [index, entry] of seed.entries()) {
  if (index >= limit) {
    companies.push(previous.get(entry.id) ?? entry);
    continue;
  }

  const out = { ...entry };
  delete out.match;

  const hints = [
    ...(entry.match?.gleif ?? []),
    entry.nameEn,
    entry.name,
  ].filter(Boolean);

  const g = await gleif.lookup(hints);
  if (g?.error) {
    report.errors.push({ id: entry.id, source: 'GLEIF', message: g.error });
  } else if (g) {
    out.gleif = {
      lei: g.lei,
      legalName: g.legalName,
      country: g.country,
      city: g.city,
      region: g.region,
      legalForm: g.legalForm,
      registrationDate: g.creationDate,
      registrationStatus: g.registrationStatus,
      score: g.score,
      queriedAs: g.queriedAs,
    };
    report.matched.push({ id: entry.id, name: entry.name, legalName: g.legalName, country: g.country, score: g.score });
  } else {
    report.unmatched.push({ id: entry.id, name: entry.name, nameEn: entry.nameEn ?? '', tried: hints });
  }

  const ticker = entry.match?.secTicker ?? entry.ticker;
  if (ticker) {
    const s = await sec.lookupByTicker(ticker);
    if (s?.error) {
      report.errors.push({ id: entry.id, source: 'SEC', message: s.error });
    } else if (s) {
      const sub = await sec.submissions(s.cik);
      out.sec = {
        cik: s.cik,
        legalName: s.legalName,
        ticker: s.ticker,
        cikUrl: s.cikUrl,
        /** SEC 自行登记的 SIC，仅作参考展示，不参与 ISIC 归类 */
        sic: sub?.sic ?? '',
        sicDescription: sub?.sicDescription ?? '',
        stateOfIncorporation: sub?.stateOfIncorporation ?? '',
      };
      report.secMatched.push({ id: entry.id, name: entry.name, cik: s.cik, sic: sub?.sicDescription ?? '' });
    }
  }

  companies.push(out);
}

/* ---------- 溯源信息 ---------- */

/** 从生成的 TS 里抠出 sha256，别为这点事去 import 一个 .ts */
const isicSha = (await readFile(join(ROOT, 'src', 'data', 'isicRev5.generated.ts'), 'utf8')).match(
  /sha256:\s*"([0-9a-f]{64})"/,
)?.[1];

const sources = {
  isic: {
    name: 'ISIC Rev.5 (UN Statistics Division)',
    url: 'https://unstats.un.org/unsd/classifications/Econ/Download/In%20Text/ISIC_Rev_5_english_structure.csv',
    ...(isicSha ? { sha256: isicSha } : {}),
  },
  gleif: { name: 'GLEIF LEI records', url: 'https://api.gleif.org/api/v1/lei-records' },
  sec: { name: 'SEC EDGAR company tickers', url: 'https://www.sec.gov/files/company_tickers.json' },
};

const payload = {
  _generatedBy: 'npm run collect (scripts/enrich-companies.mjs)',
  _note: 'classCode（ISIC Rev.5 小类）与中文业务描述来自人工维护的 scripts/seed/companies.seed.json；gleif / sec 字段为外部权威源富化结果，仅作身份校对，不参与归类。',
  sources,
  companies,
};

await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');

/* ---------- 报告 ---------- */

const lines = [
  '# 采集报告',
  '',
  `模式：${isOffline ? '离线（只读缓存）' : fresh ? '强制刷新' : '优先缓存'}　公司数：${companies.length}`,
  '',
  '## GLEIF 匹配成功',
  '',
  '| 种子名 | 官方法人名 | 国别 | 置信 |',
  '| --- | --- | --- | --- |',
  ...report.matched.map((m) => `| ${m.name} | ${m.legalName} | ${m.country} | ${m.score} |`),
  '',
  `## GLEIF 未匹配（保留种子值）　${report.unmatched.length} 家`,
  '',
  ...report.unmatched.map((m) => `- ${m.name}（${m.nameEn || '无英文名'}）`),
  '',
  '## SEC 匹配成功',
  '',
  '| 种子名 | CIK | SEC 登记的 SIC（仅供参考） |',
  '| --- | --- | --- |',
  ...report.secMatched.map((m) => `| ${m.name} | ${m.cik} | ${m.sic} |`),
  '',
];

if (report.errors.length) {
  lines.push('## 请求失败', '', ...report.errors.map((e) => `- ${e.id} @ ${e.source}：${e.message}`), '');
}

await writeFile(REPORT_FILE, lines.join('\n'), 'utf8');

console.log(`✓ 已写出 src/data/companies.generated.json（${companies.length} 家）`);
console.log(`  GLEIF 匹配 ${report.matched.length} 家，未匹配 ${report.unmatched.length} 家`);
console.log(`  SEC 匹配 ${report.secMatched.length} 家`);
if (report.errors.length) console.log(`  ⚠ 请求失败 ${report.errors.length} 次，详见 scripts/collect-report.md`);
