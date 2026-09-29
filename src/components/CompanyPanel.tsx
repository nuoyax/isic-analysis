import type { Company } from '../data/companies';
import { classByCode, groupOfClass, sectionOf } from '../data/isic';

interface Props {
  companies: Company[];
  /** 当前选中公司（用于 aria-selected 与高亮） */
  selectedId: string | null;
  /** 门类 → 基色（画左侧色块，与桑基图同色，身份不靠颜色单独承载） */
  colorOf: (sectionCode: string) => string;
  onSelect: (id: string) => void;
}

/** 小类代码 → 所属门类，用于取色 */
function sectionOfCompany(c: Company): string {
  return sectionOf(c.classCode)?.code ?? '';
}

/** 「小类 · 中类」二级提示，让列表卡片自带归类上下文 */
function levelHint(c: Company): string {
  const cls = classByCode(c.classCode);
  const group = groupOfClass(c.classCode);
  const parts = [cls ? `${cls.code} ${cls.name}` : c.classCode];
  if (group) parts.push(group.name);
  return parts.join(' · ');
}

export function CompanyPanel({ companies, selectedId, colorOf, onSelect }: Props) {
  if (companies.length === 0) {
    return (
      <p className="empty">
        该分类下暂无收录公司。切换其他分类，或把公司补进 scripts/seed/companies.seed.json 后重跑 npm run collect。
      </p>
    );
  }

  return (
    <ul className="cards" role="listbox" aria-label="该分类下的公司" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {companies.map((c) => {
        const sec = sectionOfCompany(c);
        return (
          <li key={c.id}>
            <button
              type="button"
              className="card"
              role="option"
              aria-selected={selectedId === c.id}
              onClick={() => onSelect(c.id)}
            >
              <span className="row1">
                <span className="swatch" style={{ background: colorOf(sec) }} aria-hidden="true" />
                <span className="nm" title={c.name}>{c.name}</span>
              </span>
              <span className="biz">{c.business}</span>
              <span className="biz" style={{ opacity: 0.75 }}>{levelHint(c)}</span>
              <span className="row3">
                <span>{c.country} · {c.hq}</span>
                <span aria-hidden="true">·</span>
                <span>{c.founded} 年</span>
                <span className="tag">{c.size}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
