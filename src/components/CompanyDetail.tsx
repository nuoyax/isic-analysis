import type { Company } from '../data/companies';
import { DATA_SOURCES } from '../data/companies';
import { classByCode, divisionOfClass, groupOfClass, sectionOfDivision } from '../data/isic';

interface Props {
  company: Company;
  colorOf: (sectionCode: string) => string;
  onBack: () => void;
}

/** 外部权威源字段 → 展示行。只列真正取到的，不拿种子值充数。 */
function externalRows(company: Company): { label: string; value: React.ReactNode }[] {
  const rows: { label: string; value: React.ReactNode }[] = [];

  if (company.gleif) {
    const g = company.gleif;
    rows.push({ label: '官方法人名', value: g.legalName });
    rows.push({ label: 'LEI 编码', value: <span className="num">{g.lei}</span> });
    if (g.registrationDate) rows.push({ label: '登记成立日期', value: g.registrationDate });
    if (g.country) rows.push({ label: '登记国别', value: `${g.country}${g.city ? ` · ${g.city}` : ''}` });
    if (g.registrationStatus) rows.push({ label: '登记状态', value: g.registrationStatus });
  }

  if (company.sec) {
    const s = company.sec;
    rows.push({
      label: 'SEC CIK',
      value: (
        <a href={s.cikUrl} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>
          <span className="num">{s.cik}</span>
        </a>
      ),
    });
    if (s.sicDescription) {
      rows.push({
        label: 'SEC 登记行业',
        value: `${s.sicDescription}${s.sic ? `（SIC ${s.sic}）` : ''}`,
      });
    }
  }

  return rows;
}

export function CompanyDetail({ company, colorOf, onBack }: Props) {
  const division = divisionOfClass(company.classCode);
  const group = groupOfClass(company.classCode);
  const section = division ? sectionOfDivision(division.code) : undefined;
  const cls = classByCode(company.classCode);
  const base = section ? colorOf(section.code) : 'var(--accent)';
  const external = externalRows(company);

  return (
    <article className="detail">
      <div className="detail-grid">
        <div>
          <h2>{company.name}</h2>
          <div className="en">{company.nameEn}</div>

          {company.business && <p className="desc" style={{ marginTop: 0 }}>{company.business}</p>}

          <p className="desc">{company.desc}</p>

          {company.website && (
            <p className="desc" style={{ fontSize: 12.5 }}>
              官网：
              <a href={company.website} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>
                {company.website}
              </a>
            </p>
          )}

          {company.tags && company.tags.length > 0 && (
            <div className="tags">
              {company.tags.map((t) => (
                <span className="tag" key={t}>{t}</span>
              ))}
            </div>
          )}
        </div>

        <div>
          <dl className="kv">
            <dt>所属国家</dt><dd>{company.country}</dd>
            <dt>总部</dt><dd>{company.hq}</dd>
            <dt>成立年份</dt><dd>{company.founded}</dd>
            <dt>规模档位</dt><dd>{company.size}</dd>
            {company.ticker && (<><dt>证券代码</dt><dd>{company.ticker}</dd></>)}
            <dt>主要产品</dt><dd>{company.products}</dd>
          </dl>

          <div className="section-note">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="swatch" style={{ background: base, width: 10, height: 10 }} aria-hidden="true" />
              <strong style={{ fontSize: 12.5 }}>ISIC Rev.5 归属</strong>
            </div>
            <dl className="kv" style={{ gridTemplateColumns: '64px 1fr' }}>
              <dt>门类</dt><dd>{section ? `${section.code} · ${section.name}` : '—'}</dd>
              <dt>大类</dt><dd>{division ? `${division.code} · ${division.name}` : '—'}</dd>
              <dt>中类</dt><dd>{group ? `${group.code} · ${group.name}` : '—'}</dd>
              <dt>小类</dt><dd>{cls ? `${cls.code} · ${cls.name}` : company.classCode}</dd>
            </dl>
            <p style={{ margin: '9px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
              归类按主营业务对应的主要活动就近判定；多元化集团可能存在跨类经营。
            </p>
          </div>

          {external.length > 0 && (
            <div className="section-note" style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 6 }}>
                <strong style={{ fontSize: 12.5 }}>外部权威源校验</strong>
              </div>
              <dl className="kv" style={{ gridTemplateColumns: '84px 1fr' }}>
                {external.map((r) => (
                  <div key={r.label} style={{ display: 'contents' }}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
              <p style={{ margin: '9px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
                取自{' '}
                {DATA_SOURCES.filter((s) => s.name.startsWith('GLEIF') || s.name.startsWith('SEC'))
                  .map((s) => s.name)
                  .join(' / ')}
                ，仅用于校对身份，不参与 ISIC 归类。
              </p>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn" onClick={onBack}>← 返回公司列表</button>
          </div>
        </div>
      </div>
    </article>
  );
}
