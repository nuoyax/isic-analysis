/**
 * 主题令牌 —— 光/暗两套值，成对定义。
 *
 * 取值来自已验证的参考调色板（dataviz / references/palette.md），
 * 分类色已在 light(`#fcfcfb`) 与 dark(`#1a1a19`) 两种底色上跑过
 * `validate_palette.js`，全部门槛 PASS。
 *
 * 暗色值在 media query 与 [data-theme="dark"] 两个作用域下各声明一次：
 * 前者覆盖系统偏好，后者覆盖页面内切换按钮，且切换按钮两个方向都要优先。
 */

export type ThemeMode = 'light' | 'dark';

/** 分类色槽位 1–8（订单固定，不循环） */
export const CATEGORICAL_LIGHT = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
  '#4a3aa7', // 7 violet
  '#e34948', // 8 red
] as const;

export const CATEGORICAL_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

/** 与 slot 一一对应的 12 步顺序色阶（由浅到深），用于给流量铺同一色系的深浅 */
export const RAMP_LIGHT = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281',
] as const;

export const RAMP_DARK = [
  '#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6',
  '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6',
] as const;

export const CHROME = {
  light: {
    surface: '#fcfcfb',
    page: '#f9f9f7',
    textPrimary: '#0b0b0b',
    textSecondary: '#52514e',
    muted: '#898781',
    gridline: '#e1e0d9',
    axis: '#c3c2b7',
    border: 'rgba(11,11,11,0.10)',
  },
  dark: {
    surface: '#1a1a19',
    page: '#0d0d0d',
    textPrimary: '#ffffff',
    textSecondary: '#c3c2b7',
    muted: '#898781',
    gridline: '#2c2c2a',
    axis: '#383835',
    border: 'rgba(255,255,255,0.10)',
  },
} as const;

export function categorical(mode: ThemeMode): readonly string[] {
  return mode === 'light' ? CATEGORICAL_LIGHT : CATEGORICAL_DARK;
}

export function ramp(mode: ThemeMode): readonly string[] {
  return mode === 'light' ? RAMP_LIGHT : RAMP_DARK;
}

/** 按 0..1 取顺序色阶上的一个步长 */
export function rampAt(mode: ThemeMode, t: number): string {
  const steps = ramp(mode);
  const i = Math.max(0, Math.min(steps.length - 1, Math.round(t * (steps.length - 1))));
  return steps[i];
}

export function chrome(mode: ThemeMode) {
  return CHROME[mode];
}

/* ---------- 颜色工具 ---------- */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** 把 a 向 b 混合 t（0..1）——用于在同一色系里做出层级深浅 */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

/** 给十六进制色加上 alpha（返回 rgba()） */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 稳定地把一个字符串映射到 8 个分类槽位之一（用于暂未手工指定的单位） */
export function slotOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % CATEGORICAL_LIGHT.length;
}
