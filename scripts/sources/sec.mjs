/**
 * SEC EDGAR —— 美国上市公司登记信息，无需 API key（但要求带 User-Agent）。
 *
 * 能给什么：CIK、官方登记名、在交易所挂牌的股票代码、**SEC 自己登记的 SIC 行业码**。
 * 不能给什么：ISIC 分类。SIC 与 ISIC 是两套体系，所以 sic 字段**只作参考展示**，
 *            绝不参与本项目的 ISIC 归类。
 *
 * 覆盖范围仅限向 SEC 申报的美国主体 —— 中国 A 股 / 港股公司在这里查不到是正常的，
 * 不算失败。
 */

import { fetchJson } from './http.mjs';

const UA = 'isic-industry-analysis/0.1 (data collection script; contact: developer@example.com)';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

let tickerIndex = null;

/** 全量 ticker → {cik, title} 索引，一个文件 1 MB 左右，缓存后复用 */
async function loadTickers() {
  if (tickerIndex) return tickerIndex;
  const json = await fetchJson(TICKERS_URL, { headers: { 'User-Agent': UA } });
  tickerIndex = new Map();
  for (const row of Object.values(json)) {
    if (!row?.ticker) continue;
    tickerIndex.set(row.ticker.toUpperCase(), {
      cik: String(row.cik_str).padStart(10, '0'),
      title: row.title ?? '',
    });
  }
  return tickerIndex;
}

/**
 * 按股票代码查。
 *
 * 种子里的 ticker 写成 "XOM.NYSE" / "9618.HK / JD.NASDAQ"（可能多市场并列），
 * 所以要先拆。**只剥美国交易所后缀**（.NYSE / .NASDAQ / .OTC / .AMEX），
 * 别的后缀一律不动 —— 因为剥掉 .PA / .DE 会把 达能(BN.PA) 错配成
 * Brookfield(BN)、施耐德(SU.PA) 错配成 Suncor(SU)、安联(ALV.DE) 错配成
 * Autoliv(ALV)。这是实测踩过的坑，宁可判为"查不到"，也不给错的公司。
 */

const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'OTC', 'AMEX', 'NYSEARCA', 'BATS']);

/** "XOM.NYSE" → ["XOM"]；"9618.HK" → []；"JD" → ["JD"] */
function usTickerCandidates(raw) {
  const out = [];
  for (const part of raw.split('/')) {
    const t = part.trim().toUpperCase();
    if (!t) continue;
    const dot = t.lastIndexOf('.');
    if (dot === -1) {
      if (/^[A-Z][A-Z0-9-]{0,5}$/.test(t)) out.push(t);
      continue;
    }
    const base = t.slice(0, dot);
    const exch = t.slice(dot + 1);
    if (US_EXCHANGES.has(exch) && /^[A-Z][A-Z0-9-]{0,5}$/.test(base)) out.push(base);
  }
  return out;
}

export async function lookupByTicker(raw) {
  if (!raw?.trim()) return null;

  const candidates = usTickerCandidates(raw);
  if (candidates.length === 0) return null;

  let index;
  try {
    index = await loadTickers();
  } catch (err) {
    return { error: err.message, matchSource: 'SEC' };
  }

  const ticker = candidates.find((t) => index.has(t));
  if (!ticker) return null;

  const hit = index.get(ticker);
  return {
    cik: hit.cik,
    legalName: hit.title,
    ticker,
    cikUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${hit.cik}&type=10-K`,
    submissionsUrl: `https://data.sec.gov/submissions/CIK${hit.cik}.json`,
    matchSource: 'SEC',
    matchType: 'ticker',
  };
}

/**
 * 取申报主体详情（含 SEC 登记的 SIC，仅作参考展示）。
 * 拿不到时返回 null —— 基本信息已经够用，不因为这一步失败就丢掉主体。
 */
export async function submissions(cik) {
  if (!cik) return null;
  try {
    const json = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': UA },
    });
    return {
      sic: json.sic ?? '',
      sicDescription: json.sicDescription ?? '',
      stateOfIncorporation: json.stateOfIncorporation ?? '',
      fiscalYearEnd: json.fiscalYearEnd ?? '',
      formerNames: (json.formerNames ?? []).map((n) => n.name).filter(Boolean),
    };
  } catch {
    return null;
  }
}
