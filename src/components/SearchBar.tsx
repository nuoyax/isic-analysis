import { useEffect, useMemo, useRef, useState } from 'react';
import { COMPANY_COUNTS, searchCompaniesLocal, type Company } from '../data/companies';
import { probeApi, searchCompanies } from '../lib/api';
import { classByCode } from '../data/isic';

/** 下拉里最多这么多条 */
const CAP = 20;

interface Props {
  /** 选中一家公司 */
  onPick: (id: string) => void;
}

/**
 * 公司搜索框。**只搜公司**（不搜行业分类）。
 *
 * 数据源：有 API 走 `/api/search/companies`，探不到就回落本地的
 * `searchCompaniesLocal`（150 条，内存子串匹配）。两条路径都不阻塞输入。
 *
 * 键盘：↑↓ 移动、Enter 打开、Esc 收起。
 */
export function SearchBar({ onPick }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Company[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* debounce 200ms 后查询；输入为空直接清空 */
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits([]);
      setOpen(false);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      void (async () => {
        let got: Company[] | null = null;
        if (await probeApi()) got = await searchCompanies(query, CAP);
        if (!alive) return;
        setHits(got ?? searchCompaniesLocal(query, CAP));
        setOpen(true);
        setCursor(0);
      })();
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q]);

  /* 点外部收起 */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const hint = useMemo(
    () => `共 ${COMPANY_COUNTS.total} 家公司，可按中文名或英文名搜`,
    [],
  );

  return (
    <div className="searchbar" ref={boxRef}>
      <input
        ref={inputRef}
        type="search"
        className="search-input"
        placeholder="搜索公司…"
        aria-label="搜索公司"
        aria-expanded={open}
        aria-controls="search-results"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
            return;
          }
          if (!open || hits.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => (c + 1) % hits.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => (c - 1 + hits.length) % hits.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const picked = hits[cursor];
            if (picked) {
              onPick(picked.id);
              setOpen(false);
              setQ('');
            }
          }
        }}
      />

      {open && (
        <ul className="search-results" id="search-results" role="listbox" aria-label="搜索结果">
          {hits.length === 0 ? (
            <li className="search-empty">没有匹配的公司</li>
          ) : (
            hits.map((c, i) => {
              const cls = classByCode(c.classCode);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    className="search-item"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => {
                      onPick(c.id);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    <span className="nm">{c.name}</span>
                    <span className="en">{c.nameEn}</span>
                    <span className="tag">
                      {cls ? `${cls.code} · ${cls.name}` : c.classCode} · {c.country}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}

      <span className="sr-only">{hint}</span>
    </div>
  );
}
