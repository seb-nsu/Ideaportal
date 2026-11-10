import { Link } from 'react-router-dom';
import { ErrorBox, Loading, useLoad } from '../components';
import { formatDate, formatDateTime, formatNumber, labelMap, t } from '../i18n';
import { LanguageSwitch } from '../LanguageSwitch';

// Public status page (R3-10): state per component, incidents and maintenance, availability of
// the last 90 days. No login; the API shows no internal figures.

type State = 'operational' | 'degraded' | 'outage' | 'maintenance';

interface Notice {
  id: string;
  kind: 'incident' | 'maintenance';
  severity: 'minor' | 'major';
  title: string;
  body: string;
  components: string[];
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface PublicStatus {
  status: State;
  updatedAt: string;
  components: { id: string; status: State }[];
  active: Notice[];
  upcoming: Notice[];
  recent: Notice[];
  history: {
    days: { date: string; uptimePercent: number | null; worst: 'operational' | 'degraded' | 'outage' | null }[];
    uptimePercent: number | null;
    monthPercent: number | null;
    checkMinutes: number;
  };
}

const TONE: Record<State, string> = { operational: 'green', degraded: 'yellow', maintenance: 'accent', outage: 'red' };
const ALERT: Record<State, string> = { operational: 'success', degraded: 'warn', maintenance: 'info', outage: 'error' };

export const COMPONENT_LABELS = () => labelMap('saas.component', ['api', 'jobs', 'ai', 'mail'] as const);
export const STATE_LABELS = () => labelMap('saas.state', ['operational', 'degraded', 'outage', 'maintenance'] as const);
const OVERALL_LABELS = () => labelMap('saas.overall', ['operational', 'degraded', 'outage', 'maintenance'] as const);

const pct = (v: number | null) => (v == null ? t('saas.status.noData') : `${formatNumber(v, 2)} %`);

function NoticeList({ title, items }: { title: string; items: Notice[] }) {
  const components = COMPONENT_LABELS();
  if (!items.length) return null;
  return (
    <section className="card stack" aria-label={title}>
      <h2>{title}</h2>
      {items.map((n) => (
        <article key={n.id} className="stack">
          <h3>
            {n.title}{' '}
            <span className={`badge ${n.kind === 'maintenance' ? 'accent' : n.severity === 'major' ? 'red' : 'yellow'}`}>
              {n.kind === 'maintenance' ? t('saas.notice.maintenance') : n.severity === 'major' ? t('saas.notice.major') : t('saas.notice.minor')}
            </span>
          </h3>
          <p className="small muted">
            {t('saas.notice.time', { from: formatDateTime(n.startsAt), to: n.resolvedAt ? formatDateTime(n.resolvedAt) : n.endsAt ? formatDateTime(n.endsAt) : t('saas.notice.open') })}
            {n.components.length > 0 && <> · {n.components.map((c) => components[c] ?? c).join(', ')}</>}
          </p>
          {n.body && <p className="pre">{n.body}</p>}
        </article>
      ))}
    </section>
  );
}

export function Status() {
  const { data, error, loading } = useLoad<PublicStatus>('/api/status');
  const components = COMPONENT_LABELS();
  const states = STATE_LABELS();
  return (
    <main id="inhalt" className="stack status-page">
      <div className="row spread">
        <Link to="/" className="brand">{t('saas.status.brand')}</Link>
        <LanguageSwitch />
      </div>
      <h1>{t('saas.status.title')}</h1>
      {loading && !data && <Loading />}
      <ErrorBox error={error} />
      {data && (
        <>
          <div className={`alert ${ALERT[data.status]}`} role="status">
            <strong>{OVERALL_LABELS()[data.status]}</strong>
            <div className="small">{t('saas.status.updated', { time: formatDateTime(data.updatedAt) })}</div>
          </div>

          <section className="card" aria-labelledby="status-components">
            <h2 id="status-components">{t('saas.status.components')}</h2>
            <table>
              <tbody>
                {data.components.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{components[c.id] ?? c.id}</th>
                    <td><span className={`badge ${TONE[c.status]}`}>{states[c.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <NoticeList title={t('saas.status.active')} items={data.active} />
          <NoticeList title={t('saas.status.upcoming')} items={data.upcoming} />

          <section className="card stack" aria-labelledby="status-history">
            <h2 id="status-history">{t('saas.status.history', { days: data.history.days.length })}</h2>
            <p>
              {t('saas.status.uptime', { value: pct(data.history.uptimePercent) })}
              {' · '}
              {t('saas.status.month', { value: pct(data.history.monthPercent) })}
            </p>
            <ol className="uptime-bars" aria-label={t('saas.status.barsLabel')}>
              {data.history.days.map((d) => (
                <li
                  key={d.date}
                  className={d.uptimePercent == null ? 'none' : d.worst ?? 'none'}
                  title={t('saas.status.dayTitle', { date: formatDate(d.date), value: pct(d.uptimePercent) })}
                >
                  <span className="sr-only">{t('saas.status.dayTitle', { date: formatDate(d.date), value: pct(d.uptimePercent) })}</span>
                </li>
              ))}
            </ol>
            <p className="small muted">{t('saas.status.legend')}</p>
            <p className="small muted">{t('saas.status.measured', { minutes: data.history.checkMinutes })}</p>
          </section>

          <NoticeList title={t('saas.status.recent')} items={data.recent} />

          <section className="card stack" aria-labelledby="status-sla">
            <h2 id="status-sla">{t('saas.sla.title')}</h2>
            <p>{t('saas.sla.text')}</p>
            <p className="small muted">{t('saas.sla.exclusions')}</p>
          </section>
        </>
      )}
    </main>
  );
}
