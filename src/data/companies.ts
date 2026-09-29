/**
 * 公司数据 —— 读 src/data/companies.generated.json（由 `npm run collect` 生成）。
 *
 * ⚠️ 数据构成，请如实理解：
 *   · **归类是人工的**。`classCode`（ISIC Rev.5 小类）与中文业务描述来自
 *     scripts/seed/companies.seed.json，由人逐家判定；不存在能自动判定 ISIC
 *     归类的外部数据源，所以这部分是主观的、粗粒度的。
 *   · **身份字段是外部权威源来的**。`gleif` 段的官方法人名 / 国别 / 城市 /
 *     成立日期取自 GLEIF 法人库（LEI），`sec` 段的 CIK / 股票代码 / SEC 登记的
 *     SIC 取自 SEC EDGAR。它们只用于校对身份，**不参与 ISIC 归类**。
 *   · 未能在外部源匹配到的公司，对应字段留空，绝不推算。
 *
 * 要改数据：改 scripts/seed/companies.seed.json（人工真值），再跑 `npm run collect`。
 * 不要直接编辑 companies.generated.json。
 */

import generated from './companies.generated.json';
import { allGroups, divisionByCode, sectionByCode } from './isic';

export type SizeBand = '巨头' | '大型' | '中型' | '小型';

/** GLEIF 法人库富化字段（官方登记信息） */
export interface GleifRecord {
  lei: string;
  legalName: string;
  country: string;
  city: string;
  region: string;
  legalForm: string;
  registrationDate: string;
  registrationStatus: string;
  /** 名称匹配置信度 0–1；低于 0.75 的不会被写进来 */
  score: number;
  queriedAs: string;
}

/** SEC EDGAR 富化字段（仅美国申报主体） */
export interface SecRecord {
  cik: string;
  legalName: string;
  ticker: string;
  cikUrl: string;
  /** SEC 自行登记的 SIC 行业码 —— 与 ISIC 是两套体系，仅作参考展示 */
  sic: string;
  sicDescription: string;
  stateOfIncorporation: string;
}

export interface Company {
  id: string;
  name: string;
  nameEn: string;
  country: string;
  hq: string;
  founded: number;
  ticker?: string;
  size: SizeBand;
  /** ISIC Rev.5 小类代码（4 位），必须存在于 data/isic.ts */
  classCode: string;
  business: string;
  products: string;
  desc: string;
  website?: string;
  tags?: string[];
  gleif?: GleifRecord;
  sec?: SecRecord;
}

export interface DataSource {
  name: string;
  url: string;
  sha256?: string;
}

interface GeneratedFile {
  _generatedBy: string;
  _note: string;
  sources: Record<string, DataSource>;
  companies: Company[];
}

const file = generated as unknown as GeneratedFile;

export const COMPANIES: Company[] = file.companies;

/** 生成文件里记录的溯源信息（详情页展示数据来源用） */
export const DATA_SOURCES: DataSource[] = Object.values(file.sources ?? {});

/* ---------- 查询 ---------- */

export function companiesOfClass(classCode: string): Company[] {
  return COMPANIES.filter((c) => c.classCode === classCode);
}

/** 小类代码集合 → 公司（大类 / 中类 / 门类查询共用） */
function companiesOfCodes(codes: Iterable<string>): Company[] {
  const set = new Set(codes);
  return COMPANIES.filter((c) => set.has(c.classCode));
}

export function companiesOfGroup(groupCode: string): Company[] {
  const group = allGroups.find((g) => g.code === groupCode);
  if (!group) return [];
  return companiesOfCodes(group.classes.map((c) => c.code));
}

export function companiesOfDivision(divisionCode: string): Company[] {
  const division = divisionByCode(divisionCode);
  if (!division) return [];
  return companiesOfCodes(division.groups.flatMap((g) => g.classes.map((c) => c.code)));
}

export function companiesOfSection(sectionCode: string): Company[] {
  const section = sectionByCode(sectionCode);
  if (!section) return [];
  return companiesOfCodes(
    section.divisions.flatMap((d) => d.groups.flatMap((g) => g.classes.map((c) => c.code))),
  );
}

export function companyById(id: string): Company | undefined {
  return COMPANIES.find((c) => c.id === id);
}

/**
 * 本地子串搜索（API 不可用时的回落路径）。
 *
 * 中文按原样匹配；英文名统一转小写再比。150 条数据上做全表扫描是微秒级，
 * 不值得为它建索引。
 */
export function searchCompaniesLocal(query: string, limit = 20): Company[] {
  const q = query.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const hitAscii = /^[\x20-\x7e]+$/.test(q);
  const out: Company[] = [];
  for (const c of COMPANIES) {
    const nameHit = c.name.includes(q);
    const enHit = hitAscii
      ? c.nameEn.toLowerCase().includes(lower)
      : c.nameEn.includes(q);
    if (nameHit || enHit) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export const COMPANY_COUNTS = {
  total: COMPANIES.length,
  countries: new Set(COMPANIES.map((c) => c.country)).size,
  /** 有外部权威源佐证身份的公司数 */
  corroborated: COMPANIES.filter((c) => c.gleif || c.sec).length,
};
