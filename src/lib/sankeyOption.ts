import type { EChartsOption } from 'echarts';
import type { SankeyModel } from './sankeyModel';
import { LEVEL_OF } from './sankeyModel';
import { CHROME, withAlpha, type ThemeMode } from '../theme/tokens';

/**
 * SankeyModel → ECharts option。
 *
 * ECharts 的桑基图自行计算 x/y 与节点宽度，我们不直接控制布局，只用它
 * 提供的开关把「列」稳住：
 *   - `nodeAlign: 'left'` —— 节点从左侧起排，给公司列留出位置
 *   - `nodeGap` / `layoutIterations` —— 收紧间距，几百个节点也能读
 *   - 每层的 `label.position` 由模型给定（门类贴左，其余贴右）
 *
 * 带宽语义见 sankeyModel.ts 顶部注释。
 */

export interface ChartOptions {
  model: SankeyModel;
  mode: ThemeMode;
  /** 画布像素高度，由调用方按节点数估算（外层负责滚动）—— 已含 zoom */
  height: number;
  /**
   * 画布像素宽度。
   *
   * 默认按容器宽（`width: 100%`）。但桑基图的行高由**高度**决定，中间两列
   * （中类 / 小类，共 721 个节点）标签又长得放不下，节点宽度有限 —— 只往上
   * 加高度，多出来的空间全被压成节点之间的空隙，横向依旧挤。
   * 所以放大或全屏时给一个更宽的画布（见 App 的 `chartWide`），
   * 让 ECharts 有横向余量把列摊开。取的是**基准宽度**，不含 zoom。
   */
  width?: number;
  /**
   * 缩放倍率。
   *
   * ECharts 的桑基图**不支持 roam**（5.6 的 SankeySeries 里没有这个选项），
   * 所以缩放不能靠内置手势。这里也不用 `transform: scale()` 拉伸位图 ——
   * 那样放大会糊。做法是把**几何量本身**乘以 zoom：行高、字号、节点宽、
   * 边距、节点间距一起放大，由 ECharts 按新尺寸**重画一遍**。
   * 结果是真正的矢量式放大，文字与方块都是原生像素。
   */
  zoom?: number;
}

const LABEL_FONT = 11.5;
/** 缩放的上下限：放到 4 倍已能看清 463 个小类里最挤的那一列 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;

/** 粗略估算标签像素宽度：CJK 按全角（≈字号），其余按 0.56 字号 */
function estWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += /[　-鿿＀-￯]/.test(ch) ? fontSize : fontSize * 0.56;
  }
  return w;
}

export function buildChartOption({ model, mode, height, width, zoom = 1 }: ChartOptions): EChartsOption {
  const c = CHROME[mode];
  const lineOpacity = mode === 'light' ? 0.3 : 0.4;
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  const padY = 14 * k;
  const usable = Math.max(height - padY * 2, 320);
  const fontSize = LABEL_FONT * k;

  /* 每列节点数 → 行高。行高放不下一个字号时放弃该列的直标，
     改由 tooltip 与表格视图承担（不为每个点都贴标签）。
     行高与字号同乘 k，所以判定阈值基本不变 —— 放大时最多多出一两条标签，
     这恰好是想要的「放大看得更清」。 */
  const perLevel = new Map<number, number>();
  for (const n of model.nodes) {
    const lvl = LEVEL_OF[n.kind];
    perLevel.set(lvl, (perLevel.get(lvl) ?? 0) + 1);
  }
  const rowOf = (lvl: number) => usable / Math.max(perLevel.get(lvl) ?? 1, 1);

  const labeled = model.nodes.filter(
    (n) => n.label.show && (LEVEL_OF[n.kind] === 0 || rowOf(LEVEL_OF[n.kind]) >= fontSize + 1),
  );

  /* 左侧直标画在节点左边、右侧直标画在节点右边，两者都要预留边距，
     否则会被画布裁掉。按最长的一条标签算。上限也随 k 放大，
     否则放大后标签反而被截断。 */
  const cap = 260 * k;
  const widest = (position: 'left' | 'right') => {
    const list = labeled.filter((n) => n.label.position === position);
    if (list.length === 0) return 0;
    return Math.max(...list.map((n) => estWidth(n.name, fontSize)));
  };
  const padLeft = Math.min(cap, Math.max(10 * k, Math.ceil(widest('left')) + 14 * k));
  const padRight = Math.min(cap, Math.max(24 * k, Math.ceil(widest('right')) + 14 * k));
  const showLabel = new Set(labeled.map((n) => n.id));

  return {
    backgroundColor: 'transparent',
    animationDuration: 240,
    animationEasing: 'cubicOut',
    /* 状态切换（hover 的 emphasis / 其余节点和边的 blur）不要补间。
       它按帧重画整张画布，而这张图放大后是 2477×9492 —— 鼠标扫过节点时
       实测 300~500ms 一帧，就是因为每帧都要给 830 个方块 + 1200 条边算一次
       过渡中间态。改成瞬时切换后同样的扫动是 17ms 一帧，视觉上反而更跟手。
       （入场动画不受影响，那是 animationDuration 的事。） */
    stateAnimation: { duration: 0 },
    textStyle: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      color: c.textSecondary,
      fontSize: 12 * k,
    },
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      padding: [10, 12],
      extraCssText: `box-shadow: 0 6px 22px ${withAlpha('#000000', mode === 'light' ? 0.14 : 0.4)}; border-radius: 8px;`,
      textStyle: { color: c.textPrimary, fontSize: 12.5 * k },
      formatter: (params: unknown) => {
        const p = params as {
          dataType?: string;
          data?: { fullName?: string; name?: string; companyCount?: number; kind?: string };
        };
        const d = p.data;
        if (!d) return '';
        const title = escapeHtml(d.fullName ?? d.name ?? '');
        const out: string[] = [`<div style="font-weight:650;margin-bottom:4px">${title}</div>`];
        if (d.companyCount != null) {
          const none = d.companyCount === 0 ? '<span style="opacity:.6">暂无收录</span>' : '';
          out.push(
            `<div style="font-variant-numeric:tabular-nums">收录公司 <b>${d.companyCount}</b> 家 ${none}</div>`,
          );
        }
        out.push('<div style="opacity:.6;margin-top:4px">点击查看公司列表</div>');
        return out.join('');
      },
    },
    series: [
      {
        type: 'sankey',
        id: 'isic-sankey',
        name: 'ISIC 产业结构',
        // 传了 width 就锁死画布宽并按 zoom 放大 —— 「横向摊开」就是让接收者
        // 有超出视口的空间，所以这个宽度必须大于容器宽，由外层滚出来。
        ...(width == null
          ? { left: padLeft, right: padRight }
          : { width: width * k, left: 0, right: 'auto' as const }),
        top: padY,
        bottom: padY,
        height: usable,
        nodeAlign: 'left',
        nodeWidth: 12 * k,
        nodeGap: 7 * k,
        layoutIterations: 40,
        draggable: false,
        emphasis: {
          focus: 'adjacency',
          blurScope: 'coordinateSystem',
          lineStyle: { opacity: Math.min(lineOpacity + 0.32, 0.75) },
          itemStyle: { borderWidth: 2.5, borderColor: c.textPrimary },
        },
        blur: {
          lineStyle: { opacity: 0.05 },
          itemStyle: { opacity: 0.24 },
        },
        label: {
          // 用不用直标按列的行高决定（见上方 showLabel），这里只给样式
          show: false,
          color: c.textSecondary,
          fontSize,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        },
        lineStyle: { curveness: 0.5 },
        edgeLabel: { show: false },
        itemStyle: { borderWidth: 2, borderColor: c.surface },
        data: model.nodes.map((n) => ({
          // ECharts 以 name 作为节点标识，因此把唯一 id 放进 name，
          // 显示文本改由 label.formatter 提供
          name: n.id,
          value: n.value,
          itemStyle: n.itemStyle,
          label: {
            show: showLabel.has(n.id),
            position: n.label.position,
            formatter: () => n.name,
          },
          // 事件 / tooltip 回传的自定义字段
          id: n.id,
          fullName: n.fullName,
          kind: n.kind,
          code: n.code,
          companyCount: n.companyCount,
          sectionCode: n.sectionCode,
          divisionCode: n.divisionCode,
          level: LEVEL_OF[n.kind],
        })),
        links: model.links.map((l) => ({
          source: l.source,
          target: l.target,
          value: l.value,
          lineStyle: l.lineStyle,
        })),
      },
    ],
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
