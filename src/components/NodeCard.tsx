import { useCallback, useEffect, useRef, useState } from 'react';
import type { Company } from '../data/companies';
import { fetchCompanies, probeApi } from '../lib/api';
import type { Focus } from '../lib/sankeyModel';
import { CompanyPanel } from './CompanyPanel';
import { CompanyDetail } from './CompanyDetail';

/** 卡片里最多列这么多家（用户要求）；实际每个分类至多约 10 家，这是安全阀 */
const LIST_CAP = 100;

/** 卡片内容：一个分类的公司列表，或一家公司的详情 */
export type CardState =
  | { kind: 'scope'; focus: Focus }
  | { kind: 'company'; id: string; back: Focus | null };

interface Props {
  /** null = 卡片关闭 */
  state: CardState | null;
  /** 该分类在**本地**数据里的公司（立即渲染；API 可用时用 API 结果覆盖） */
  localCompanies: Company[];
  /** 由 id 取公司（本地） */
  companyById: (id: string) => Company | undefined;
  colorOf: (sectionCode: string) => string;
  /** focus → 面包屑（App 提供，与顶栏同一份实现） */
  crumbOf: (focus: Focus | null) => { label: string }[];
  /** 当前已应用到图上的 focus */
  focus: Focus | null;
  onClose: () => void;
  /** 卡片里点了一家公司 */
  onOpenCompany: (id: string) => void;
  /** 详情里点「返回公司列表」 */
  onBackToScope: () => void;
  /** 在图上只看这一支 / 恢复全量 */
  onApplyFocus: (focus: Focus | null) => void;
}

/**
 * 节点卡片：**原生 `<dialog>` + `showModal()`**。
 *
 * 用原生 dialog 而不是手写浮层，是为了白拿浏览器自带的
 * Esc 关闭 / 焦点陷阱 / `::backdrop` / `aria-modal` 语义。
 *
 * 关闭方式三种：右上角 ✕、Esc（原生）、点遮罩（原生）。
 */
export function NodeCard({
  state,
  localCompanies,
  companyById,
  colorOf,
  crumbOf,
  focus,
  onClose,
  onOpenCompany,
  onBackToScope,
  onApplyFocus,
}: Props) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [rows, setRows] = useState<Company[] | null>(null);
  const [loading, setLoading] = useState(false);
  /** 卡片内搜索：只过滤**这个分类下**的公司，不跨分类 */
  const [query, setQuery] = useState('');
  const cleanup = useRef<(() => void) | null>(null);
  /* onClose 每次渲染都是新函数，用 ref 转一手，别让监听器跟着重建 */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const open = state !== null;

  /* 打开 / 关闭：dialog 自己维护 top layer */
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  /* 监听器挂在 ref 回调里，而不是 useEffect([])。
     `state === null` 时组件返回 null，effect 首次运行时 ref.current 还是 null；
     空依赖的 effect 不会因为 dialog 后来才挂上而重跑，监听器就永远装不上。
     —— 这正是「✕ 能关、Esc 关不掉」的原因：原生 Esc 关掉了 dialog，
     但没人接 close 事件去同步 state，于是 effect 又把它 showModal 回来。 */
  const attach = useCallback((dlg: HTMLDialogElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    ref.current = dlg;
    if (!dlg) return;
    const onDialogClose = () => onCloseRef.current();
    const onClick = (e: MouseEvent) => {
      /* 点遮罩关闭**不是** dialog 的默认行为（规范只要求 Esc），得自己判。
         遮罩没有独立节点，它的点击目标就是 dialog 本身；再比一次坐标，
         排除「点在卡片内部但落在内边距上」的情况。 */
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dlg.close();
    };
    dlg.addEventListener('close', onDialogClose);
    dlg.addEventListener('click', onClick);
    cleanup.current = () => {
      dlg.removeEventListener('close', onDialogClose);
      dlg.removeEventListener('click', onClick);
    };
  }, []);
  useEffect(() => () => cleanup.current?.(), []);

  /* 公司列表：先用本地数据立即渲染，再问一次 API（可用时以 API 为准）。
     详情形态不发请求 —— 本地已有全部 150 家，多一次往返没有意义。 */
  const scopeFocus = state?.kind === 'scope' ? state.focus : null;
  useEffect(() => {
    setRows(null);
    setQuery('');
    if (!scopeFocus) return;
    let alive = true;

    void (async () => {
      if (!(await probeApi())) return; // 回落：渲染时直接用 localCompanies
      setLoading(true);
      const key = scopeFocus.kind;
      const got = await fetchCompanies({ [key]: scopeFocus.code, limit: LIST_CAP + 1 });
      if (!alive) return;
      setLoading(false);
      if (!got) return; // 本次失败 → 回落本地
      setRows(got);
    })();

    return () => {
      alive = false;
    };
  }, [scopeFocus]);

  if (!state) return null;

  const isCompany = state.kind === 'company';
  const company = isCompany ? companyById(state.id) : undefined;
  const list = isCompany ? [] : rows ?? localCompanies;
  /* 卡片内搜索：本地过滤已加载的那份列表，再走 API 就是绕远路
     （这个分类的公司已经全在手上，150 条量级内存过滤是瞬时的）。 */
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter(
        (c) => c.name.toLowerCase().includes(q) || c.nameEn.toLowerCase().includes(q),
      )
    : list;
  const shown = filtered.slice(0, LIST_CAP);
  const capped = filtered.length > LIST_CAP;
  const crumbs = crumbOf(isCompany ? state.back : scopeFocus);
  const title = crumbs[crumbs.length - 1]?.label ?? '全部行业';

  return (
    <dialog
      ref={attach}
      className="node-card"
      aria-label={isCompany ? '公司详情' : '公司列表'}
    >
      <div className="node-card-head">
        <div className="node-card-title">
          <strong>{isCompany ? company?.name ?? '公司详情' : title}</strong>
          {!isCompany && (
            <span className="meta">
              收录 {list.length} 家公司
              {q ? ` · 匹配 ${filtered.length} 家` : ''}
            </span>
          )}
        </div>
        <span className="spacer" />
        {!isCompany && list.length > 1 && (
          <input
            type="search"
            className="search-input node-card-search"
            value={query}
            placeholder="在本分类内搜索"
            aria-label="在本分类内搜索公司"
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {!isCompany && (
          <button
            type="button"
            className="btn"
            aria-pressed={focus !== null}
            onClick={() => onApplyFocus(focus ? null : scopeFocus)}
            title={focus ? '恢复显示全部门类' : '在图上只展开这一支'}
          >
            {focus ? '← 回到全部行业' : '仅看这一支'}
          </button>
        )}
        <button type="button" className="btn" onClick={onClose} aria-label="关闭卡片">
          ✕
        </button>
      </div>

      {crumbs.length > 1 && (
        <nav className="node-card-crumbs" aria-label="层级归属">
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span className="sep" aria-hidden="true">/</span>}
              <span className="crumb-static">{c.label}</span>
            </span>
          ))}
        </nav>
      )}

      <div className="node-card-body">
        {isCompany ? (
          company ? (
            <CompanyDetail company={company} colorOf={colorOf} onBack={onBackToScope} />
          ) : (
            <p className="empty">未找到该公司（{state.id}）。</p>
          )
        ) : loading && list.length === 0 ? (
          <p className="empty">正在读取…</p>
        ) : q && filtered.length === 0 ? (
          <p className="empty">本分类下没有匹配「{query.trim()}」的公司。</p>
        ) : (
          <>
            <CompanyPanel
              companies={shown}
              selectedId={null}
              colorOf={colorOf}
              onSelect={onOpenCompany}
            />
            {capped && (
              <p className="empty">仅显示前 {LIST_CAP} 家。</p>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
