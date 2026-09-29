import { ISIC, type IsicDivision, type IsicGroup } from '../data/isic';
import { COMPANIES, type Company } from '../data/companies';
import { mixHex } from '../theme/tokens';

/**
 * 桑基图数据模型 —— ISIC Rev.5 结构的下钻。
 *
 * 列：门类(Section) → 大类(Division) → 中类(Group) → 小类(Class)
 *
 * 公司**不画进图里**（用户要求：图上不要公司）。点节点改由上层弹卡片列出公司。
 *
 * ── 带宽语义：收录公司数 ─────────────────────────────────────────────────
 * 桑基图的宽度必须守恒（父节点的宽度 = 其所有出边之和），否则同一列里
 * 的节点宽度会失去可比性。所以这里自下而上定义宽度：
 *
 *   小类宽度 = max(1, 该公司数)；空分类同样占 1 个单位，
 *              使 ISIC 的结构完整性不受数据覆盖度影响（空分类不会缩成 0）
 *   中类宽度 = 其各小类宽度之和
 *   大类宽度 = 其各中类宽度之和
 *   门类宽度 = 其各大类宽度之和
 *
 * 于是宽度始终等于收录公司数（空分类按 1 计），列内可比。节点另带
 * `companyCount` 字段，是**真实**的公司数（空分类为 0），tooltip 与卡片用它。
 *
 * ── 下钻行为 ────────────────────────────────────────────────────────────
 *   focus = null   → 总览：门类 → 大类 → 中类 → 小类（4 列，全量）
 *   focus = {...}  → 下钻：范围外的门类塌缩成单个叶子，只展开聚焦的那一支
 *
 * ── 颜色 ────────────────────────────────────────────────────────────────
 * 门类按 ISIC 原始顺序固定占用 8 个分类色槽位（index % 8），筛选不会
 * 重新上色。层级之间用**同一色相**向底色混合出深浅：门类最深 → 小类最浅。
 * 每个门类因此是一条可辨认的色带。
 */

export type FocusKind = 'section' | 'division' | 'group' | 'class';

export interface Focus {
  kind: FocusKind;
  code: string;
}

export type NodeKind = 'section' | 'division' | 'group' | 'class';

export interface SankeyNode {
  id: string;
  /** 图表里显示的名字（已截断） */
  name: string;
  /** 完整名称（tooltip / 卡片用） */
  fullName: string;
  code: string;
  kind: NodeKind;
  /** 节点宽度 = 收录公司数（空分类按 1） */
  value: number;
  /** 节点自身范围的**真实**公司数（空分类为 0） */
  companyCount: number;
  sectionCode: string;
  divisionCode?: string;
  groupCode?: string;
  itemStyle: { color: string; borderColor: string; borderWidth: number };
  label: { show: boolean; position: 'left' | 'right' };
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  lineStyle: { color: string; opacity: number };
}

export interface SankeyModel {
  nodes: SankeyNode[];
  links: SankeyLink[];
  parentOf: Map<string, string>;
}

export const LEVEL_OF: Record<NodeKind, 0 | 1 | 2 | 3> = {
  section: 0,
  division: 1,
  group: 2,
  class: 3,
};

/** 层级数（列数）：门类 / 大类 / 中类 / 小类 */
export const LEVEL_COUNT = 4;

export const NODE_ID = {
  section: (code: string) => `s:${code}`,
  division: (code: string) => `d:${code}`,
  group: (code: string) => `g:${code}`,
  cls: (code: string) => `c:${code}`,
};

/** 22 个门类 → 固定的 8 个色槽（按 ISIC 原序取模） */
export const SECTION_SLOT: Record<string, number> = Object.fromEntries(
  ISIC.map((s, i) => [s.code, i % 8]),
);

/* ---------- 预计算：小类 → 公司 ---------- */

const COMPANIES_BY_CLASS = new Map<string, Company[]>();
for (const c of COMPANIES) {
  const list = COMPANIES_BY_CLASS.get(c.classCode);
  if (list) list.push(c);
  else COMPANIES_BY_CLASS.set(c.classCode, [c]);
}

export function companiesInClass(code: string): Company[] {
  return COMPANIES_BY_CLASS.get(code) ?? [];
}

function companiesInGroup(group: IsicGroup): Company[] {
  return group.classes.flatMap((c) => companiesInClass(c.code));
}

function companiesInDivision(division: IsicDivision): Company[] {
  return division.groups.flatMap(companiesInGroup);
}

function companiesInSection(sectionCode: string): Company[] {
  const section = ISIC.find((s) => s.code === sectionCode);
  if (!section) return [];
  return section.divisions.flatMap(companiesInDivision);
}

export { companiesInGroup, companiesInDivision, companiesInSection };

/** 小类宽度（空分类占 1 个单位，保证结构完整） */
function classWidth(code: string): number {
  return Math.max(1, companiesInClass(code).length);
}

function groupWidth(group: IsicGroup): number {
  return group.classes.reduce((sum, c) => sum + classWidth(c.code), 0);
}

function divisionWidth(division: IsicDivision): number {
  return division.groups.reduce((sum, g) => sum + groupWidth(g), 0);
}

function sectionWidth(sectionCode: string): number {
  const section = ISIC.find((s) => s.code === sectionCode);
  if (!section) return 1;
  return section.divisions.reduce((sum, d) => sum + divisionWidth(d), 0);
}

/* ---------- focus 工具 ---------- */

export function sectionOfFocus(focus: Focus): string | undefined {
  if (focus.kind === 'section') return focus.code;
  if (focus.kind === 'division') {
    return ISIC.find((s) => s.divisions.some((d) => d.code === focus.code))?.code;
  }
  if (focus.kind === 'group') {
    return ISIC.find((s) =>
      s.divisions.some((d) => d.groups.some((g) => g.code === focus.code)),
    )?.code;
  }
  return ISIC.find((s) =>
    s.divisions.some((d) =>
      d.groups.some((g) => g.classes.some((c) => c.code === focus.code)),
    ),
  )?.code;
}

/** 节点 → 点击后的下钻目标 */
export function focusFromNode(node: SankeyNode): Focus {
  if (node.kind === 'section') return { kind: 'section', code: node.code };
  if (node.kind === 'division') return { kind: 'division', code: node.code };
  if (node.kind === 'group') return { kind: 'group', code: node.code };
  return { kind: 'class', code: node.code };
}

/** 层级标签（面包屑 / 卡片标题用） */
export const LEVEL_LABEL: Record<FocusKind, string> = {
  section: '门类',
  division: '大类',
  group: '中类',
  class: '小类',
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/* ---------- 构建 ---------- */

export interface BuildOptions {
  focus: Focus | null;
  /** 门类代码 → 基色 */
  colorOf: (sectionCode: string) => string;
  /** 当前主题的图表底色，用于层级间混色与节点描边 */
  surface: string;
  mode: 'light' | 'dark';
}

/** 同色相由深到浅的混色档位：0 门类最深 → 3 小类最浅 */
const TONE_STOPS = {
  light: [0, 0.2, 0.36, 0.52],
  dark: [0, 0.22, 0.38, 0.54],
} as const;

export function buildModel(opts: BuildOptions): SankeyModel {
  const { focus, colorOf, surface, mode } = opts;
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const parentOf = new Map<string, string>();

  const tone = (base: string, level: 0 | 1 | 2 | 3) =>
    mixHex(base, surface, TONE_STOPS[mode][level]);

  const add = (spec: {
    id: string;
    name: string;
    fullName: string;
    code: string;
    kind: NodeKind;
    value: number;
    companyCount: number;
    sectionCode: string;
    divisionCode?: string;
    groupCode?: string;
    level: 0 | 1 | 2 | 3;
    labelShow?: boolean;
    labelPosition?: 'left' | 'right';
  }) => {
    const base = colorOf(spec.sectionCode);
    nodes.push({
      id: spec.id,
      name: spec.name,
      fullName: spec.fullName,
      code: spec.code,
      kind: spec.kind,
      value: spec.value,
      companyCount: spec.companyCount,
      sectionCode: spec.sectionCode,
      divisionCode: spec.divisionCode,
      groupCode: spec.groupCode,
      itemStyle: {
        color: tone(base, spec.level),
        borderColor: surface,
        borderWidth: 2,
      },
      label: {
        show: spec.labelShow ?? true,
        position: spec.labelPosition ?? (spec.level === 0 ? 'left' : 'right'),
      },
    });
  };

  const link = (source: string, target: string, value: number, color: string) => {
    links.push({
      source,
      target,
      value: Math.max(value, 0.0001),
      lineStyle: { color, opacity: mode === 'light' ? 0.3 : 0.4 },
    });
  };

  const focusSection = focus ? sectionOfFocus(focus) : undefined;

  for (const section of ISIC) {
    const base = colorOf(section.code);
    const sId = NODE_ID.section(section.code);
    const total = companiesInSection(section.code).length;

    add({
      id: sId,
      name: truncate(section.name, 18),
      fullName: `${section.code} · ${section.name}`,
      code: section.code,
      kind: 'section',
      value: sectionWidth(section.code),
      companyCount: total,
      sectionCode: section.code,
      level: 0,
      labelShow: true,
      labelPosition: 'left',
    });

    /* 下钻时，聚焦范围外的门类塌缩为一个叶子节点（不再展开其下层级） */
    if (focus && focusSection !== section.code) continue;

    for (const division of section.divisions) {
      const dId = NODE_ID.division(division.code);
      const divWidth = divisionWidth(division);

      link(sId, dId, divWidth, tone(base, 0));
      parentOf.set(dId, sId);

      add({
        id: dId,
        name: truncate(division.name, 20),
        fullName: `${division.code} · ${division.name}`,
        code: division.code,
        kind: 'division',
        value: divWidth,
        companyCount: companiesInDivision(division).length,
        sectionCode: section.code,
        divisionCode: division.code,
        level: 1,
        labelPosition: 'right',
      });

      for (const group of division.groups) {
        const gId = NODE_ID.group(group.code);
        const grpWidth = groupWidth(group);

        link(dId, gId, grpWidth, tone(base, 1));
        parentOf.set(gId, dId);

        add({
          id: gId,
          name: truncate(group.name, 22),
          fullName: `${group.code} · ${group.name}`,
          code: group.code,
          kind: 'group',
          value: grpWidth,
          companyCount: companiesInGroup(group).length,
          sectionCode: section.code,
          divisionCode: division.code,
          groupCode: group.code,
          level: 2,
          labelPosition: 'right',
        });

        for (const cls of group.classes) {
          const cId = NODE_ID.cls(cls.code);
          const clsCompanies = companiesInClass(cls.code);

          link(gId, cId, Math.max(1, clsCompanies.length), tone(base, 2));
          parentOf.set(cId, gId);

          add({
            id: cId,
            name: truncate(cls.name, 24),
            fullName: `${cls.code} · ${cls.name}`,
            code: cls.code,
            kind: 'class',
            value: Math.max(1, clsCompanies.length),
            companyCount: clsCompanies.length,
            sectionCode: section.code,
            divisionCode: division.code,
            groupCode: group.code,
            level: 3,
            labelPosition: 'right',
          });
        }
      }
    }
  }

  return { nodes, links, parentOf };
}
