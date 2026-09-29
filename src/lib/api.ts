import type { Company } from '../data/companies';

/**
 * 本地 API 客户端 —— 指向 `server/index.mjs`（SQLite 上的极简 HTTP 服务）。
 *
 * **这是渐进增强，不是必需品。** 页面在完全没有 API 的情况下必须完整可用：
 *   · 启动时探测一次 `/api/health`，探不到就永久走本地回落，不再发任何请求；
 *   · 每个请求都判 `res.ok` 与 `content-type`，且带 3s 超时；
 *   · 任何失败一律返回 `null`，由调用方回落到 `src/data/companies.ts` 的内存查询。
 *
 * 为什么不 "每次调用 try/catch"：Vite 的 proxy 在后端没起时返回的是
 * **500 空 body**（不是断连），若只看网络异常会把 500 误当成功；
 * 而每次失败都会让 Vite 终端刷一片红色 proxy error —— 探测一次即可两条都避开。
 */

const PROBE_TIMEOUT = 800;
const REQUEST_TIMEOUT = 3000;

let available: boolean | null = null;

/** 探测一次 API 是否可用；结果缓存到页面生命周期结束 */
export async function probeApi(): Promise<boolean> {
  if (available !== null) return available;
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    const ct = res.headers.get('content-type') ?? '';
    available = res.ok && ct.includes('application/json');
  } catch {
    available = false;
  }
  return available;
}

async function getJson<T>(path: string): Promise<T | null> {
  if (!(await probeApi())) return null;
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 服务端返回的公司对象与 `companies.generated.json` 里的元素同形 */
export function fetchCompanies(params: {
  section?: string;
  division?: string;
  group?: string;
  class?: string;
  q?: string;
  limit?: number;
}): Promise<Company[] | null> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  return getJson<Company[]>(`/api/companies?${qs.toString()}`);
}

export function fetchCompany(id: string): Promise<Company | null> {
  return getJson<Company>(`/api/companies/${encodeURIComponent(id)}`);
}

export function searchCompanies(q: string, limit = 20): Promise<Company[] | null> {
  return getJson<Company[]>(
    `/api/search/companies?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
}
