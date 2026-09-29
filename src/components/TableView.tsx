import { useMemo } from 'react';
import type { NodeKind, SankeyModel } from '../lib/sankeyModel';
import type { Company } from '../data/companies';
import { groupOfClass, sectionOf } from '../data/isic';

interface Props {
  model: SankeyModel;
  companies: Company[];
  colorOf: (sectionCode: string) => string;
  onPickCompany: (id: string) => void;
}

/** 层级名。表格不是二元判断的场合了，按 kind 查表。 */
const LEVEL_NAME: Record<NodeKind, string> = {
  section: '门类',
  division: '大类',
  group: '中类',
  class: '小类',
};

/**
 * 表格视图 —— 每张图都要有的无障碍备份。
 * 悬停不是读数的唯一途径：这里把当前范围内每一层的公司数与公司明细全部列出来。
 */
export function TableView({ model, companies, colorOf, onPickCompany }: Props) {
  const rows = useMemo(() => model.nodes, [model]);

  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="sr-only">当前范围内 ISIC 各分类的收录公司数量</caption>
        <thead>
          <tr>
            <th scope="col">层级</th>
            <th scope="col">代码</th>
            <th scope="col">分类名称</th>
            <th scope="col" style={{ textAlign: 'right' }}>收录公司</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id} className={n.companyCount === 0 ? 'is-zero' : undefined}>
              <td>{LEVEL_NAME[n.kind]}</td>
              <td className="num">{n.code}</td>
              <td>{n.fullName.replace(/^[^·]+·\s*/, '')}</td>
              <td className="num" style={{ textAlign: 'right' }}>{n.companyCount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {companies.length > 0 && (
        <table className="data" style={{ marginTop: 18 }}>
          <caption className="sr-only">当前范围内的公司明细</caption>
          <thead>
            <tr>
              <th scope="col">公司</th>
              <th scope="col">ISIC 小类</th>
              <th scope="col">中类</th>
              <th scope="col">国家 / 总部</th>
              <th scope="col" style={{ textAlign: 'right' }}>成立</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => {
              const group = groupOfClass(c.classCode);
              const section = sectionOf(c.classCode);
              return (
                <tr key={c.id}>
                  <td>
                    <button
                      type="button"
                      className="crumb"
                      style={{ padding: '2px 4px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={() => onPickCompany(c.id)}
                    >
                      <span
                        className="swatch"
                        style={{ background: colorOf(section?.code ?? ''), width: 8, height: 8 }}
                        aria-hidden="true"
                      />
                      {c.name}
                    </button>
                  </td>
                  <td className="num">{c.classCode}</td>
                  <td>{group ? `${group.code} · ${group.name}` : '—'}</td>
                  <td>{c.country} · {c.hq}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{c.founded}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
