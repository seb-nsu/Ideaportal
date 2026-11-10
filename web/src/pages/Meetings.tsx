import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type IdeaListItem } from '../api';
import { ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components';
import { HORIZON, OUTCOMES, formatDate, formatDateTime, formatEuro, formatNumber } from '../labels';
import { hasRole, useSession } from '../session';
import { DecisionForm } from './idea/Elaboration';
import { HitBand, type ItemCalibration } from './idea/Impact';
import { MeetingBrief } from '../ai/Extras';
import { labelMap, t } from '../i18n';
import { EmptyState, FirstStart } from './Onboarding';

// Committee meetings at Gate 2 (R2-04): at most a configured number of ideas, pack sent a few
// working days before, comparison view and decisions with the usual Gate 2 form.

interface MeetingListItem {
  id: string;
  title: string;
  meetsOn: string;
  packDueOn: string;
  packSentAt: string | null;
  status: 'planned' | 'sent' | 'held';
  items: number;
}

const MEETING_STATUS = labelMap('meetings.status', ['planned', 'sent', 'held'] as const);

export function Meetings() {
  const { me, settings } = useSession();
  const navigate = useNavigate();
  const { data, error, loading } = useLoad<{ items: MeetingListItem[]; maxIdeas: number; packWorkdays: number }>('/api/meetings');
  const [form, setForm] = useState(() => ({ title: t('meetings.defaultTitle'), meetsOn: '' }));
  const { busy, error: createError, run } = useAction();
  const canCreate = hasRole(me, 'triage', 'admin');
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ id: string }>('/api/meetings', form));
    if (r) navigate(`/gremium/${r.id}`);
  };
  return (
    <div className="stack">
      <h1>{t('meetings.title')}</h1>
      <FirstStart screen="gremium" />
      <p className="muted">
        {t('meetings.intro', { max: settings.elaboration.meetingMaxIdeas, days: settings.elaboration.meetingPackWorkdays })}
      </p>
      {canCreate && (
        <form className="card" onSubmit={create} aria-labelledby="h-new-meeting">
          <h2 id="h-new-meeting">{t('meetings.new.title')}</h2>
          <ErrorBox error={createError} />
          <div className="grid grid-2">
            <Field id="m-title" label={t('meetings.new.titleLabel')}>
              <input id="m-title" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </Field>
            <Field id="m-date" label={t('meetings.new.dateLabel')}>
              <input id="m-date" type="date" min={settings.today} value={form.meetsOn} onChange={(e) => setForm({ ...form, meetsOn: e.target.value })} required />
            </Field>
          </div>
          <button className="primary" disabled={busy}>{t('meetings.new.create')}</button>
        </form>
      )}
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : (
        <section className="card" aria-labelledby="h-meetings">
          <h2 id="h-meetings">{t('meetings.list.title')}</h2>
          {data?.items.length === 0 && <EmptyState text={t('meetings.list.empty')} place="meetings" />}
          {!!data?.items.length && (
            <div className="table-wrap" tabIndex={0}><table>
              <thead><tr><th scope="col">{t('meetings.list.meeting')}</th><th scope="col">{t('meetings.list.date')}</th><th scope="col">{t('meetings.list.pack')}</th><th scope="col">{t('meetings.list.ideas')}</th><th scope="col">{t('meetings.list.status')}</th></tr></thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id}>
                    <td><Link to={`/gremium/${m.id}`}>{m.title}</Link></td>
                    <td>{formatDate(m.meetsOn)}</td>
                    <td>{m.packSentAt ? formatDate(m.packSentAt) : t('meetings.list.packDue', { date: formatDate(m.packDueOn) })}</td>
                    <td>{t('meetings.list.count', { n: m.items, max: data.maxIdeas })}</td>
                    <td>{MEETING_STATUS[m.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      )}
    </div>
  );
}

interface MeetingItem {
  id: string;
  number: number;
  title: string;
  status: string;
  topic: string | null;
  horizon: number | null;
  effortPersonDays: number | null;
  effortEuro: number | null;
  planBenefitEuro: number | null;
  confidential: boolean;
  mentorName: string | null;
  score: number | null;
  raters: number;
  risks: string | null;
  summary: string | null;
  decision: { outcome: string; reason: string; decidedAt: string } | null;
  /** Hit band of earlier forecasts of the same idea type (R4-07). */
  calibration?: ItemCalibration;
}

interface MeetingDetailData {
  id: string;
  title: string;
  meetsOn: string;
  packDueOn: string;
  packSentAt: string | null;
  status: 'planned' | 'sent' | 'held';
  maxIdeas: number;
  items: MeetingItem[];
  hiddenItems: number;
  can: { manage: boolean; decide: boolean; sendPack: boolean; delete: boolean };
  calibration?: { enough: boolean; closed: number; minClosed: number };
}

export function MeetingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad<MeetingDetailData>(`/api/meetings/${id}`);
  const [deciding, setDeciding] = useState<MeetingItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error: actionError, run } = useAction();
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const m = data;
  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMessage(null);
    if (await run(fn)) {
      setMessage(text);
      void reload();
    }
  };
  return (
    <div className="stack">
      <div className="row spread">
        <div>
          <p className="muted small" style={{ margin: 0 }}><Link to="/gremium">{t('meetings.title')}</Link></p>
          <FirstStart screen="gremium" />
          <h1>{m.title}</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {formatDate(m.meetsOn)} · {MEETING_STATUS[m.status]} · {m.packSentAt ? t('meetings.detail.packSent', { date: formatDateTime(m.packSentAt) }) : t('meetings.detail.packDue', { date: formatDate(m.packDueOn) })}
          </p>
        </div>
        <div className="row">
          {m.can.sendPack && <button type="button" disabled={busy} onClick={() => act(() => api.post(`/api/meetings/${m.id}/send`), t('meetings.detail.sentMessage'))}>{t('meetings.detail.send')}</button>}
          {m.can.manage && m.status !== 'planned' && <button type="button" disabled={busy} onClick={() => act(() => api.post(`/api/meetings/${m.id}/held`), t('meetings.detail.heldMessage'))}>{t('meetings.detail.hold')}</button>}
          {m.can.delete && (
            <button type="button" className="danger" disabled={busy} onClick={async () => (await run(() => api.del(`/api/meetings/${m.id}`))) && navigate('/gremium')}>
              {t('meetings.detail.delete')}
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={actionError} />
      {message && <p className="alert success" role="status">{message}</p>}

      <MeetingBrief meetingId={m.id} canCreate={m.can.manage || m.can.decide} />

      <section className="card" aria-labelledby="h-compare">
        <h2 id="h-compare">{t('meetings.compare.title', { n: m.items.length + m.hiddenItems, max: m.maxIdeas })}</h2>
        {m.hiddenItems > 0 && <p className="small muted">{t('meetings.compare.hidden', { n: m.hiddenItems })}</p>}
        {m.items.length === 0 ? <p className="muted">{t('meetings.compare.empty')}</p> : (
          <div className="table-scroll">
            <div className="table-wrap" tabIndex={0}><table className="compare">
              <caption className="sr-only">{t('meetings.compare.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('meetings.compare.idea')}</th>
                  <th scope="col">{t('meetings.compare.score')}</th>
                  <th scope="col">{t('meetings.compare.effort')}</th>
                  <th scope="col">{t('meetings.compare.benefit')}</th>
                  <th scope="col">{t('meetings.compare.horizon')}</th>
                  <th scope="col">{t('meetings.compare.risks')}</th>
                  <th scope="col">{t('meetings.compare.mentor')}</th>
                  <th scope="col">{t('meetings.compare.decision')}</th>
                </tr>
              </thead>
              <tbody>
                {m.items.map((i) => (
                  <tr key={i.id}>
                    <th scope="row">
                      <Link to={`/ideen/${i.id}`}>#{i.number} {i.title}</Link>
                      <div className="small"><StatusBadge status={i.status} />{i.confidential && <span className="badge">{t('meetings.compare.confidential')}</span>}</div>
                      {i.summary && <p className="small muted" style={{ margin: '4px 0 0', fontWeight: 400 }}>{i.summary}</p>}
                    </th>
                    <td>{i.score != null ? t('meetings.compare.scoreValue', { score: formatNumber(i.score) }) : '–'}<div className="small muted">{t('meetings.compare.raters', { n: i.raters })}</div></td>
                    <td>{i.effortPersonDays != null ? t('meetings.compare.personDays', { n: formatNumber(i.effortPersonDays) }) : '–'}<div className="small muted">{formatEuro(i.effortEuro)}</div></td>
                    <td>{formatEuro(i.planBenefitEuro)}<HitBand c={i.calibration} pack={m.calibration} /></td>
                    <td>{i.horizon ? <span title={HORIZON[i.horizon]}>H{i.horizon}</span> : '–'}</td>
                    <td className="small">{i.risks || '–'}</td>
                    <td>{i.mentorName ?? '–'}</td>
                    <td>
                      {i.decision ? (
                        <span className="badge green">{OUTCOMES[i.decision.outcome] ?? i.decision.outcome}</span>
                      ) : i.status === 'elaboration' && m.can.decide ? (
                        <button type="button" onClick={() => setDeciding(i)} aria-label={t('meetings.compare.decideAria', { number: i.number })}>{t('meetings.compare.decide')}</button>
                      ) : (
                        <span className="muted">–</span>
                      )}
                      {m.can.manage && !i.decision && (
                        <div>
                          <button type="button" className="link small" disabled={busy} aria-label={t('meetings.compare.removeAria', { number: i.number })}
                            onClick={() => act(() => api.del(`/api/meetings/${m.id}/items/${i.id}`), t('meetings.compare.removed', { number: i.number }))}>
                            {t('meetings.compare.remove')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </section>

      {deciding && (
        <section className="card" aria-labelledby="h-meeting-decision">
          <div className="row spread">
            <h2 id="h-meeting-decision">{t('meetings.decision.title', { number: deciding.number, title: deciding.title })}</h2>
            <button type="button" onClick={() => setDeciding(null)}>{t('meetings.decision.close')}</button>
          </div>
          <DecisionForm
            key={deciding.id}
            ideaId={deciding.id}
            meetingId={m.id}
            idPrefix={`meeting-${deciding.number}`}
            onDone={() => {
              setMessage(t('meetings.decision.saved', { number: deciding.number }));
              setDeciding(null);
              void reload();
            }}
          />
        </section>
      )}

      {m.can.manage && m.items.length + m.hiddenItems < m.maxIdeas && <AddIdea meetingId={m.id} present={m.items.map((i) => i.id)} onDone={() => void reload()} />}
    </div>
  );
}

function AddIdea({ meetingId, present, onDone }: { meetingId: string; present: string[]; onDone: () => void }) {
  const { data } = useLoad<IdeaListItem[]>('/api/ideas?scope=all&status=elaboration&sort=updated');
  const [ideaId, setIdeaId] = useState('');
  const { busy, error, run } = useAction();
  const candidates = (data ?? []).filter((i) => !present.includes(i.id));
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (ideaId && (await run(() => api.post(`/api/meetings/${meetingId}/items`, { ideaId })))) {
      setIdeaId('');
      onDone();
    }
  };
  return (
    <form className="card" onSubmit={add} aria-labelledby="h-add-idea">
      <h2 id="h-add-idea">{t('meetings.add.title')}</h2>
      <ErrorBox error={error} />
      {candidates.length === 0 ? <p className="muted">{t('meetings.add.empty')}</p> : (
        <>
          <Field id="add-idea" label={t('meetings.add.label')}>
            <select id="add-idea" value={ideaId} onChange={(e) => setIdeaId(e.target.value)} required>
              <option value="">{t('meetings.add.choose')}</option>
              {candidates.map((i) => <option key={i.id} value={i.id}>#{i.number} {i.title}</option>)}
            </select>
          </Field>
          <button className="primary" disabled={busy || !ideaId}>{t('meetings.add.submit')}</button>
        </>
      )}
    </form>
  );
}
