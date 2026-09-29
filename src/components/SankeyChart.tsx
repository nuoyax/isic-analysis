import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { buildChartOption } from '../lib/sankeyOption';
import type { SankeyModel } from '../lib/sankeyModel';
import type { ThemeMode } from '../theme/tokens';

/**
 * 位图预算（设备像素数）。
 *
 * 桑基图的画布天生巨大：830 个节点按行高排下来 6000px 高，宽屏基准再加宽，
 * 100% 就已经是千万级 CSS 像素。开销是 **面积 × dpr²** —— 鼠标扫过节点时
 * emphasis 让其余图元变暗，几乎全图都算脏区，于是每一帧都在重画整张位图。
 * 156% 缩放一张 2477×9492 的画布实测 300~900ms 一帧（prof11）。
 *
 * 所以按画布大小退档：预算以内取满原生 dpr，超了逐级降。档位离散
 * （0.75/1/1.25/1.5/1.75/2），避开阈值附近来回抖。
 *
 * 1600 万这条线是实测定的（ab17/ab19，1600×1000 @dpr2 下扫 40 个 mousemove 取 p95）。
 * 关键是 100%（1585×6075 = 9.63M CSS 像素）这一档 —— 用户待得最久的一屏：
 *   100%   dpr 1.75  位图 2773×10631（29.5M 设备像素）  p95 486~637ms   ← 30M 预算
 *          dpr 1.5   位图 2377×9112（21.7M）           p95 396~474ms
 *          dpr 1.25  位图 1981×7593（15.0M）           p95 116~119ms   ← 16M 预算
 *          dpr 1     位图 1585×6075（9.6M）            p95  92~101ms
 * 1.5 与 1.25 之间是一道断崖，所以取 1.25：比原生 2 软一档，但节点标签仍然清楚
 * （real-100.png），扫动的 p95 从 ~500ms 掉到 ~116ms —— 用户抱怨的正是这个。
 *
 * 预算取 16M 而不是 15M：room = √(budget/面积) 之后再往下取整会丢掉不少，
 * 15M 在 100% 处 room=1.248，卡在 1.25 档线下面、直接掉到 1，白白糊掉一档。
 * 16M 给 room=1.289，100% 落在 1.25；127%（1981×7594=15.0M）room=1.03 落 1，
 * 156%（2477×9492=23.5M）room=0.825 落 0.75 —— 三档的设备像素都收敛在 13~15M。
 *
 * 但设备像素面积**不是**全部开销：100% @1.25 与 127% @1 的位图完全一样
 * （都是 1981×7593），实测 p95 却是 124 对 245~267ms，差了一倍。多出来的部分
 * 只跟 **CSS 面积**走（1981×7594 对 1585×6075）—— 命中测试、脏区计算、
 * 逐图元遍历都在 CSS 坐标里做。所以 127% 是当前最贵的一档，但仍在 250ms
 * 上下，比改动前的 100%（p95 ~500ms）好一倍，可接受。
 *
 * 放大后画布是乘性增长的，同样的预算会落到 1 以下（见 pickDpr 的 allowSubUnit）——
 * 放大看的是结构，不是像素级细节，0.75 实测 p95 ~125ms，可读。
 * dpr 1 的屏幕上这个预算永不生效（ladder 上限即原生）。
 */
const PIXEL_BUDGET = 16_000_000;

/** 在 [1, 原生] 里挑一档能塞进预算的 dpr。档位离散，避免阈值附近来回抖。
 *  放大路径下允许降到 1 以下（放大看的是结构，不是像素级细节）。 */
function pickDpr(cssW: number, cssH: number, allowSubUnit: boolean): number {
  const native = window.devicePixelRatio || 1;
  const room = Math.sqrt(PIXEL_BUDGET / Math.max(cssW * cssH, 1));
  const ladder = allowSubUnit ? [0.75, 1, 1.25, 1.5, 1.75, 2] : [1, 1.25, 1.5, 1.75, 2];
  let best = ladder[0];
  for (const s of ladder) {
    if (s <= native + 1e-6 && s <= room + 1e-6) best = s;
  }
  return allowSubUnit ? Math.max(best, 0.75) : Math.max(best, 1);
}

/** 按尺寸重排，并按位图预算先切 dpr 档。
 *
 *  顺序要紧：先切 dpr 再 resize。切档只改 painter.dpr 是不够的 —— 每个图层
 *  自己存着一份 dpr，画布位图尺寸（`dom.width = w * dpr`）和 `ctx.dpr`
 *  （绘制时 `setTransform(dpr,…)` 靠它）都读图层那份。只改 painter 的话，
 *  位图仍是旧尺寸、变换也还是旧 dpr，画面会错位。所以逐层同步。
 *  随后这一次 resize 就是按最终尺寸 + 最终 dpr 画一遍 —— 反过来先 resize
 *  的话会先按旧 dpr 画一张（贵的那张），再全部推倒重来。 */
function resizeWithBudget(chart: echarts.ECharts, w: number, h: number, zoomed: boolean) {
  const next = pickDpr(w, h, zoomed);
  const painter = chart.getZr().painter as unknown as PaintWithDpr;
  if (painter.dpr !== next) {
    painter.dpr = next;
    const layers = painter._layers;
    if (layers) {
      for (const id of Object.keys(layers)) {
        const layer = layers[id] as { dpr: number; ctx?: { dpr: number } };
        layer.dpr = next;
        if (layer.ctx) layer.ctx.dpr = next;
      }
    }
    /* 关键：把 painter 缓存的尺寸作废。painter.resize 里有
       `if (this._width !== width || height !== this._height)` 的短路 ——
       尺寸没变就直接 return，图层的位图仍停在旧 dpr 那一张。
       100% 静置时尺寸恰好没变，实测就是这里漏掉：painter.dpr 已经是 1，
       画布位图却还是 2 倍（3170×12150），白占 147MB。 */
    painter._width = -1;
    painter._height = -1;
  }
  chart.resize({ width: w, height: h });
}

/** zrender 没有公开 painter 的 dpr / 图层表，这里按用到的字段收窄 */
interface PaintWithDpr {
  dpr: number;
  _width?: number;
  _height?: number;
  _layers?: Record<string, unknown>;
}

interface Props {
  model: SankeyModel;
  mode: ThemeMode;
  /** 未缩放的画布高度（由节点数估算，外层负责滚动） */
  baseHeight: number;
  /** 缩放倍率，由 App 统一持有（工具栏按钮与滚轮共用同一个值） */
  zoom: number;
  /**
   * 画布基准宽度（像素）。不传则画布宽 = 容器宽（`width: 100%`）。
   * App 在放大 / 全屏时会传一个更宽的值，把中间两列摊开（原因见 buildChartOption）。
   * 给定后画布尺寸完全由 React 控制，不再依赖 `resize()` 去读容器。
   */
  baseWidth?: number;
  onNodeClick: (nodeId: string) => void;
  /** 把承载滚动的祖先元素交给 App —— 空格拖动要靠它改 scrollTop/Left */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * 桑基图容器。
 *
 * ECharts 实例只 init 一次，之后所有变化都走 setOption(notMerge)；
 * 点击回调放进 ref，避免回调身份变化导致实例反复重建（会丢动画与滚动位置）。
 *
 * **缩放不是 `transform: scale()`。** 那会拉伸位图、放大了就糊。这里把画布的
 * 宽高本身按 zoom 放大，几何量（行高 / 字号 / 节点宽 / 边距）一起进 option，
 * 由 ECharts 按新尺寸重画 —— 放大后文字与方块都是原生像素。代价是节点多了
 * 会重排几百个矩形，实测在 830 节点下仍然是一帧内的事。
 */
export function SankeyChart({ model, mode, baseHeight, zoom, baseWidth, onNodeClick, scrollRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;

  /* 未缩放的可用宽度（容器宽）。取的是**滚动容器**的宽度，不是画布自己的 ——
     画布宽度是基准宽 × zoom，拿它当基准会自我放大。
     实测必须走 ResizeObserver：容器宽度由 flex/grid 算出来，
     useEffect([]) 那一趟量到的可能是 0（布局还没落定）。 */
  const [hostWidth, setHostWidth] = useState(0);

  useEffect(() => {
    const el = scrollRef?.current ?? hostRef.current?.parentElement;
    if (!el) return;
    const measure = () => setHostWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = echarts.init(host, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    chart.on('click', (params) => {
      const p = params as { dataType?: string; data?: { id?: string } };
      if (p.dataType !== 'node') return;
      const id = p.data?.id;
      if (id) clickRef.current(id);
    });

    /* 这里**不再**挂 window.resize / ResizeObserver 去调 `chart.resize()`：
       不带参数的 resize() 只按容器尺寸重算，而本组件的尺寸现在完全由下面那个
       effect 显式给出（见其注释）。窗口缩放会改滚动容器宽度，上头的
       ResizeObserver 更新 hostWidth，尺寸 effect 自然跟着重跑。 */
    return () => {
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  /* 画布尺寸。
     宽度默认 100%：容器宽度一变（缩放、全屏、窗口缩放）百分比自动跟上；
     若给像素，就只能在 React 再渲染一次之后才更新，中间那一帧会错位。
     App 给了 baseWidth（放大 / 全屏下的加宽画布）时改用像素 × zoom —— 这时
     宽度必须溢出容器、由外层滚出来，「摊开」才有意义。容器很窄（全屏后仍比
     基准宽窄）时按容器宽收窄，避免在宽屏基准下反而要横向滚动才能看得全。
     高度必须给像素 —— 由节点数算出来，撑出滚动条。
     两种情况下画布都**原样**铺开，外面不能再套 transform，套了之后
     命中测试（clientX - 画布左上角）会整体偏掉。 */
  const height = baseHeight * zoom;
  const canvasW =
    baseWidth == null ? null : Math.min(baseWidth, hostWidth > 0 ? hostWidth : baseWidth);
  const width = canvasW == null ? ('100%' as const) : canvasW * zoom;

  const option = useMemo(
    () => buildChartOption({ model, mode, height, width: canvasW ?? undefined, zoom }),
    [model, mode, height, canvasW, zoom],
  );

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option, { notMerge: true });
  }, [option]);

  /* 尺寸必须单独喂给 resize()，而且要给**显式像素**。
     ECharts 只在 resize() 里改 zrender 画布的尺寸，setOption 不改 —— 光把
     width/height 写进 option，几何量会按新尺寸算，画布本身却停在上一次
     resize 的大小。实测 156% 时几何铺到 2477×9448，画布还是 1585×6075：
     多出来的部分画不出来，**也点不中**（zrender 的命中判定按画布边界裁掉），
     于是放大后右侧/下侧的节点整片失去点击。以前这里靠 `chart.resize()` 读
     容器尺寸，而容器尺寸是百分比，React 落 DOM 与 zrender 重排之间总差一帧，
     所以画布永远落后一个缩放档。现在两路都给显式像素，不给它猜的机会。 */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    /* zoomed 门限取 1.05：与 App 的 chartWide 同源，避免 100% 上下抖时
       在两套预算之间来回切档（切档要走一次全量重画）。 */
    const zoomed = zoom > 1.05;
    if (canvasW == null) {
      /* 百分比路径：宽取滚动容器的实测宽（见上方 ResizeObserver） */
      if (hostWidth === 0) return;
      resizeWithBudget(chart, hostWidth, height, zoomed);
    } else {
      resizeWithBudget(chart, canvasW * zoom, height, zoomed);
    }
  }, [canvasW, zoom, height, hostWidth]);

  return (
    <div
      ref={hostRef}
      className="chart-canvas"
      style={{ width, height }}
      role="img"
      aria-label={`ISIC 产业结构桑基图，当前 ${model.nodes.length} 个节点、${model.links.length} 条流量。完整数据见表格视图。`}
    />
  );
}
