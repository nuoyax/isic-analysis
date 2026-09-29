/**
 * ISIC Rev.5 产业结构 —— 门类 Section → 大类 Division → 中类 Group → 小类 Class
 *
 * 数据来源：UN Statistics Division, International Standard Industrial
 * Classification of All Economic Activities, Revision 5 (ISIC Rev.5)。
 *
 * 层级与代码：
 *   Section  门类  —— 1 位字母 (A–V)，22 个，全量
 *   Division 大类  —— 2 位数字，87 个，全量
 *   Group    中类  —— 3 位数字，258 个，全量
 *   Class    小类  —— 4 位数字，463 个，全量
 *
 * 结构与中文名的分工：
 *   - 结构（代码、层级、顺序、英文名）来自 isicRev5.generated.ts，由
 *     `npm run fetch:isic` 从 UN 官方文件生成，**不要手工改**；
 *   - 中文名来自 isicRev5.zh.ts，由 `npm run build:zh` 生成（人工译名）。
 *   这个文件只负责把两者拼成一棵树，并提供查询工具。
 *
 * 注意：和 Rev.4 一样，官方结构里存在「一个中类只有一个官方小类」的情况
 * （如 0210 造林 / 0220 伐木）。这是标准本身如此，不做拆分。
 */

import { ISIC_REV5_ROWS, ISIC_REV5_SOURCE } from './isicRev5.generated';
import { ISIC_REV5_ZH, zhNameOf } from './isicRev5.zh';

export { ISIC_REV5_SOURCE };

export interface IsicClass {
  code: string;
  name: string;
  nameEn: string;
}

export interface IsicGroup {
  code: string;
  name: string;
  nameEn: string;
  divisionCode: string;
  classes: IsicClass[];
}

export interface IsicDivision {
  code: string;
  name: string;
  nameEn: string;
  sectionCode: string;
  groups: IsicGroup[];
}

export interface IsicSection {
  code: string;
  name: string;
  nameEn: string;
  divisions: IsicDivision[];
}

/** 官方文件是深度优先排布，按「最近出现的上一层」挂载即可 */
function buildTree(): IsicSection[] {
  const sections: IsicSection[] = [];
  let section: IsicSection | null = null;
  let division: IsicDivision | null = null;
  let group: IsicGroup | null = null;

  for (const [code, nameEn] of ISIC_REV5_ROWS) {
    const name = zhNameOf(code);
    switch (code.length) {
      case 1:
        section = { code, name, nameEn, divisions: [] };
        sections.push(section);
        division = null;
        group = null;
        break;
      case 2:
        if (!section) break;
        division = { code, name, nameEn, sectionCode: section.code, groups: [] };
        section.divisions.push(division);
        group = null;
        break;
      case 3:
        if (!division) break;
        group = { code, name, nameEn, divisionCode: division.code, classes: [] };
        division.groups.push(group);
        break;
      case 4:
        if (!group) break;
        group.classes.push({ code, name, nameEn });
        break;
      default:
        throw new Error(`ISIC Rev.5 里出现了 ${code.length} 位代码：${code}`);
    }
  }

  return sections;
}

export const ISIC: IsicSection[] = buildTree();

/* ---------- 派生索引与查询工具 ---------- */

export const allSections: IsicSection[] = ISIC;

export const allDivisions: IsicDivision[] = ISIC.flatMap((s) => s.divisions);

export const allGroups: IsicGroup[] = allDivisions.flatMap((d) => d.groups);

export const allClasses: IsicClass[] = allGroups.flatMap((g) => g.classes);

/* 代码 → 所属上级的索引。全量 830 个节点，构建期一次性建好，
   查询从 O(n) 扫描变成 O(1)，也顺带成为下面那些 *Of* 工具的唯一真值。 */

const GROUP_BY_CLASS = new Map<string, IsicGroup>();
const DIVISION_BY_GROUP = new Map<string, IsicDivision>();
const SECTION_BY_DIVISION = new Map<string, IsicSection>();
const DIVISION_BY_CLASS = new Map<string, IsicDivision>();
const SECTION_BY_CLASS = new Map<string, IsicSection>();

for (const section of ISIC) {
  for (const division of section.divisions) {
    SECTION_BY_DIVISION.set(division.code, section);
    for (const group of division.groups) {
      DIVISION_BY_GROUP.set(group.code, division);
      for (const cls of group.classes) {
        GROUP_BY_CLASS.set(cls.code, group);
        DIVISION_BY_CLASS.set(cls.code, division);
        SECTION_BY_CLASS.set(cls.code, section);
      }
    }
  }
}

export const sectionByCode = (code: string): IsicSection | undefined =>
  ISIC.find((s) => s.code === code);

export const divisionByCode = (code: string): IsicDivision | undefined =>
  allDivisions.find((d) => d.code === code);

export const groupByCode = (code: string): IsicGroup | undefined =>
  allGroups.find((g) => g.code === code);

export const classByCode = (code: string): IsicClass | undefined =>
  allClasses.find((c) => c.code === code);

/** 小类 → 所属中类 */
export const groupOfClass = (classCode: string): IsicGroup | undefined =>
  GROUP_BY_CLASS.get(classCode);

/** 中类 | 小类 → 所属大类（两种代码都收，面板里省一次判断） */
export const divisionOf = (code: string): IsicDivision | undefined =>
  code.length === 4 ? DIVISION_BY_CLASS.get(code) : DIVISION_BY_GROUP.get(code);

/** 中类 → 所属大类 */
export const divisionOfGroup = (groupCode: string): IsicDivision | undefined =>
  DIVISION_BY_GROUP.get(groupCode);

/** 小类 → 所属大类（等价于 divisionOf，保留旧名以免调用方四处改名） */
export const divisionOfClass = (classCode: string): IsicDivision | undefined =>
  DIVISION_BY_CLASS.get(classCode);

/** 大类 → 所属门类 */
export const sectionOfDivision = (divisionCode: string): IsicSection | undefined =>
  SECTION_BY_DIVISION.get(divisionCode);

/** 中类 | 小类 → 所属门类（3 位走中类索引，4 位走小类索引） */
export const sectionOf = (code: string): IsicSection | undefined => {
  if (code.length === 4) return SECTION_BY_CLASS.get(code);
  if (code.length === 3) {
    const division = DIVISION_BY_GROUP.get(code);
    return division ? SECTION_BY_DIVISION.get(division.code) : undefined;
  }
  return SECTION_BY_DIVISION.get(code);
};

export const ISIC_COUNTS = {
  sections: ISIC.length,
  divisions: allDivisions.length,
  groups: allGroups.length,
  classes: allClasses.length,
};

/** 直接用中文名映射表，供少数不经过树的场合（如标题对照）使用 */
export { ISIC_REV5_ZH };
