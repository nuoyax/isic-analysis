import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SankeyChart } from './components/SankeyChart';
import { TableView } from './components/TableView';
import { NodeCard, type CardState } from './components/NodeCard';
import { SearchBar } from './components/SearchBar';
import { useTheme } from './hooks/useTheme';
import { categorical, chrome, type ThemeMode } from './theme/tokens';
import {
  buildModel,
  focusFromNode,
  LEVEL_COUNT,
  LEVEL_LABEL,
  LEVEL_OF,
  SECTION_SLOT,
  type Focus,
  type SankeyModel,
} from './lib/sankeyModel';
import { ZOOM_MAX, ZOOM_MIN } from './lib/sankeyOption';
import {
  allClasses,
  classByCode,
  divisionByCode,
  divisionOf,
  groupByCode,
  groupOfClass,
  ISIC_COUNTS,
  sectionByCode,
  sectionOf,
} from './data/isic';
import {
  COMPANIES,
  COMPANY_COUNTS,
  companiesOfClass,
  companiesOfDivision,
  companiesOfGroup,
  companiesOfSection,
  companyById,
  type Company,
} from './data/companies';

/** 门类代码 → 基色（ISIC 原序固定占槽，筛选不重绘） */
function makeColorOf(mode: ThemeMode) {
  const slots = categorical(mode);
  return (sectionCode: string) => {
    if (!sectionCode) return chrome(mode).muted;
    const slot = SECTION_SLOT[sectionCode] ?? 0;
    return slots[slot % slots.length];
  };
}

/** 取某个 focus 范围内的公司（全量数据在内存里，本地查询是唯一真值） */
function companiesInFocus(focus: Focus | null): Company[] {
  if (!focus) return COMPANIES;
  if (focus.kind === 'section') return companiesOfSection(focus.code);
  if (focus.kind === 'division') return companiesOfDivision(focus.code);
  if (focus.kind === 'group') return companiesOfGroup(focus.code);
  return companiesOfClass(focus.code);
}

/** focus 的层级标签与全名 */
function describeFocus(focus: Focus | null) {
  if (!focus) return { kind: '全部', code: '', name: '全部行业' };
  const kind = LEVEL_LABEL[focus.kind];
  if (focus.kind === 'section') {
    const s = sectionByCode(focus.code);
    return { kind, code: focus.code, name: s ? s.name : focus.code };
  }
  if (focus.kind === 'division') {
    const d = divisionByCode(focus.code);
    return { kind, code: focus.code, name: d ? d.name : focus.code };
  }
  if (focus.kind === 'group') {
    const g = groupByCode(focus.code);
    return { kind, code: focus.code, name: g ? g.name : focus.code };
  }
  const c = classByCode(focus.code);
  return { kind, code: focus.code, name: c ? c.name : focus.code };
}

/** focus → 从门类开始的自上而下路径（面包屑用）
 *
 *  自底向上走父链再反转，而不是「逐层 push + 补当前节点」——后者在
 *  focus 恰为 section/division/group 时会把当前节点 push 两遍。 */
function focusPath(focus: Focus | null): { label: string; focus: Focus | null }[] {
  const path: { label: string; focus: Focus | null }[] = [{ label: '全部行业', focus: null }];
  if (!focus) return path;

  /* 自底向上收集（当前节点 → 祖先），最后反转成自上而下。
     逐级显式 push，不用「补一条当前节点」那种写法 —— 那种写法在 focus 恰为
     section/division/group 时会把当前节点推两遍。 */
  const chain: { label: string; focus: Focus }[] = [];
  const labelOf = (code: string, name: string) => `${code} · ${name}`;

  const nameOf = (kind: Focus['kind'], code: string) => {
    if (kind === 'section') return sectionByCode(code)?.name;
    if (kind === 'division') return divisionByCode(code)?.name;
    if (kind === 'group') return groupByCode(code)?.name;
    return classByCode(code)?.name;
  };

  /* 当前节点 */
  chain.push({ label: labelOf(focus.code, nameOf(focus.kind, focus.code) ?? focus.code), focus });

  /* 祖先：中类（仅当前是小类时）→ 大类 → 门类。
     divisionOf / sectionOf 都按代码长度自动选索引，四种 kind 共用同一段。 */
  if (focus.kind === 'class') {
    const g = groupOfClass(focus.code);
    if (g) chain.push({ label: labelOf(g.code, g.name), focus: { kind: 'group', code: g.code } });
  }
  if (focus.kind !== 'section' && focus.kind !== 'division') {
    const d = divisionOf(focus.code);
    if (d) chain.push({ label: labelOf(d.code, d.name), focus: { kind: 'division', code: d.code } });
  }
  if (focus.kind !== 'section') {
    const s = sectionOf(focus.code);
    if (s) chain.push({ label: labelOf(s.code, s.name), focus: { kind: 'section', code: s.code } });
  }

  path.push(...chain.reverse());
  return path;
}

/** 按节点数估算画布高度：ECharts 会把内容压进给定高度，给少了节点会糊成一团 */
function estimateHeight(model: SankeyModel): number {
  const counts = new Array(LEVEL_COUNT).fill(0);
  for (const n of model.nodes) counts[LEVEL_OF[n.kind]] += 1;
  const byColumn = Math.max(...counts);
  return Math.max(460, Math.min(7200, byColumn * 13 + 56));
}

export default function App() {
  const [mode, setMode] = useTheme();
  const [focus, setFocus] = useState<Focus | null>(null);
  const [card, setCard] = useState<CardState | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [fullscreen, setFullscreen] = useState(false);

  const colorOf = useMemo(() => makeColorOf(mode), [mode]);
  const surface = chrome(mode).surface;

  const model = useMemo(
    () => buildModel({ focus, colorOf, surface, mode }),
    [focus, colorOf, surface, mode],
  );

  const height = useMemo(() => estimateHeight(model), [model]);

  /* 卡片里那个分类的本地公司（先本地后 API，见 NodeCard） */
  const cardFocus = card?.kind === 'scope' ? card.focus : null;
  const cardCompanies = useMemo(
    () => (cardFocus ? companiesInFocus(cardFocus) : []),
    [cardFocus],
  );

  const chartPaneRef = useRef<HTMLElement>(null);
  const chartScrollRef = useRef<HTMLDivElement>(null);
  /** 拖动中的指针起点与起始滚动位置；为 null 表示当前没在拖 */
  const panState = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  /* ── 缩放与空格拖动 ──────────────────────────────────────────────
     ECharts 的桑基图没有 roam，缩放只能自己算（见 SankeyChart）。缩放变化会
     让整张图重排，所以缩放前后要把视口中心**钉住**：记录画布在该点的占比，
     重排后按新尺寸还原回去，观感才是「以光标为中心放大」而不是「跳回左上角」。 */
  const [zoom, setZoom] = useState(1);
  /** 真正喂给 ECharts 的缩放。
   *
   *  为什么不直接用 zoom：缩放要让 ECharts 按新尺寸把 830 个方块 + 1200 条边
   *  重排重画，一次约 950ms（实测，dpr 1）。Alt+滚轮是连续的，每转一格都按
   *  zoom 重排的话，一秒钟里能卡好几下 —— 手感就是「卡」。所以滚轮期间只更新
   *  zoom（便宜：只改百分比文字、记锚点），等停下来再落一次几何。
   *  按钮点击是离散的，同样走这条路，代价是 140ms 后才看到图变化。 */
  const [geomZoom, setGeomZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const spaceRef = useRef(false);
  /** 缩放前记下的视口锚点：视口中心在画布里的归一化坐标，外加当时的画布尺寸 */
  const anchorRef = useRef<{ fx: number; fy: number; sw: number; sh: number } | null>(null);

  /* ── 加宽画布：中类 / 小类那两列是瓶颈 ──────────────────────────────
     列的行高由**高度**决定，而中间两列共有 721 个节点、标签又长得放不下。
     只往上加高度的话，多出来的空间全被压成节点之间的空隙，横向依旧挤成一团。
     所以放大或全屏时给画布一个更宽的基准（约 2.4 倍容器宽），让 ECharts 有
     横向余量把列摊开 —— 代价是横向也要滚动，这正是「上下左右拖」的用武之地。
     视口宽度由滚动容器量出来；基准宽是相对**容器**定义的，不能拿画布自己的
     宽度当基准，那会自我放大（见 .main 的 minmax(0,1fr) 注释）。
     容器太窄时 SankeyChart 会把画布收回容器宽，不会无谓地出现横向滚动。 */
  const chartWide = geomZoom > 1.05 || fullscreen;
  const [paneWidth, setPaneWidth] = useState(0);
  useLayoutEffect(() => {
    const el = chartScrollRef.current;
    if (!el) return;
    const measure = () => setPaneWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const canvasBase = useMemo(
    () => (chartWide ? Math.max(paneWidth * 2.4, 900) : undefined),
    [chartWide, paneWidth],
  );

  /** 记下当前视口中心在画布里的归一化位置，供重排后还原 */
  const markAnchor = useCallback(() => {
    const sc = chartScrollRef.current;
    if (!sc) return;
    /* 拖拽期间不动视口：每步按旧布局重算锚点，会在重排落地前把位置坐实，
       连续拖动就会一格一格往回吸。 */
    if (panState.current) return;
    anchorRef.current = {
      fx: (sc.scrollLeft + sc.clientWidth / 2) / Math.max(sc.scrollWidth, 1),
      fy: (sc.scrollTop + sc.clientHeight / 2) / Math.max(sc.scrollHeight, 1),
      sw: sc.scrollWidth,
      sh: sc.scrollHeight,
    };
  }, []);

  /** 缩放到绝对值（「回 100%」按钮用）。落几何同样延迟，见 settleZoom */
  const zoomTo = useCallback(
    (next: number) => {
      markAnchor();
      setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
    },
    [markAnchor],
  );

  /** 按倍率缩放。
   *
   *  必须用函数式更新：倍率要乘在**当时**的 zoom 上。写成
   *  `zoomTo(zoom * ratio)` 的话，同一批里连着调两次（连点「+」、或一次
   *  滚轮事件里连发）每次读到的都是同一个旧 zoom，第二次直接被吞掉。 */
  const zoomBy = useCallback(
    (ratio: number) => {
      markAnchor();
      setZoom((prev) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * ratio)));
    },
    [markAnchor],
  );

  /* 停手 140ms 后才把新倍率喂给 ECharts（见 geomZoom 的注释）。
     140ms 是手感与开销的折中：连续滚轮期间一直在重置计时器，只有真正停下来
     才付那一次约 950ms 的重排；单次点击则是 140ms 后看到图变化，感觉不到延迟。
     依赖里必须有 geomZoom —— 只在 zoom 变化时排程的话，上一次的 timeout 会
     被这个 effect 的清理函数取消掉，滚动停不下来时永远等不到落几何。 */
  useEffect(() => {
    if (zoom === geomZoom) return;
    const t = window.setTimeout(() => setGeomZoom(zoom), 140);
    return () => window.clearTimeout(t);
  }, [zoom, geomZoom]);

  /* 重排后把视口中心还原回原来的相对位置（「以光标为中心缩放」的观感）。
     轮询等重排落地，别数帧数：一帧给 React 把新画布宽高落进 DOM，还要等
     ECharts 重排完 scrollWidth/Height 才是新值，具体几帧不好定。判据用
     「画布尺寸相对记锚点时变了没有」—— 只看 scrollWidth 会在纵向重排先
     完成、横向还没跟上的中间态就收工，视口只还原了一半。
     依赖是 geomZoom：锚点是在滚轮期间记的，几何真正落地在这之后。 */
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const sc = chartScrollRef.current;
    if (!sc) return;
    anchorRef.current = null;
    if (!a) return;
    if (panState.current) return; // 拖拽期间不动视口
    let tries = 0;
    const settle = () => {
      if (sc.scrollWidth !== a.sw || sc.scrollHeight !== a.sh) {
        sc.scrollLeft = a.fx * sc.scrollWidth - sc.clientWidth / 2;
        sc.scrollTop = a.fy * sc.scrollHeight - sc.clientHeight / 2;
      }
      if (tries++ < 8) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }, [geomZoom]);

  /* Alt + 滚轮缩放；不按 Alt 直接滚就是普通滚动（纵向上下、Shift 纵向滚变横向）。
     必须 passive: false —— 缩放的默认行为与页面滚动都要 preventDefault 拦掉。 */
  useEffect(() => {
    const sc = chartScrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return; // 普通滚轮交还给浏览器滚动
      e.preventDefault();
      /* exp 而不是线性：缩放是乘性的，连续滚动的手感才均匀。
         走 zoomBy 的倍率式更新，别读闭包里的 zoom —— 高频滚轮下
         闭包可能落后好几帧，那样每转一格都会退回到旧倍率。 */
      zoomBy(Math.exp(-e.deltaY * 0.0016));
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  /* 空格 = 抓手。按下空格进拖拽模式（光标变 grab），拖动改 scrollLeft/Top。
     空格默认会滚动页面、也会触发按钮，所以按住期间要拦掉默认行为；
     但焦点在输入框里时不拦（用户可能真的想打空格）。 */
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target)) return;
      if (!spaceRef.current) {
        spaceRef.current = true;
        setPanning(true);
      }
      e.preventDefault(); // 阻止页面滚动与按钮「按下」
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      setPanning(false);
    };
    /* 切走窗口时空格的 keyup 收不到，回来会一直卡在拖拽态 */
    const onBlur = () => {
      spaceRef.current = false;
      setPanning(false);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const onPanePointerDown = useCallback((e: React.PointerEvent) => {
    if (!spaceRef.current) return;
    const sc = chartScrollRef.current;
    if (!sc) return;
    panState.current = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
    /* 指针捕获让拖出容器也不丢事件。合成事件（无真实指针）会抛 NotFoundError，
       捕获失败不影响拖动本身，吞掉即可。 */
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 没有真实指针就算 */
    }
    e.preventDefault();
  }, []);

  const onPanePointerMove = useCallback((e: React.PointerEvent) => {
    const p = panState.current;
    const sc = chartScrollRef.current;
    if (!p || !sc) return;
    sc.scrollLeft = p.left - (e.clientX - p.x);
    sc.scrollTop = p.top - (e.clientY - p.y);
    e.preventDefault();
  }, []);

  const endPan = useCallback((e: React.PointerEvent) => {
    if (!panState.current) return;
    panState.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已经释放过就算了 */
    }
  }, []);

  /** 点桑基图节点：下钻 + 弹卡片 */
  const handleNodeClick = useCallback(
    (nodeId: string) => {
      const node = model.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const next = focusFromNode(node);
      // 已经聚焦在该节点上 → 再点一次回到全部
      const same = focus != null && focus.kind === next.kind && focus.code === next.code;
      const target = same ? null : next;
      setFocus(target);
      setCard(target ? { kind: 'scope', focus: target } : null);
    },
    [model, focus],
  );

  /** 搜索到一家公司 → 直接打开它的详情卡片 */
  const openCompany = useCallback((id: string) => {
    setCard((prev) => ({
      kind: 'company',
      id,
      back: prev?.kind === 'scope' ? prev.focus : null,
    }));
  }, []);

  /** 表格视图里点公司名 */
  const pickFromTable = useCallback((id: string) => {
    setCard({ kind: 'company', id, back: null });
  }, []);

  /* ── 全屏 ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = chartPaneRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  }, []);

  /* ── 键盘 ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 已经打开的 dialog / 全屏各自吞掉 Esc，这里只管图上逐层退回
      if (document.fullscreenElement) return;
      if (document.querySelector('dialog[open]')) return;
      setFocus((prev) => (prev ? null : prev));
      setCard(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const crumbPath = useMemo(() => focusPath(focus), [focus]);
  const scope = describeFocus(focus);
  const coveredClasses = allClasses.filter((c) => companiesOfClass(c.code).length > 0).length;
  const cardCompaniesShown = cardFocus ? cardCompanies.length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>ISIC 产业结构分析</h1>
          <span className="sub">Rev.5 · 门类 → 大类 → 中类 → 小类</span>
        </div>

        <nav className="crumbs" aria-label="层级导航">
          {crumbPath.map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span className="sep" aria-hidden="true">/</span>}
              <button
                type="button"
                className="crumb"
                aria-current={i === crumbPath.length - 1}
                onClick={() => {
                  setCard(null);
                  setFocus(c.focus);
                }}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>

        <div className="toolbar">
          <SearchBar onPick={openCompany} />
          <button
            type="button"
            className="btn"
            aria-pressed={view === 'table'}
            onClick={() => setView(view === 'chart' ? 'table' : 'chart')}
          >
            {view === 'chart' ? '表格视图' : '图形视图'}
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={mode === 'dark'}
            onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
          >
            {mode === 'dark' ? '浅色' : '深色'}
          </button>
        </div>
      </header>

      <div className="stat-row">
        <div className="stat"><span className="v">{ISIC_COUNTS.sections}</span><span className="k">门类 Section</span></div>
        <div className="stat"><span className="v">{ISIC_COUNTS.divisions}</span><span className="k">大类 Division</span></div>
        <div className="stat"><span className="v">{ISIC_COUNTS.groups}</span><span className="k">中类 Group</span></div>
        <div className="stat"><span className="v">{ISIC_COUNTS.classes}</span><span className="k">小类 Class</span></div>
        <div className="stat"><span className="v">{COMPANY_COUNTS.total}</span><span className="k">收录公司</span></div>
        <div className="stat"><span className="v">{COMPANY_COUNTS.countries}</span><span className="k">国家 / 地区</span></div>
        <div className="stat"><span className="v">{coveredClasses}</span><span className="k">已覆盖小类</span></div>
        <div className="stat"><span className="v">{COMPANY_COUNTS.corroborated}</span><span className="k">有外部源佐证</span></div>
      </div>

      <main className="main">
        <section
          className={'chart-pane' + (panning ? ' is-panning' : '') + (chartWide ? ' is-wide' : '')}
          aria-label="ISIC 结构桑基图"
          ref={chartPaneRef}
        >
          <div className="chart-head">
            <span className="t">产业结构桑基图</span>
            <span className="hint">
              带宽 = 收录公司数（空分类按 1 计）· 点击方块看公司列表 · Alt + 滚轮缩放 · 按住空格上下左右拖动
            </span>
            <span className="spacer" />
            <div className="zoom-group" role="group" aria-label="缩放">
              <button
                type="button"
                className="btn"
                onClick={() => zoomBy(1 / 1.25)}
                disabled={zoom <= ZOOM_MIN + 1e-6}
                aria-label="缩小"
              >
                −
              </button>
              <button
                type="button"
                className="btn zoom-value"
                onClick={() => zoomTo(1)}
                title="恢复到 100%"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => zoomBy(1.25)}
                disabled={zoom >= ZOOM_MAX - 1e-6}
                aria-label="放大"
              >
                +
              </button>
            </div>
            <button
              type="button"
              className="btn"
              aria-pressed={fullscreen}
              onClick={toggleFullscreen}
            >
              {fullscreen ? '⤡ 退出全屏' : '⛶ 全屏'}
            </button>
          </div>
          <div
            className="chart-scroll"
            ref={chartScrollRef}
            onPointerDown={onPanePointerDown}
            onPointerMove={onPanePointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            {view === 'chart' ? (
              <SankeyChart
                model={model}
                mode={mode}
                baseHeight={height}
                baseWidth={canvasBase}
                zoom={geomZoom}
                onNodeClick={handleNodeClick}
                scrollRef={chartScrollRef}
              />
            ) : (
              <TableView
                model={model}
                companies={companiesInFocus(focus)}
                colorOf={colorOf}
                onPickCompany={pickFromTable}
              />
            )}
          </div>
        </section>
      </main>

      <NodeCard
        state={card}
        localCompanies={cardCompanies}
        companyById={companyById}
        colorOf={colorOf}
        crumbOf={focusPath}
        focus={focus}
        onClose={() => setCard(null)}
        onOpenCompany={openCompany}
        onBackToScope={() => {
          setCard((prev) =>
            prev?.kind === 'company' && prev.back ? { kind: 'scope', focus: prev.back } : null,
          );
        }}
        onApplyFocus={(next) => {
          setFocus(next);
          setCard(next ? { kind: 'scope', focus: next } : null);
        }}
      />

      <p className="sr-only" aria-live="polite">
        当前范围 {scope.kind} {scope.name}，共 {companiesInFocus(focus).length} 家公司
        {card?.kind === 'company' ? '，已打开公司详情' : ''}
        {cardCompaniesShown > 0 ? `，卡片列出 ${cardCompaniesShown} 家` : ''}
      </p>
    </div>
  );
}
