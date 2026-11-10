import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type UserRef } from '../api';
import { ErrorBox, Field, Loading, StatusBadge, UserPicker, useAction, useLoad } from '../components';
import { formatDate, labelMap, t, tn } from '../i18n';
import { useSession, hasRole } from '../session';
import { UpgradeHint } from '../plan';

// AP-27 "Erkennen": trend and technology radar (R4-11), weekly trend hints (R4-02), white
// spots (R4-03) and the problem radar from tickets and feedback (R4-01). Every chart has a
// table with the same data (WCAG 2.1 AA).

const HORIZONS = ['now', 'next', 'later'] as const;
const MATURITIES = ['emerging', 'growing', 'established'] as const;
type Horizon = (typeof HORIZONS)[number];
type Maturity = (typeof MATURITIES)[number];

interface TrendItem {
  id: string;
  title: string;
  description: string;
  topic: string;
  horizon: Horizon;
  maturity: Maturity;
  origin: 'manual' | 'digest';
  sources: { title: string; url: string }[];
  ideas: { id: string; number: number; title: string; status: string }[];
  suggestions: { id: string; kind: 'idea' | 'web'; reason: string; idea: { id: string; number: number; title: string } | null; source: { title: string; url: string; snippet: string } | null }[];
}

interface RadarData {
  topics: string[];
  canManage: boolean;
  items: TrendItem[];
}

type Tab = 'radar' | 'hints' | 'white' | 'problems';

export function Radar() {
  const { me } = useSession();
  const manage = hasRole(me, 'lead', 'triage', 'admin');
  const view = hasRole(me, 'lead', 'triage', 'committee', 'admin');
  // Sponsors without one of these roles reach the page from the weekly mail and see their hints.
  const tabs: Tab[] = manage ? ['radar', 'hints', 'white', 'problems'] : view ? ['radar', 'hints', 'white'] : ['hints'];
  const labels = labelMap('radar.tab', tabs);
  const [tab, setTab] = useState<Tab>(tabs[0]);
  return (
    <div className="stack">
      <h1>{t('radar.title')}</h1>
      <p className="muted">{t('radar.intro')}</p>
      <div className="tabs" role="tablist">
        {tabs.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{labels[k]}</button>
        ))}
      </div>
      {tab === 'radar' && <TrendRadar />}
      {tab === 'hints' && <TrendHints />}
      {tab === 'white' && <WhiteSpots />}
      {tab === 'problems' && <ProblemRadar />}
    </div>
  );
}

// ---------------------------------------------------------------- radar (R4-11)

const HORIZON = () => labelMap('radar.horizon', HORIZONS);
const MATURITY = () => labelMap('radar.maturity', MATURITIES);

/** Radar as SVG: one sector per topic field, rings by horizon, the marker shows the maturity. */
function RadarChart({ topics, items }: { topics: string[]; items: TrendItem[] }) {
  const size = 420;
  const c = size / 2;
  const ringR = [70, 130, 190];
  const n = Math.max(1, topics.length);
  const sector = (2 * Math.PI) / n;
  const point = (r: number, a: number) => [c + r * Math.cos(a - Math.PI / 2), c + r * Math.sin(a - Math.PI / 2)];
  const placed = items.map((it, idx) => {
    const ti = Math.max(0, topics.indexOf(it.topic));
    const ring = HORIZONS.indexOf(it.horizon);
    const same = items.filter((x) => x.topic === it.topic && x.horizon === it.horizon);
    const k = same.indexOf(it);
    const a = ti * sector + (sector * (k + 1)) / (same.length + 1);
    const inner = ring === 0 ? 15 : ringR[ring - 1];
    const r = inner + (ringR[ring] - inner) * (0.35 + 0.3 * ((k % 3) / 2));
    const [x, y] = point(r, a);
    return { it, x, y, n: idx + 1 };
  });
  const H = HORIZON();
  return (
    <figure className="chart" style={{ maxWidth: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby="radar-svg-title radar-svg-desc" width="100%">
        <title id="radar-svg-title">{t('radar.chart.title')}</title>
        <desc id="radar-svg-desc">{t('radar.chart.desc', { n: items.length })}</desc>
        {[...ringR].reverse().map((r, i) => (
          <circle key={r} cx={c} cy={c} r={r} fill="none" stroke="var(--border)" strokeWidth={i === 0 ? 2 : 1} />
        ))}
        {topics.map((topic, i) => {
          const [x1, y1] = point(ringR[2], i * sector);
          const [lx, ly] = point(ringR[2] + 14, i * sector + sector / 2);
          return (
            <g key={topic}>
              <line x1={c} y1={c} x2={x1} y2={y1} stroke="var(--border)" />
              <text x={lx} y={ly} textAnchor={lx < c - 5 ? 'end' : lx > c + 5 ? 'start' : 'middle'} className="chart-label" style={{ fontSize: 11 }}>{topic}</text>
            </g>
          );
        })}
        {HORIZONS.map((h, i) => (
          <text key={h} x={c + 3} y={c - ringR[i] + 12} className="chart-label">{H[h]}</text>
        ))}
        {placed.map(({ it, x, y, n: num }) => (
          <g key={it.id}>
            {it.maturity === 'established'
              ? <rect x={x - 7} y={y - 7} width={14} height={14} fill="var(--accent)" />
              : <circle cx={x} cy={y} r={7} fill={it.maturity === 'growing' ? 'var(--accent)' : 'var(--surface)'} stroke="var(--accent)" strokeWidth={2} />}
            <text x={x + 9} y={y + 4} style={{ fontSize: 11, fill: 'var(--text)' }}>{num}</text>
          </g>
        ))}
      </svg>
      <figcaption className="small muted">{t('radar.chart.legend')}</figcaption>
    </figure>
  );
}

function TrendRadar() {
  const { data, loading, error, reload } = useLoad<RadarData>('/api/radar');
  const { busy, error: actionError, run } = useAction();
  const [editing, setEditing] = useState<TrendItem | null>(null);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const H = HORIZON();
  const M = MATURITY();
  const remove = async (id: string) => {
    if (window.confirm(t('radar.item.confirmDelete')) && (await run(() => api.del(`/api/radar/items/${id}`)))) await reload();
  };
  const decide = async (id: string, accept: boolean) => {
    if (await run(() => api.post(`/api/radar/suggestions/${id}/${accept ? 'accept' : 'dismiss'}`))) await reload();
  };
  const assign = async () => {
    const r = await run(() => api.post<{ suggestions: number }>('/api/radar/assign'));
    if (r) {
      window.alert(tn('radar.assign.done', r.suggestions));
      await reload();
    }
  };
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="h-radar">
        <h2 id="h-radar">{t('radar.chart.heading')}</h2>
        {data.items.length === 0 ? <p className="muted">{t('radar.empty')}</p> : <RadarChart topics={data.topics} items={data.items} />}
        <ErrorBox error={actionError} />
        {data.canManage && (
          <div className="row">
            <button type="button" onClick={assign} disabled={busy || !data.items.length}>{t('radar.assign.button')}</button>
            <span className="small muted">{t('radar.assign.hint')}</span>
          </div>
        )}
        {data.items.length > 0 && (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">{t('radar.table.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('radar.col.number')}</th>
                  <th scope="col">{t('radar.col.trend')}</th>
                  <th scope="col">{t('radar.col.topic')}</th>
                  <th scope="col">{t('radar.col.horizon')}</th>
                  <th scope="col">{t('radar.col.maturity')}</th>
                  <th scope="col">{t('radar.col.ideas')}</th>
                  <th scope="col">{t('radar.col.sources')}</th>
                  {data.canManage && <th scope="col"><span className="sr-only">{t('radar.col.actions')}</span></th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((it, i) => (
                  <tr key={it.id}>
                    <td>{i + 1}</td>
                    <td>
                      <strong>{it.title}</strong>
                      {it.origin === 'digest' && <> <span className="badge">{t('radar.item.fromDigest')}</span></>}
                      {it.description && <div className="small muted">{it.description}</div>}
                      {it.suggestions.length > 0 && (
                        <ul className="small" aria-label={t('radar.suggestions.label')}>
                          {it.suggestions.map((s) => (
                            <li key={s.id}>
                              {s.idea ? <Link to={`/ideen/${s.idea.id}`}>#{s.idea.number} {s.idea.title}</Link> : s.source && <a href={s.source.url} target="_blank" rel="noreferrer">{s.source.title}</a>}
                              {' '}<span className="muted">({s.reason})</span>{' '}
                              <button type="button" className="link" onClick={() => decide(s.id, true)} disabled={busy}>{t(s.kind === 'idea' ? 'radar.suggestions.link' : 'radar.suggestions.addSource')}</button>{' '}
                              <button type="button" className="link" onClick={() => decide(s.id, false)} disabled={busy}>{t('radar.suggestions.dismiss')}</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>{it.topic}</td>
                    <td>{H[it.horizon]}</td>
                    <td>{M[it.maturity]}</td>
                    <td>
                      {it.ideas.length === 0 ? '–' : (
                        <ul className="small">
                          {it.ideas.map((idea) => (
                            <li key={idea.id}>
                              <Link to={`/ideen/${idea.id}`}>#{idea.number} {idea.title}</Link> <StatusBadge status={idea.status} />
                              {data.canManage && <> <button type="button" className="link" onClick={async () => { if (await run(() => api.del(`/api/radar/items/${it.id}/ideas/${idea.id}`))) await reload(); }} disabled={busy}>{t('radar.item.unlink')}</button></>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {data.canManage && <LinkIdea trendId={it.id} onDone={reload} />}
                    </td>
                    <td>
                      {it.sources.length === 0 ? '–' : (
                        <ul className="small">
                          {it.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>)}
                        </ul>
                      )}
                    </td>
                    {data.canManage && (
                      <td>
                        <button type="button" className="link" onClick={() => setEditing(it)}>{t('radar.item.edit')}</button>{' '}
                        <button type="button" className="link" onClick={() => remove(it.id)} disabled={busy}>{t('radar.item.delete')}</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {data.canManage && <TrendForm key={editing?.id ?? 'new'} topics={data.topics} item={editing} onDone={async () => { setEditing(null); await reload(); }} />}
    </div>
  );
}

function LinkIdea({ trendId, onDone }: { trendId: string; onDone: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; number: number; title: string }[] | null>(null);
  const { busy, error, run } = useAction();
  const search = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.get<{ items: { id: string; number: number; title: string }[] }>(`/api/ideas?scope=all&limit=5&q=${encodeURIComponent(q)}`));
    if (r) setHits(r.items);
  };
  const link = async (ideaId: string) => {
    if (await run(() => api.post(`/api/radar/items/${trendId}/ideas`, { ideaId }))) {
      setQ('');
      setHits(null);
      await onDone();
    }
  };
  const id = `link-${trendId}`;
  return (
    <form onSubmit={search} className="small" style={{ marginTop: 6 }}>
      <label htmlFor={id} className="sr-only">{t('radar.link.label')}</label>
      <input id={id} type="search" value={q} maxLength={200} placeholder={t('radar.link.placeholder')} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 180 }} />
      <button type="submit" disabled={busy || q.trim().length < 2}>{t('radar.link.search')}</button>
      <ErrorBox error={error} />
      {hits && (hits.length === 0 ? <p className="muted">{t('radar.link.none')}</p> : (
        <ul>
          {hits.map((h) => (
            <li key={h.id}>
              #{h.number} {h.title} <button type="button" className="link" onClick={() => link(h.id)} disabled={busy}>{t('radar.link.do')}</button>
            </li>
          ))}
        </ul>
      ))}
    </form>
  );
}

function TrendForm({ topics, item, onDone }: { topics: string[]; item: TrendItem | null; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [topic, setTopic] = useState(item?.topic ?? topics[0] ?? '');
  const [horizon, setHorizon] = useState<Horizon>(item?.horizon ?? 'next');
  const [maturity, setMaturity] = useState<Maturity>(item?.maturity ?? 'emerging');
  const { busy, error, run } = useAction();
  const H = HORIZON();
  const M = MATURITY();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { title, description, topic, horizon, maturity };
    const ok = await run(() => (item ? api.patch(`/api/radar/items/${item.id}`, body) : api.post('/api/radar/items', body)));
    if (ok) {
      setTitle('');
      setDescription('');
      await onDone();
    }
  };
  return (
    <section className="card" aria-labelledby="h-trend-form">
      <h2 id="h-trend-form">{item ? t('radar.form.editTitle') : t('radar.form.newTitle')}</h2>
      <form onSubmit={save} className="stack">
        <Field id="trend-title" label={t('radar.form.title')}>
          <input id="trend-title" type="text" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        <Field id="trend-desc" label={t('radar.form.description')}>
          <textarea id="trend-desc" value={description} maxLength={2000} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-3">
          <Field id="trend-topic" label={t('radar.form.topic')}>
            <select id="trend-topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
              {topics.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <Field id="trend-horizon" label={t('radar.form.horizon')}>
            <select id="trend-horizon" value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)}>
              {HORIZONS.map((h) => <option key={h} value={h}>{H[h]}</option>)}
            </select>
          </Field>
          <Field id="trend-maturity" label={t('radar.form.maturity')}>
            <select id="trend-maturity" value={maturity} onChange={(e) => setMaturity(e.target.value as Maturity)}>
              {MATURITIES.map((x) => <option key={x} value={x}>{M[x]}</option>)}
            </select>
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="primary" disabled={busy || title.trim().length < 2}>{item ? t('radar.form.save') : t('radar.form.add')}</button>
          {item && <button type="button" onClick={() => void onDone()}>{t('radar.form.cancel')}</button>}
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- trend hints (R4-02)

interface Digest {
  id: string;
  topic: string;
  week: string;
  summary: string;
  points: { text: string; sources: number[] }[];
  candidates: { title: string; description: string; sources: number[] }[];
  sources: { id: number; title: string; url: string }[];
  warnings: string[];
  adopted?: number[];
  meta: { builtin: boolean; model: string };
}

function TrendHints() {
  const { me } = useSession();
  const manage = hasRole(me, 'lead', 'triage', 'admin');
  const view = hasRole(me, 'lead', 'triage', 'committee', 'admin');
  const { data, loading, error, reload } = useLoad<Digest[]>('/api/radar/digests');
  const { busy, error: actionError, run } = useAction();
  const generate = async () => {
    if (await run(() => api.post('/api/radar/digests/run', {}))) await reload();
  };
  const adopt = async (d: Digest, index: number) => {
    if (await run(() => api.post(`/api/radar/digests/${d.id}/adopt`, { index, horizon: 'next', maturity: 'emerging' }))) await reload();
  };
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="h-hints">
        <h2 id="h-hints">{t('radar.hints.title')}</h2>
        <p className="small muted">{t('radar.hints.intro')}</p>
        {manage && (
          <div className="row">
            <button type="button" onClick={generate} disabled={busy}>{busy ? t('radar.hints.busy') : t('radar.hints.run')}</button>
            <span className="small muted">{t('radar.hints.runHint')}</span>
          </div>
        )}
        <ErrorBox error={actionError ?? error} />
        {loading && !data ? <Loading /> : data && data.length === 0 ? <p className="muted">{t('radar.hints.none')}</p> : data?.map((d) => (
          <article key={d.id} className="card stack" aria-labelledby={`dg-${d.id}`}>
            <h3 id={`dg-${d.id}`}>{t('radar.hints.digestTitle', { topic: d.topic, week: d.week })}</h3>
            <p>{d.summary}</p>
            {d.points.length > 0 && (
              <ul>
                {d.points.map((p, i) => <li key={i}>{p.text} <span className="muted small">[{p.sources.join(', ')}]</span></li>)}
              </ul>
            )}
            {d.sources.length > 0 && (
              <>
                <h4>{t('radar.hints.sources')}</h4>
                <ol className="small">
                  {d.sources.map((s) => <li key={s.id} value={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>)}
                </ol>
              </>
            )}
            {manage && d.candidates.length > 0 && (
              <>
                <h4>{t('radar.hints.candidates')}</h4>
                <ul>
                  {d.candidates.map((c, i) => (
                    <li key={i}>
                      <strong>{c.title}</strong> <span className="small muted">{c.description}</span>{' '}
                      {d.adopted?.includes(i)
                        ? <span className="badge green">{t('radar.hints.adopted')}</span>
                        : <button type="button" className="link" onClick={() => adopt(d, i)} disabled={busy}>{t('radar.hints.adopt')}</button>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {d.warnings.length > 0 && <p className="small muted">{d.warnings.join(' ')}</p>}
            <p className="small muted">{d.meta.builtin ? t('radar.hints.builtin') : t('radar.hints.ai', { model: d.meta.model })}</p>
          </article>
        ))}
      </section>
      {view && <Sponsors canEdit={manage} />}
    </div>
  );
}

function Sponsors({ canEdit }: { canEdit: boolean }) {
  const { data, reload } = useLoad<{ topic: string; sponsors: UserRef[] }[]>('/api/radar/sponsors');
  const [picked, setPicked] = useState<Record<string, UserRef | null>>({});
  const { busy, error, run } = useAction();
  const save = async (topic: string, ids: string[]) => {
    if (await run(() => api.put('/api/radar/sponsors', { topic, userIds: ids }))) {
      setPicked((p) => ({ ...p, [topic]: null }));
      await reload();
    }
  };
  if (!data) return <Loading />;
  return (
    <section className="card stack" aria-labelledby="h-sponsors">
      <h2 id="h-sponsors">{t('radar.sponsors.title')}</h2>
      <p className="small muted">{t('radar.sponsors.intro')}</p>
      <ErrorBox error={error} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('radar.col.topic')}</th>
              <th scope="col">{t('radar.sponsors.col')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={row.topic}>
                <th scope="row">{row.topic}</th>
                <td>
                  {row.sponsors.length === 0 && <span className="muted">–</span>}
                  {row.sponsors.map((s) => (
                    <span key={s.id} className="badge" style={{ marginRight: 4 }}>
                      {s.displayName}
                      {canEdit && <> <button type="button" className="link" aria-label={t('radar.sponsors.remove', { name: s.displayName })} onClick={() => save(row.topic, row.sponsors.filter((x) => x.id !== s.id).map((x) => x.id))} disabled={busy}>×</button></>}
                    </span>
                  ))}
                  {canEdit && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <UserPicker id={`sp-${i}`} value={picked[row.topic] ?? null} onChange={(u) => setPicked((p) => ({ ...p, [row.topic]: u }))} />
                      <button type="button" disabled={busy || !picked[row.topic]} onClick={() => save(row.topic, [...row.sponsors.map((x) => x.id), picked[row.topic]!.id])}>{t('radar.sponsors.add')}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- white spots (R4-03)

interface WhiteSpotData {
  months: number;
  since: string;
  topics: { topic: string; ideas: number; recentIdeas: number; activeChallenges: number; trends: number; whiteSpot: boolean }[];
  withoutTopic: number;
  whiteSpots: number;
}

function WhiteSpots() {
  const { data, loading, error } = useLoad<WhiteSpotData>('/api/radar/white-spots');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const max = Math.max(1, ...data.topics.map((x) => x.recentIdeas));
  return (
    <section className="card stack" aria-labelledby="h-white">
      <h2 id="h-white">{t('radar.white.title')}</h2>
      <p className="small muted">{t('radar.white.intro', { months: data.months, since: formatDate(data.since) })}</p>
      <p><strong>{tn('radar.white.count', data.whiteSpots)}</strong></p>
      {/* Bar chart for sighted users; the table below carries the same numbers. */}
      <div aria-hidden="true" className="stack" style={{ gap: 6 }}>
        {data.topics.map((x) => (
          <div key={x.topic} className="row" style={{ flexWrap: 'nowrap' }}>
            <span style={{ width: 180, flexShrink: 0 }} className="small">{x.topic}</span>
            <span style={{ flex: 1, background: 'var(--gray-soft)', borderRadius: 4, height: 18, position: 'relative' }}>
              {x.whiteSpot
                ? <span className="small" style={{ position: 'absolute', left: 6, top: 0, color: 'var(--red)', fontWeight: 600 }}>{t('radar.white.spot')}</span>
                : <span style={{ display: 'block', height: '100%', width: `${(x.recentIdeas / max) * 100}%`, background: 'var(--accent)', borderRadius: 4 }} />}
            </span>
            <span style={{ width: 40, textAlign: 'right' }} className="small">{x.recentIdeas}</span>
          </div>
        ))}
      </div>
      <div className="table-scroll">
        <table>
          <caption className="sr-only">{t('radar.white.caption', { months: data.months })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('radar.col.topic')}</th>
              <th scope="col">{t('radar.white.col.recent', { months: data.months })}</th>
              <th scope="col">{t('radar.white.col.total')}</th>
              <th scope="col">{t('radar.white.col.challenges')}</th>
              <th scope="col">{t('radar.white.col.trends')}</th>
              <th scope="col">{t('radar.white.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {data.topics.map((x) => (
              <tr key={x.topic}>
                <th scope="row">{x.topic}</th>
                <td>{x.recentIdeas}</td>
                <td>{x.ideas}</td>
                <td>{x.activeChallenges}</td>
                <td>{x.trends}</td>
                <td>{x.whiteSpot ? <span className="badge red">{t('radar.white.spot')}</span> : <span className="badge green">{t('radar.white.covered')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.withoutTopic > 0 && <p className="small muted">{tn('radar.white.withoutTopic', data.withoutTopic)}</p>}
      <p className="small muted">{t('radar.white.hint')} <Link to="/challenges">{t('radar.white.toChallenges')}</Link></p>
    </section>
  );
}

// ---------------------------------------------------------------- problem radar (R4-01)

interface ProblemData {
  feature: boolean;
  minClusterSize: number;
  maxTickets: number;
  ticketDays: number;
  connectors: { id: string; name: string; kind: string }[];
  sources: { id: string; name: string; query: string; tableName: string; connectorName: string; kind: string; enabled: boolean }[];
  runs: {
    id: string; sourceKind: 'connector' | 'csv'; sourceName: string; items: number; minClusterSize: number; createdAt: string;
    clusters: { id: string; label: string; summary: string; frequency: number; examples: string[]; ideaId: string | null; challengeId: string | null; dismissed: boolean }[];
  }[];
}

function ProblemRadar() {
  const { me } = useSession();
  const { data, loading, error, reload } = useLoad<ProblemData>('/api/radar/problems');
  const { busy, error: actionError, run } = useAction();
  const [challengeFor, setChallengeFor] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const runSource = async (id: string) => {
    if (await run(() => api.post(`/api/radar/problems/sources/${id}/run`))) await reload();
  };
  const toProblem = async (id: string) => {
    const r = await run(() => api.post<{ ideaId: string }>(`/api/radar/problems/clusters/${id}/problem`, {}));
    if (r) window.location.href = `/einreichen/${r.ideaId}`;
  };
  const dismiss = async (id: string) => {
    if (await run(() => api.post(`/api/radar/problems/clusters/${id}/dismiss`))) await reload();
  };
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="h-problems">
        <h2 id="h-problems">{t('radar.problems.title')}</h2>
        <p className="small muted">{t('radar.problems.intro', { min: data.minClusterSize, days: data.ticketDays, max: data.maxTickets })}</p>
        <ErrorBox error={actionError} />
        <h3>{t('radar.problems.sources')}</h3>
        {!data.feature && <UpgradeHint feature="connectors" />}
        {data.sources.length === 0 ? <p className="muted">{t('radar.problems.noSources')}</p> : (
          <ul>
            {data.sources.map((s) => (
              <li key={s.id} className="row">
                <span><strong>{s.name}</strong> · {s.connectorName}{s.query && <span className="muted small"> · {s.query}</span>}</span>
                <button type="button" onClick={() => runSource(s.id)} disabled={busy || !data.feature || !s.enabled}>{busy ? t('radar.problems.busy') : t('radar.problems.run')}</button>
                {hasRole(me, 'lead', 'admin') && <button type="button" className="link" onClick={async () => { if (await run(() => api.del(`/api/radar/problems/sources/${s.id}`))) await reload(); }} disabled={busy}>{t('radar.problems.removeSource')}</button>}
              </li>
            ))}
          </ul>
        )}
        {data.feature && hasRole(me, 'lead', 'admin') && <SourceForm connectors={data.connectors} onDone={reload} />}
        <CsvUpload onDone={reload} />
      </section>
      {data.runs.map((r) => (
        <section key={r.id} className="card stack" aria-labelledby={`run-${r.id}`}>
          <h3 id={`run-${r.id}`}>{t('radar.problems.runTitle', { name: r.sourceName, date: formatDate(r.createdAt) })}</h3>
          <p className="small muted">{tn('radar.problems.runItems', r.items, { min: r.minClusterSize })}</p>
          {r.clusters.length === 0 ? <p className="muted">{t('radar.problems.noClusters')}</p> : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('radar.problems.col.problem')}</th>
                    <th scope="col">{t('radar.problems.col.frequency')}</th>
                    <th scope="col">{t('radar.problems.col.examples')}</th>
                    <th scope="col"><span className="sr-only">{t('radar.col.actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {r.clusters.map((c) => (
                    <tr key={c.id} className={c.dismissed ? 'muted' : undefined}>
                      <td><strong>{c.label}</strong><div className="small muted">{c.summary}</div></td>
                      <td>{c.frequency}</td>
                      <td><ul className="small">{c.examples.map((e, i) => <li key={i}>{e}</li>)}</ul></td>
                      <td>
                        {c.ideaId ? <Link to={`/ideen/${c.ideaId}`}>{t('radar.problems.toIdea')}</Link>
                          : c.challengeId ? <Link to={`/challenges/${c.challengeId}`}>{t('radar.problems.toChallenge')}</Link>
                            : c.dismissed ? <span className="small muted">{t('radar.problems.dismissed')}</span> : (
                              <div className="stack" style={{ gap: 4 }}>
                                <button type="button" onClick={() => toProblem(c.id)} disabled={busy}>{t('radar.problems.makeProblem')}</button>
                                <button type="button" onClick={() => setChallengeFor(challengeFor === c.id ? null : c.id)} aria-expanded={challengeFor === c.id}>{t('radar.problems.makeChallenge')}</button>
                                <button type="button" className="link" onClick={() => dismiss(c.id)} disabled={busy}>{t('radar.problems.dismiss')}</button>
                                {challengeFor === c.id && <ChallengeForm cluster={c} onDone={async () => { setChallengeFor(null); await reload(); }} />}
                              </div>
                            )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function SourceForm({ connectors, onDone }: { connectors: ProblemData['connectors']; onDone: () => Promise<void> }) {
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? '');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [tableName, setTableName] = useState('');
  const { busy, error, run } = useAction();
  const kind = connectors.find((c) => c.id === connectorId)?.kind;
  if (!connectors.length) return <p className="small muted">{t('radar.problems.noConnectors')} <Link to="/einstellungen">{t('radar.problems.toSettings')}</Link></p>;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/radar/problems/sources', { connectorId, name, query, tableName }))) {
      setName('');
      setQuery('');
      await onDone();
    }
  };
  return (
    <form onSubmit={save} className="stack">
      <h4>{t('radar.problems.addSource')}</h4>
      <div className="grid grid-3">
        <Field id="ps-connector" label={t('radar.problems.connector')}>
          <select id="ps-connector" value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
            {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field id="ps-name" label={t('radar.problems.sourceName')}>
          <input id="ps-name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field id="ps-query" label={t('radar.problems.query')} hint={t(kind === 'jira' ? 'radar.problems.queryJira' : kind === 'servicenow' ? 'radar.problems.querySnow' : 'radar.problems.queryAdo')}>
          <input id="ps-query" type="text" value={query} maxLength={500} onChange={(e) => setQuery(e.target.value)} aria-describedby="ps-query-hint" />
        </Field>
        {kind === 'servicenow' && (
          <Field id="ps-table" label={t('radar.problems.table')}>
            <input id="ps-table" type="text" value={tableName} maxLength={80} placeholder={'incident'} onChange={(e) => setTableName(e.target.value)} />
          </Field>
        )}
      </div>
      <ErrorBox error={error} />
      <div><button disabled={busy || name.trim().length < 2}>{t('radar.problems.saveSource')}</button></div>
    </form>
  );
}

function CsvUpload({ onDone }: { onDone: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const csv = await file.text();
    if (await run(() => api.post('/api/radar/problems/csv', { name: file.name.slice(0, 80).padEnd(2, '_'), csv }))) {
      setFile(null);
      await onDone();
    }
  };
  return (
    <form onSubmit={upload} className="stack">
      <h3>{t('radar.problems.csvTitle')}</h3>
      <Field id="ps-csv" label={t('radar.problems.csvLabel')} hint={t('radar.problems.csvHint')}>
        <input id="ps-csv" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-describedby="ps-csv-hint" />
      </Field>
      <ErrorBox error={error} />
      <div><button disabled={busy || !file}>{busy ? t('radar.problems.busy') : t('radar.problems.csvRun')}</button></div>
    </form>
  );
}

function ChallengeForm({ cluster, onDone }: { cluster: { id: string; label: string; summary: string }; onDone: () => Promise<void> }) {
  const { settings } = useSession();
  const [title, setTitle] = useState(cluster.label.slice(0, 140));
  const [question, setQuestion] = useState(cluster.summary);
  const [endsOn, setEndsOn] = useState('');
  const { busy, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/radar/problems/clusters/${cluster.id}/challenge`, { title, question, endsOn }))) await onDone();
  };
  const id = `cf-${cluster.id}`;
  return (
    <form onSubmit={save} className="stack">
      <Field id={`${id}-title`} label={t('radar.challenge.title')}>
        <input id={`${id}-title`} type="text" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field id={`${id}-q`} label={t('radar.challenge.question')}>
        <textarea id={`${id}-q`} value={question} maxLength={3000} rows={3} onChange={(e) => setQuestion(e.target.value)} required />
      </Field>
      <Field id={`${id}-end`} label={t('radar.challenge.endsOn')}>
        <input id={`${id}-end`} type="date" value={endsOn} min={settings.today} onChange={(e) => setEndsOn(e.target.value)} required />
      </Field>
      <ErrorBox error={error} />
      <div><button className="primary" disabled={busy || !endsOn || question.trim().length < 10}>{t('radar.challenge.create')}</button></div>
    </form>
  );
}
