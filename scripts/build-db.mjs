#!/usr/bin/env node
/**
 * 把 ISIC 结构 + 公司数据灌进 SQLite（scripts/cache/industry.db）。
 *
 *   npm run db              重建库
 *
 * 为什么会有这一步：用户要求「公司最好存到数据库」。库是**构建期产物**，
 * 不进 bundle、不参与运行时打包；运行时读库的是 server/index.mjs。
 *
 * 设计要点（与 scripts/fetch-isic.mjs 同一套哲学）：
 *   1. **断言而非降级**。层级数量、公司数、父子前缀任何一条对不上就中止。
 *   2. **幂等**：每次 DROP + CREATE 重建，同一输入重跑后**查询结果一致**
 *      （不承诺文件字节一致 —— SQLite 内部页序不保证）。
 *      不删文件重写，因为 Windows 上文件被另一连接占用时 unlink 会 EBUSY。
 *   3. 不用 `readOnly` 打开去探测库是否存在 —— 那个选项在本版 node:sqlite 上
 *      静默无效，还会创建一个 0 字节文件（后续查询全部 "no such table"）。
 */

import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* `node:sqlite` 是 Node 22.5+ 的实验特性，**必须**带 --experimental-sqlite。
   用动态 import 而不是静态：静态 import 在解析阶段就崩，连下面这句人话都打不出来。
   走 npm script（`npm run db`）会自动带上 flag。 */
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  if (err?.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
    console.error(`✗ 需要 Node ≥ 22.5 且带 --experimental-sqlite（当前 ${process.version}）。`);
    console.error('  请用 `npm run db`，不要直接 `node scripts/build-db.mjs`。');
    process.exit(1);
  }
  throw err;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'scripts', 'cache');
export const DB_FILE = join(CACHE_DIR, 'industry.db');

const GENERATED_COMPANIES = join(ROOT, 'src', 'data', 'companies.generated.json');
const GENERATED_ISIC = join(ROOT, 'src', 'data', 'isicRev5.generated.ts');
const ZH_FILE = join(ROOT, 'src', 'data', 'isicRev5.zh.ts');

/** 官方层级规模 —— 对不上说明上游文件变了，必须人工过目 */
const EXPECTED = { 1: 22, 2: 87, 3: 258, 4: 463 };

const LEVEL_NAME = { 1: '门类', 2: '大类', 3: '中类', 4: '小类' };

/* ---------- 解析 .ts 数据文件 ----------
   沿用 scripts/build-zh.mjs 里的既有做法：这些文件是**数据**，不是代码，
   逐行 JSON.parse 比引一个 TS 运行时便宜得多。整段数据必须过下面的断言，
   一旦上游标题里出现未转义引号导致漏行，断言会把它变成硬失败而不是静默丢数据。 */

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

/* ---------- 建库 ---------- */

export function buildDatabase() {
  const db = new DatabaseSync(DB_FILE);

  /* busy_timeout 必须用 PRAGMA 设：构造参数 {timeout} 在本版是无效的。
     这很重要 —— server 可能同时开着，重跑 db 时会撞锁。 */
  db.exec('pragma busy_timeout = 5000');
  /* 默认 journal_mode 就是 delete：不用 WAL，省掉 -wal / -shm 两个 sidecar 文件 */
  db.exec('pragma foreign_keys = OFF');

  db.exec(`
    DROP TABLE IF EXISTS companies;
    DROP TABLE IF EXISTS isic_nodes;
    DROP TABLE IF EXISTS meta;

    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE isic_nodes (
      code          TEXT    PRIMARY KEY,
      parent_code   TEXT,
      level         INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
      name_en       TEXT    NOT NULL,
      name_zh       TEXT    NOT NULL DEFAULT '',
      company_count INTEGER NOT NULL DEFAULT 0,
      sort_order    INTEGER NOT NULL,
      CHECK (length(code) = level)
    ) STRICT;

    CREATE INDEX idx_isic_parent ON isic_nodes(parent_code, sort_order);
    CREATE INDEX idx_isic_level  ON isic_nodes(level, sort_order);

    CREATE TABLE companies (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      name_en       TEXT NOT NULL,
      country       TEXT NOT NULL,
      hq            TEXT NOT NULL,
      founded       INTEGER NOT NULL,
      size          TEXT NOT NULL,
      class_code    TEXT NOT NULL,
      group_code    TEXT NOT NULL,
      division_code TEXT NOT NULL,
      section_code  TEXT NOT NULL,
      business      TEXT NOT NULL,
      products      TEXT NOT NULL,
      desc          TEXT NOT NULL,
      ticker        TEXT,
      website       TEXT,
      tags_json     TEXT NOT NULL,
      gleif_json    TEXT,
      sec_json      TEXT
    ) STRICT;

    CREATE INDEX idx_co_class    ON companies(class_code);
    CREATE INDEX idx_co_group    ON companies(group_code);
    CREATE INDEX idx_co_division ON companies(division_code);
    CREATE INDEX idx_co_section  ON companies(section_code);
    CREATE INDEX idx_co_country  ON companies(country);
  `);

  return db;
}

/* ---------- 灌数据 ---------- */

async function loadInputs() {
  const rows = parseRows(await readFile(GENERATED_ISIC, 'utf8'));
  const zh = parseZhModule(await readFile(ZH_FILE, 'utf8'));
  const gen = JSON.parse(await readFile(GENERATED_COMPANIES, 'utf8'));

  if (rows.length === 0) {
    throw new Error('未从 isicRev5.generated.ts 解析到任何行 —— 先跑 npm run fetch:isic');
  }

  /* 断言 1：层级数量。漏行会让桑基图结构缺块，比缺数据更危险。 */
  const byLevel = {};
  for (const [code] of rows) byLevel[code.length] = (byLevel[code.length] ?? 0) + 1;
  const problems = [];
  for (const [lv, want] of Object.entries(EXPECTED)) {
    if (byLevel[lv] !== want) {
      problems.push(`${LEVEL_NAME[lv]} ${byLevel[lv]} 个，期望 ${want} 个`);
    }
  }
  if (problems.length) {
    throw new Error(`ISIC 结构校验失败（正则解析可能漏行）：\n  - ${problems.join('\n  - ')}`);
  }

  /* 断言 2：父子关系靠官方文件的 DFS 顺序（大类切不出字母父级，必须按序挂） */
  const parent = new Map();
  let cur = { 1: null, 2: null, 3: null };
  rows.forEach(([code]) => {
    const len = code.length;
    if (len === 1) {
      parent.set(code, null);
      cur = { 1: code, 2: null, 3: null };
      return;
    }
    const up = cur[len - 1];
    if (!up) throw new Error(`${code} 之前没有出现任何${LEVEL_NAME[len - 1]}作为父级`);
    if (len >= 3 && !code.startsWith(up)) {
      throw new Error(`${code} 的父级应为 ${up}，前缀不匹配`);
    }
    parent.set(code, up);
    cur[len] = code;
  });

  return { rows, zh, gen, parent };
}

export async function run() {
  await mkdir(CACHE_DIR, { recursive: true });
  const { rows, zh, gen, parent } = await loadInputs();

  const companies = gen.companies ?? [];
  if (companies.length === 0) throw new Error('companies.generated.json 里没有公司 —— 先跑 npm run collect');

  /* 断言 3：每家公司的 classCode 必须真的存在，且能一路走到门类 */
  const codes = new Set(rows.map(([c]) => c));
  for (const c of companies) {
    if (!codes.has(c.classCode)) {
      throw new Error(`公司 ${c.id} 的 classCode=${c.classCode} 不在 ISIC Rev.5 结构里`);
    }
  }

  /* 公司数自底向上汇总（只报真值，空分类就是 0） */
  const counts = new Map();
  for (const c of companies) {
    counts.set(c.classCode, (counts.get(c.classCode) ?? 0) + 1);
  }
  for (const [code] of [...rows].reverse()) {
    const p = parent.get(code);
    if (p) counts.set(p, (counts.get(p) ?? 0) + (counts.get(code) ?? 0));
  }

  /* 每条公司记录也补全父链，避免运行时 JOIN */
  const divisionOf = new Map();
  const sectionOf = new Map();
  for (const [code] of rows) {
    let cur = code;
    const chain = [];
    while (cur) {
      chain.push(cur);
      cur = parent.get(cur);
    }
    const sec = chain.find((x) => x.length === 1);
    if (sec) sectionOf.set(code, sec);
    const div = chain.find((x) => x.length === 2);
    if (div) divisionOf.set(code, div);
  }

  const db = buildDatabase();

  const isicSha = (await readFile(GENERATED_ISIC, 'utf8')).match(/sha256:\s*"([0-9a-f]{64})"/)?.[1] ?? '';

  /* 事务手写：node:sqlite 没有 better-sqlite3 的 db.transaction() */
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertNode = db.prepare(
      `INSERT INTO isic_nodes (code, parent_code, level, name_en, name_zh, company_count, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach(([code, nameEn], i) => {
      /* 可选值必须显式 ?? null：本版 node:sqlite 绑定 undefined 会直接抛错 */
      insertNode.run(code, parent.get(code) ?? null, code.length, nameEn, zh.get(code) ?? '', counts.get(code) ?? 0, i);
    });

    const insertCompany = db.prepare(
      `INSERT INTO companies (
         id, name, name_en, country, hq, founded, size, class_code, group_code,
         division_code, section_code, business, products, desc, ticker, website,
         tags_json, gleif_json, sec_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of companies) {
      insertCompany.run(
        c.id,
        c.name,
        c.nameEn ?? '',
        c.country ?? '',
        c.hq ?? '',
        c.founded ?? 0,
        c.size ?? '',
        c.classCode,
        c.classCode.slice(0, 3),
        divisionOf.get(c.classCode) ?? '',
        sectionOf.get(c.classCode) ?? '',
        c.business ?? '',
        c.products ?? '',
        c.desc ?? '',
        c.ticker ?? null,
        c.website ?? null,
        JSON.stringify(c.tags ?? []),
        c.gleif ? JSON.stringify(c.gleif) : null,
        c.sec ? JSON.stringify(c.sec) : null,
      );
    }

    const coveredClasses = rows.filter(([code]) => code.length === 4 && (counts.get(code) ?? 0) > 0).length;
    const meta = {
      schema_version: '1',
      built_at: new Date().toISOString(),
      isic_source_sha256: isicSha,
      isic_nodes: String(rows.length),
      companies: String(companies.length),
      covered_classes: String(coveredClasses),
      sources_json: JSON.stringify(gen.sources ?? {}),
    };
    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) insertMeta.run(k, v);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }

  db.close();
  return { nodes: rows.length, companies: companies.length };
}

/* 直接运行：node --experimental-sqlite scripts/build-db.mjs */
if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const t0 = Date.now();
  const { nodes, companies } = await run();
  console.log(`✓ 已写出 scripts/cache/industry.db`);
  console.log(`  ${nodes} 个 ISIC 节点 / ${companies} 家公司 / ${Date.now() - t0} ms`);
}
