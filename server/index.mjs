#!/usr/bin/env node
/**
 * 极简只读 HTTP 服务 —— 把 scripts/cache/industry.db 用 JSON 暴露给前端。
 *
 *   npm run api        → http://127.0.0.1:5184
 *
 * 只用 node:http，手写路由，无框架、无新增依赖。库由 scripts/build-db.mjs 建，
 * 不存在时这里会自动建一次（两者共用同一份构建逻辑）。
 *
 * 前端的用法是**渐进增强**（见 src/lib/api.ts）：探不到这个服务就完全走本地内存数据，
 * 页面照常可用。所以这里的首要目标是"别把前端带崩"：
 *   · 参数一律白名单校验，非法就 400，绝不把用户输入拼进 SQL；
 *   · 单条请求出错返回 500 + JSON，不让进程挂掉；
 *   · 每次请求现 prepare（本版 node:sqlite 缓存 statement 无性能收益，
 *     而且表被重建后缓存的 statement 会**静默返回新结构**，得不偿失）。
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = join(ROOT, 'scripts', 'cache', 'industry.db');

const PORT = Number(process.env.ISIC_API_PORT ?? 5184);
const HOST = '127.0.0.1';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  if (err?.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
    console.error(`✗ 需要 Node ≥ 22.5 且带 --experimental-sqlite（当前 ${process.version}）。`);
    console.error('  请用 `npm run api`，不要直接 `node server/index.mjs`。');
    process.exit(1);
  }
  throw err;
}

/* 库不存在 → 自动建一次（复用同一份构建逻辑，不抄第二遍） */
if (!existsSync(DB_FILE)) {
  console.log('· industry.db 不存在，先建库…');
  const { run } = await import('../scripts/build-db.mjs');
  const { nodes, companies } = await run();
  console.log(`· 建库完成：${nodes} 节点 / ${companies} 公司`);
}

const db = new DatabaseSync(DB_FILE);
db.exec('pragma busy_timeout = 5000');
/* 是真的只读：`readOnly` 打开在本版静默无效（还会造出 0 字节文件），
   要拦写入只能用 PRAGMA。 */
db.exec('pragma query_only = ON');

/* ---------- 校验 ---------- */

const CODE_RE = /^(?:[A-Z]|\d{2}|\d{3}|\d{4})$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const Q_MAX = 64;
const LIMIT_MAX = 200;

const pickCode = (v) => {
  const s = String(v ?? '');
  return CODE_RE.test(s) ? s : null;
};

const clampInt = (v, def, min, max) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** LIKE 转义。总用反斜杠：JS 模板串里写 '\\' 会被转成两个反斜杠，SQLite 直接报错。 */
const ESC = '|';
const likePattern = (q) => `%${q.replace(/[|%_]/g, (m) => ESC + m)}%`;

/* ---------- 行 → JSON ----------
   返回的对象与 src/data/companies.generated.json 里的元素**同形**：
   这样前端在 API 与本地的两条路径上渲染的是同一种数据，字段差异会立刻显示成 UI 差异。 */

function rowToCompany(row) {
  return {
    id: row.id,
    name: row.name,
    nameEn: row.name_en,
    country: row.country,
    hq: row.hq,
    founded: row.founded,
    size: row.size,
    classCode: row.class_code,
    business: row.business,
    products: row.products,
    desc: row.desc,
    ...(row.ticker != null ? { ticker: row.ticker } : {}),
    ...(row.website != null ? { website: row.website } : {}),
    ...(row.tags_json ? { tags: JSON.parse(row.tags_json) } : {}),
    ...(row.gleif_json ? { gleif: JSON.parse(row.gleif_json) } : {}),
    ...(row.sec_json ? { sec: JSON.parse(row.sec_json) } : {}),
  };
}

const COMPANY_COLS = `id, name, name_en, country, hq, founded, size, class_code,
  business, products, desc, ticker, website, tags_json, gleif_json, sec_json`;

/* ---------- 路由 ---------- */

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

function companiesByClassCodes(codes) {
  if (codes.length === 0) return [];
  const holes = codes.map(() => '?').join(',');
  return db
    .prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE class_code IN (${holes}) ORDER BY id`)
    .all(...codes)
    .map(rowToCompany);
}

/** 某个 ISIC 节点（任意层级）下的全部小类代码 */
function classCodesUnder(code) {
  const level = code.length;
  if (level === 4) return [code];
  const col = level === 3 ? 'group_code' : level === 2 ? 'division_code' : 'section_code';
  return db
    .prepare(`SELECT DISTINCT class_code FROM companies WHERE ${col} = ? ORDER BY class_code`)
    .all(code)
    .map((r) => r.class_code);
}

const ROUTES = [
  /* GET /api/health —— 前端用它探测服务是否可用 */
  ['GET', /^\/api\/health$/, (_m, _url, res) => {
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    sendJson(res, 200, {
      ok: true,
      companies: Number(meta.companies ?? 0),
      isicNodes: Number(meta.isic_nodes ?? 0),
      coveredClasses: Number(meta.covered_classes ?? 0),
      builtAt: meta.built_at ?? null,
    });
  }],

  ['GET', /^\/api\/stats$/, (_m, _url, res) => {
    const byLevel = db.prepare('SELECT level, count(*) n FROM isic_nodes GROUP BY level ORDER BY level').all();
    sendJson(res, 200, {
      isic: Object.fromEntries(byLevel.map((r) => [r.level, r.n])),
      companies: db.prepare('SELECT count(*) n FROM companies').get().n,
      countries: db.prepare('SELECT count(DISTINCT country) n FROM companies').get().n,
      coveredClasses: db.prepare('SELECT count(*) n FROM isic_nodes WHERE level = 4 AND company_count > 0').get().n,
    });
  }],

  /* GET /api/companies?section=|division=|group=|class=&q=&limit=&offset= */
  ['GET', /^\/api\/companies$/, (_m, url, res) => {
    const where = [];
    const args = [];
    for (const [param, col] of [
      ['section', 'section_code'],
      ['division', 'division_code'],
      ['group', 'group_code'],
      ['class', 'class_code'],
    ]) {
      const raw = url.searchParams.get(param);
      if (raw == null) continue;
      const code = pickCode(raw);
      if (!code) return sendJson(res, 400, { error: `参数 ${param} 不是合法的 ISIC 代码` });
      where.push(`${col} = ?`);
      args.push(code);
    }

    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length > Q_MAX) return sendJson(res, 400, { error: 'q 太长' });
    if (q) {
      where.push(`(name LIKE ? ESCAPE '${ESC}' OR name_en LIKE ? ESCAPE '${ESC}')`);
      const p = likePattern(q);
      args.push(p, p);
    }

    const limit = clampInt(url.searchParams.get('limit'), 50, 1, LIMIT_MAX);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
    const sql =
      `SELECT ${COMPANY_COLS} FROM companies` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY id LIMIT ? OFFSET ?';
    const rows = db.prepare(sql).all(...args, limit, offset).map(rowToCompany);
    sendJson(res, 200, rows);
  }],

  /* GET /api/companies/:id */
  ['GET', /^\/api\/companies\/([^/]+)$/, (m, _url, res) => {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 非法' });
    const row = db.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE id = ?`).get(id);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    sendJson(res, 200, rowToCompany(row));
  }],

  /* GET /api/isic?parent=<code> —— 内省 / 调试用；前端不依赖它（桑基图要全树） */
  ['GET', /^\/api\/isic$/, (_m, url, res) => {
    const raw = url.searchParams.get('parent');
    const parent = raw == null || raw === '' ? null : pickCode(raw);
    if (raw != null && raw !== '' && !parent) {
      return sendJson(res, 400, { error: 'parent 不是合法的 ISIC 代码' });
    }
    const rows = parent
      ? db.prepare('SELECT code, level, name_en, name_zh, company_count FROM isic_nodes WHERE parent_code = ? ORDER BY sort_order').all(parent)
      : db.prepare('SELECT code, level, name_en, name_zh, company_count FROM isic_nodes WHERE parent_code IS NULL ORDER BY sort_order').all();
    sendJson(res, 200, rows);
  }],

  /* GET /api/isic/tree —— 全树一次给全（830 节点，约 90 KB）。字段名对齐 src/data/isic.ts 的 IsicSection */
  ['GET', /^\/api\/isic\/tree$/, (_m, _url, res) => {
    const all = db.prepare('SELECT code, parent_code, level, name_en, name_zh, company_count FROM isic_nodes ORDER BY sort_order').all();
    const byCode = new Map(all.map((r) => [r.code, { ...r, children: [] }]));
    const roots = [];
    for (const node of byCode.values()) {
      if (node.parent_code) byCode.get(node.parent_code)?.children.push(node);
      else roots.push(node);
    }
    const shape = (r) => ({
      code: r.code,
      name: r.name_zh || r.name_en,
      nameEn: r.name_en,
      companyCount: r.company_count,
      ...(r.level === 2 ? { sectionCode: r.parent_code } : {}),
      ...(r.level === 3 ? { divisionCode: r.parent_code } : {}),
      ...(r.level === 1 ? { divisions: r.children.map(shape) } : {}),
      ...(r.level === 2 ? { groups: r.children.map(shape) } : {}),
      ...(r.level === 3 ? { classes: r.children.map((c) => shape(c)) } : {}),
    });
    sendJson(res, 200, { counts: { sections: roots.length }, sections: roots.map(shape) });
  }],

  /* GET /api/search/companies?q=&limit= */
  ['GET', /^\/api\/search\/companies$/, (_m, url, res) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) return sendJson(res, 200, []);
    if (q.length > Q_MAX) return sendJson(res, 400, { error: 'q 太长' });
    const limit = clampInt(url.searchParams.get('limit'), 20, 1, LIMIT_MAX);
    const p = likePattern(q);
    const rows = db
      .prepare(
        `SELECT ${COMPANY_COLS} FROM companies
         WHERE name LIKE ? ESCAPE '${ESC}' OR name_en LIKE ? ESCAPE '${ESC}'
         ORDER BY id LIMIT ?`,
      )
      .all(p, p, limit)
      .map(rowToCompany);
    sendJson(res, 200, rows);
  }],

  /* 分类下的公司（供卡片直接用，等价于 /api/companies?<level>=code） */
  ['GET', /^\/api\/isic\/([^/]+)\/companies$/, (m, _url, res) => {
    const code = pickCode(decodeURIComponent(m[1]));
    if (!code) return sendJson(res, 400, { error: '代码非法' });
    sendJson(res, 200, companiesByClassCodes(classCodesUnder(code)));
  }],
];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname;

  /* 唯一的跨源场景是"绕过 Vite proxy 直连 5184"，默认走 proxy 就不需要。
     这里只在同源开发端口上放行，绝不使用通配。 */
  const origin = req.headers.origin;
  if (origin === 'http://localhost:5183' || origin === 'http://127.0.0.1:5183') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  for (const [method, re, handler] of ROUTES) {
    if (method !== req.method) continue;
    const m = path.match(re);
    if (!m) continue;
    try {
      handler(m, url, res);
    } catch (err) {
      console.error(`✗ ${path}:`, err?.message ?? err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found', path });
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${PORT} 已被占用。多半是另一个 npm run api 还在跑；`);
    console.error(`  或 Vite 因为 5183 被占而顺延到了这个端口（vite.config.ts 已设 strictPort 防止这点）。`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  console.log(`✓ ISIC API 已启动  http://${HOST}:${PORT}`);
  console.log(`  ${meta.isic_nodes ?? '?'} 个 ISIC 节点 / ${meta.companies ?? '?'} 家公司`);
  console.log(`  Vite 侧经 proxy 访问：http://localhost:5183/api/health`);
});

const shutdown = () => {
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
