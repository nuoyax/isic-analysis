/**
 * 采集用的 HTTP 层：缓存 + 重试 + 限速。
 *
 * 采集脚本的价值在于**可离线重跑**：所有响应按 URL 落盘到 scripts/cache/http/，
 * 命中缓存就不再发请求（--offline 则只读缓存，绝不联网）。这样即使源站挂了、
 * 或者网络环境变了，生成文件仍然可复现。
 *
 * 不引入任何依赖，只用 Node 内置 https。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = join(ROOT, 'scripts', 'cache', 'http');

const offline = process.argv.includes('--offline');
export const isOffline = offline;

const cachePath = (url, ext) =>
  join(CACHE_DIR, `${createHash('sha256').update(url).digest('hex').slice(0, 20)}.${ext}`);

function rawGet(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30_000, headers }, (res) => {
      const { statusCode = 0 } = res;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error('重定向次数过多'));
        return resolve(rawGet(new URL(res.headers.location, url).href, headers, redirects + 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取文本。opts.fresh 为 true 时跳过缓存重新抓（用于强制刷新）。
 * 网络失败时退回缓存；缓存也没有就抛错 —— 不会静默返回空。
 */
export async function fetchText(url, { headers = {}, fresh = false, ext = 'txt' } = {}) {
  const file = cachePath(url, ext);

  if (!fresh) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      /* 未命中缓存，继续 */
    }
  }

  if (offline) {
    throw new Error(`--offline 模式下没有缓存：${url}\n  （先联网跑一次以填充 scripts/cache/http/）`);
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { status, body } = await rawGet(url, headers);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, body, 'utf8');
      await sleep(150); // 温和限速，别把公共 API 打疼
      return body;
    } catch (err) {
      lastErr = err;
      await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`请求失败：${url}\n  ${lastErr?.message ?? '未知错误'}`);
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, ext: 'json' });
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`返回的不是合法 JSON：${url}\n  ${err.message}`);
  }
}
