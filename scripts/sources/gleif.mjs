/**
 * GLEIF 法人库（LEI）—— 官方来源，无需 API key。
 *
 * 能给什么：登记在册的**官方法人名**、注册地址（国别 / 城市 / 地区）、
 *           法人形式、实体成立日期、LEI 编码。
 * 不能给什么：**行业分类**。GLEIF 的 entity 里没有 ISIC / NACE / SIC 字段，
 *           所以这个模块只做字段富化，绝不参与分类判断。
 *
 * 匹配策略（宁可标为"未匹配"，也不硬塞一个错的公司）：
 *   1. 用线索名 / 英文名 / 中文名 依次查询 filter[entity.legalName]=...
 *   2. 候选里筛「名字规范化后完全相等」或「一方包含另一方」的；
 *   3. 有多条候选且分数相同 → 视为不确定，返回 null 让调用方记进报告。
 */

import { fetchJson } from './http.mjs';

const BASE = 'https://api.gleif.org/api/v1/lei-records';
const PAGE_SIZE = 5;

/** 规范化：去标点、去公司后缀噪音、压空白、转小写 */
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[.,'"()&/·-]/g, ' ')
    .replace(
      /\b(co|company|corp|corporation|inc|incorporated|ltd|limited|llc|plc|se|ag|sa|nv|bv|gmbh|group|holdings?|company|股份|有限公司|集团|控股)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function score(candidate, query) {
  const a = normalize(candidate);
  const b = normalize(query);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.75;
  // 词集合重合度，只作兜底
  const setA = new Set(a.split(' '));
  const setB = new Set(b.split(' '));
  const hit = [...setA].filter((w) => setB.has(w)).length;
  return (2 * hit) / (setA.size + setB.size);
}

function slim(record, s) {
  const e = record.attributes.entity;
  const addr = e.legalAddress ?? {};
  return {
    score: Number(s.toFixed(3)),
    lei: record.id,
    legalName: e.legalName?.name ?? '',
    country: addr.country ?? '',
    city: addr.city ?? '',
    region: addr.region ?? '',
    legalForm: e.legalForm?.id ?? '',
    creationDate: (e.creationDate ?? '').slice(0, 10),
    registrationStatus: record.attributes.registration?.status ?? '',
    matchSource: 'GLEIF',
  };
}

/**
 * 按名称查一家法人。
 * @returns 匹配结果对象；不确定 / 查不到时返回 null（调用方保留种子值并记入报告）
 */
export async function lookupByName(name) {
  if (!name?.trim()) return null;
  const url = `${BASE}?page%5Bsize%5D=${PAGE_SIZE}&filter%5Bentity.legalName%5D=${encodeURIComponent(name)}`;

  let json;
  try {
    json = await fetchJson(url, { headers: { Accept: 'application/vnd.api+json' } });
  } catch (err) {
    return { error: err.message, matchSource: 'GLEIF' };
  }

  const candidates = (json.data ?? [])
    .map((r) => slim(r, score(r.attributes.entity.legalName?.name ?? '', name)))
    .sort((x, y) => y.score - x.score);

  if (candidates.length === 0) return null;
  const best = candidates[0];
  // 分数太低，或与次优并列 —— 不猜
  if (best.score < 0.75) return null;
  if (candidates[1] && candidates[1].score === best.score) return null;
  return best;
}

/** 尽量多试几个线索名，第一个命中的即采用 */
export async function lookup(nameHints) {
  for (const hint of nameHints) {
    const hit = await lookupByName(hint);
    if (hit?.error) return hit;
    if (hit) return { ...hit, queriedAs: hint };
  }
  return null;
}
