import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Loading, useAction, useLoad } from '../components';
import { LanguageSwitch } from '../LanguageSwitch';
import { formatDate, formatDateTime, getLocale, t } from '../i18n';

// Legal texts and compliance documents (R3-08, R3-11). Public page /rechtliches for terms and
// privacy policy; Settings › Legal for admins with TOM, DPIA template, DPA, acceptance of the
// current terms, the list of sub-processors and the state of encryption. Documents come from
// the server as text blocks (no HTML), so nothing from a template can inject markup.

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; small?: boolean }
  | { kind: 'row'; label: string; value: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'space' };

interface DocInfo { name: string; title: string; version: string; date: string; public: boolean }
interface Doc extends DocInfo { blocks: Block[]; markdown: string }

export function DocBlocks({ blocks }: { blocks: Block[] }) {
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  let rows: { label: string; value: string }[] = [];
  const flush = (key: number) => {
    if (bullets.length) out.push(<ul key={`u${key}`}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>);
    if (rows.length) out.push(<dl key={`d${key}`} className="legal-rows">{rows.map((r, i) => <div key={i}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>);
    bullets = [];
    rows = [];
  };
  blocks.forEach((b, i) => {
    if (b.kind !== 'bullet' && bullets.length) flush(i);
    if (b.kind !== 'row' && rows.length) flush(i);
    if (b.kind === 'bullet') bullets.push(b.text);
    else if (b.kind === 'row') rows.push({ label: b.label, value: b.value });
    else if (b.kind === 'title') out.push(<h2 key={i}>{b.text}</h2>);
    else if (b.kind === 'heading') out.push(<h3 key={i}>{b.text}</h3>);
    else if (b.kind === 'text') out.push(<p key={i} className={b.small ? 'alert info' : undefined}>{b.text}</p>);
  });
  flush(blocks.length);
  return <div className="legal-doc" lang="de">{out}</div>;
}

function Downloads({ base }: { base: string }) {
  return (
    <p className="small">
      <a href={`${base}?format=pdf`} download>{t('compliance.download.pdf')}</a>{' · '}
      <a href={`${base}?format=md`} download>{t('compliance.download.md')}</a>
    </p>
  );
}

/** Public page /rechtliches and /rechtliches/:name, readable without an account. */
export function LegalPage() {
  const { name } = useParams();
  const list = useLoad<{ documents: DocInfo[] }>('/api/legal');
  const current = name ?? list.data?.documents[0]?.name ?? null;
  const doc = useLoad<Doc>(current ? `/api/legal/${current}` : null);
  return (
    <div className="landing">
      <header className="topbar">
        <Link to="/" className="brand">Ideenportal</Link>{/* texts-ok */}
        <div className="topbar-right"><LanguageSwitch /></div>
      </header>
      <main id="inhalt" className="stack" style={{ maxWidth: 860, margin: '0 auto', padding: 20 }}>
        <h1>{t('compliance.public.title')}</h1>
        <p>{t('compliance.public.intro')}</p>
        {getLocale() === 'en' && <p className="muted small">{t('compliance.public.germanOnly')}</p>}
        <ErrorBox error={list.error} />
        <nav className="tabs" aria-label={t('compliance.public.title')}>
          {list.data?.documents.map((d) => (
            <Link key={d.name} className="button" aria-current={d.name === current ? 'page' : undefined} to={`/rechtliches/${d.name}`}>{d.title}</Link>
          ))}
        </nav>
        {doc.loading && !doc.data && <Loading />}
        <ErrorBox error={doc.error} />
        {doc.data && (
          <article className="card">
            <p className="muted small">{t('compliance.version', { version: doc.data.version, date: formatDate(doc.data.date) })}</p>
            <Downloads base={`/api/legal/${doc.data.name}`} />
            <DocBlocks blocks={doc.data.blocks} />
          </article>
        )}
        <p><Link to="/">{t('compliance.public.back')}</Link></p>
      </main>
    </div>
  );
}

interface Subprocessor { key: string; name: string; purpose: string; data: string; locationText: string; contractText: string; active: boolean }
interface Overview {
  documents: (DocInfo & { acceptable: boolean; accepted: { acceptedAt: string; acceptedBy: string | null } | null })[];
  subprocessors: Subprocessor[];
  security: { https: boolean; hsts: boolean; databaseTls: 'off' | 'require' | 'no-verify' | 'url'; secretKey: boolean; hostingProvider: string; hostingRegion: string; hostingLocation: 'eu' | 'other' | 'local' };
}

/** Settings › Legal (admins). */
export function ComplianceAdmin() {
  const { data, error, loading, reload } = useLoad<Overview>('/api/admin/compliance');
  const [open, setOpen] = useState<string | null>(null);
  const doc = useLoad<Doc>(open ? `/api/admin/compliance/documents/${open}` : null);
  const action = useAction();
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const sec = data.security;
  const yes = (v: boolean) => (v ? t('compliance.security.on') : t('compliance.security.off'));
  const accept = async (name: string, version: string) => {
    if (!window.confirm(t('compliance.admin.acceptConfirm', { version }))) return;
    if (await action.run(() => api.post('/api/admin/compliance/accept', { document: name, version }))) await reload();
  };

  return (
    <div className="stack">
      <p>{t('compliance.admin.intro')}</p>
      <ErrorBox error={action.error} />
      <section className="card" aria-labelledby="h-legal-docs">
        <h2 id="h-legal-docs">{t('compliance.admin.documents')}</h2>
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th>{t('compliance.admin.document')}</th><th>{t('compliance.admin.version')}</th><th>{t('compliance.admin.status')}</th><th></th></tr></thead>
          <tbody>
            {data.documents.map((d) => (
              <tr key={d.name}>
                <td>{d.title}<br /><span className="muted small">{d.public ? t('compliance.admin.public') : t('compliance.admin.adminsOnly')}</span></td>
                <td>{t('compliance.version', { version: d.version, date: formatDate(d.date) })}</td>
                <td>
                  {!d.acceptable && t('compliance.admin.notAcceptable')}
                  {d.acceptable && d.accepted && t('compliance.admin.accepted', { name: d.accepted.acceptedBy ?? t('compliance.admin.unknownPerson'), date: formatDateTime(d.accepted.acceptedAt) })}
                  {d.acceptable && !d.accepted && (
                    <>
                      <span className="muted small">{t('compliance.admin.notAccepted')}</span><br />
                      <button type="button" disabled={action.busy} onClick={() => accept(d.name, d.version)}>{t('compliance.admin.accept', { version: d.version })}</button>
                    </>
                  )}
                </td>
                <td>
                  <button type="button" aria-expanded={open === d.name} onClick={() => setOpen(open === d.name ? null : d.name)}>{open === d.name ? t('compliance.close') : t('compliance.open')}</button>
                  <Downloads base={`/api/admin/compliance/documents/${d.name}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {open && doc.loading && !doc.data && <Loading />}
        {open && doc.data && doc.data.name === open && <article className="card"><DocBlocks blocks={doc.data.blocks} /></article>}
      </section>

      <section className="card" aria-labelledby="h-legal-sub">
        <h2 id="h-legal-sub">{t('compliance.sub.title')}</h2>
        <p className="muted small">{t('compliance.sub.intro')}</p>
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th>{t('compliance.sub.name')}</th><th>{t('compliance.sub.purpose')}</th><th>{t('compliance.sub.data')}</th><th>{t('compliance.sub.location')}</th><th>{t('compliance.sub.contract')}</th><th>{t('compliance.sub.active')}</th></tr></thead>
          <tbody>
            {data.subprocessors.map((s) => (
              <tr key={s.key}><td>{s.name}</td><td>{s.purpose}</td><td>{s.data}</td><td>{s.locationText}</td><td>{s.contractText}</td><td>{s.active ? t('compliance.sub.yes') : t('compliance.sub.no')}</td></tr>
            ))}
          </tbody>
        </table></div>
        <p className="small">
          <a href="/api/admin/compliance/subprocessors?format=csv" download>{t('compliance.sub.csv')}</a>{' · '}
          <a href="/api/admin/compliance/subprocessors?format=json" download>{t('compliance.sub.json')}</a>
        </p>
      </section>

      <section className="card" aria-labelledby="h-legal-sec">
        <h2 id="h-legal-sec">{t('compliance.security.title')}</h2>
        <dl className="legal-rows">
          <div><dt>{t('compliance.security.hosting')}</dt><dd>
            {sec.hostingProvider ? t('compliance.security.hostingValue', { provider: sec.hostingProvider, region: sec.hostingRegion }) : t('compliance.security.hostingMissing')}
            {' · '}{t(`compliance.security.location.${sec.hostingLocation}`)}
          </dd></div>
          <div><dt>{t('compliance.security.https')}</dt><dd>{yes(sec.https && sec.hsts)}</dd></div>
          <div><dt>{t('compliance.security.database')}</dt><dd>{t(`compliance.security.db.${sec.databaseTls}`)}</dd></div>
          <div><dt>{t('compliance.security.secretKey')}</dt><dd>{yes(sec.secretKey)}</dd></div>
          <div><dt>{t('compliance.security.atRest')}</dt><dd>{sec.hostingLocation === 'local' ? '–' : yes(true)}</dd></div>
        </dl>
      </section>
    </div>
  );
}
