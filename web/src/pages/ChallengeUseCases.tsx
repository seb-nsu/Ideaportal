import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type UserRef } from '../api';
import { ErrorBox, Field, Loading, UserPicker, useAction, useLoad } from '../components';
import { formatDate, formatDateTime, formatNumber, labelMap, t, type MessageKey } from '../i18n';
import { BENEFIT } from '../labels';

// Use cases of a challenge (AP-22): impact per benefit kind with kWh and ESG export (R3-32),
// target value with controlling confirmation (R3-33), hackathon with window, pitches,
// audience voting and combined ranking (R3-34). The problem exchange (R3-31) lives at the idea.

const TARGET_KINDS = ['euro', 'hours', 'revenue', 'co2', 'kwh'] as const;

interface KindRow { kind: string; ideas: number; estimated: number; confirmed: number; confirmedIdeas: number }

interface Target {
  kind: string; value: number; from: string | null; until: string | null; estimated: number; confirmed: number;
  estimatedPercent: number; confirmedPercent: number; includesConvertedKwh: boolean;
}

export interface Confirmation {
  ideaId: string; number: number; title: string | null; challengeId: string | null; challengeTitle: string | null;
  benefitKind: string; reported: number | null; evidence: string | null; closedAt: string;
  outcome: 'confirmed' | 'corrected' | null; confirmedValue: number | null; comment: string | null; confirmedAt: string | null; confirmedBy: string | null; own: boolean;
}

interface PitchItem { id: string; number: number; title: string; teamName: string | null; position?: number; startsAfterMinutes?: number }

interface RankRow { id: string; number: number; title: string; teamName: string | null; jury: number | null; juryRatings: number; votes: number | null; juryScore: number | null; audienceScore: number | null; score: number | null; rank: number | null }

interface Hackathon {
  submissionOpensAt: string | null; submissionClosesAt: string | null; submissionOpen: boolean; locked: boolean; pitchMinutes: number;
  pitch: PitchItem[]; unordered: PitchItem[]; audienceVoting: boolean; audienceWeight: number; votingOpen: boolean; isJury: boolean;
  myVote: string | null; ownIdeas: string[]; ranking: { juryWeight: number; audienceWeight: number; rows: RankRow[] } | null;
}

interface HackathonSettings {
  hackathon: boolean; submissionOpensAt: string | null; submissionClosesAt: string | null; pitchMinutes: number; pitchOrder: string[];
  audienceVoting: boolean; audienceWeight: number;
}

interface UseCases {
  sourceIdea: { id: string; number: number; title: string } | null;
  target: Target | null;
  targetSettings: { kind: string | null; value: number | null; from: string | null; until: string | null };
  confirmer: UserRef | null;
  impact: { kinds: KindRow[]; kgCo2PerKwh: number; eurPerKwh: number; co2FromKwh: { estimated: number; confirmed: number } | null; eurFromKwh: { estimated: number; confirmed: number } | null };
  confirmations: Confirmation[] | null;
  hackathon: Hackathon | null;
  hackathonSettings: HackathonSettings | null;
  can: { manage: boolean; confirm: boolean };
}

const unit = (kind: string) => BENEFIT[kind] ?? kind;

/** ISO time ↔ value of an <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function ChallengeUseCases({ challengeId, canExport }: { challengeId: string; canExport: boolean }) {
  const { data, error, loading, reload } = useLoad<UseCases>(`/api/challenges/${challengeId}/use-cases`);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const hasImpact = data.impact.kinds.length > 0 || !!data.target;
  return (
    <>
      {data.sourceIdea && (
        <p className="alert info">
          {t('usecases.fromProblem')} <Link to={`/ideen/${data.sourceIdea.id}`}>#{data.sourceIdea.number} {data.sourceIdea.title}</Link>
        </p>
      )}
      {data.hackathon && <HackathonSection challengeId={challengeId} h={data.hackathon} onDone={() => void reload()} />}
      {(hasImpact || data.can.manage) && <ImpactSection challengeId={challengeId} data={data} canExport={canExport || data.can.manage || data.can.confirm} />}
      {data.confirmations && data.confirmations.length > 0 && (
        <ConfirmationTable items={data.confirmations} canConfirm={data.can.confirm} onDone={() => void reload()} />
      )}
      {data.can.manage && <ManageUseCases challengeId={challengeId} data={data} onDone={() => void reload()} />}
    </>
  );
}

// ---------------------------------------------------------------- impact and target (R3-32, R3-33)

function Progress({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div className="field">
      <div className="row spread small"><span>{label}</span><span>{value} · {percent} %</span></div>
      <progress max={100} value={Math.min(100, percent)} aria-label={`${label}: ${percent} %`} style={{ width: '100%' }} />
    </div>
  );
}

function ImpactSection({ challengeId, data, canExport }: { challengeId: string; data: UseCases; canExport: boolean }) {
  const { impact, target } = data;
  return (
    <section className="card" aria-labelledby="h-impact">
      <div className="row spread">
        <h2 id="h-impact">{t('usecases.impact.title')}</h2>
        {canExport && <a className="button" href={`/api/challenges/${challengeId}/esg.csv`}>{t('usecases.impact.esgExport')}</a>}
      </div>
      {target && (
        <div className="stack">
          <p className="small">
            {t('usecases.target.line', { value: formatNumber(target.value), unit: unit(target.kind) })}
            {(target.from || target.until) && ` · ${t('usecases.target.period', { from: formatDate(target.from), to: formatDate(target.until) })}`}
            {data.confirmer && ` · ${t('usecases.target.confirmer', { name: data.confirmer.displayName })}`}
          </p>
          <Progress label={t('usecases.target.confirmed')} value={`${formatNumber(target.confirmed)} ${unit(target.kind)}`} percent={target.confirmedPercent} />
          <Progress label={t('usecases.target.estimated')} value={`${formatNumber(target.estimated)} ${unit(target.kind)}`} percent={target.estimatedPercent} />
          {target.includesConvertedKwh && <p className="small muted">{t('usecases.target.includesKwh')}</p>}
        </div>
      )}
      {impact.kinds.length === 0 ? <p className="muted">{t('usecases.impact.none')}</p> : (
        <div className="table-wrap" tabIndex={0}><table>
          <caption className="sr-only">{t('usecases.impact.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('usecases.impact.kind')}</th>
              <th scope="col">{t('usecases.impact.ideas')}</th>
              <th scope="col">{t('usecases.impact.estimated')}</th>
              <th scope="col">{t('usecases.impact.confirmed')}</th>
            </tr>
          </thead>
          <tbody>
            {impact.kinds.map((k) => (
              <tr key={k.kind}>
                <th scope="row">{unit(k.kind)}</th>
                <td>{k.ideas}</td>
                <td>{formatNumber(k.estimated)}</td>
                <td>{formatNumber(k.confirmed)} <span className="small muted">({t('usecases.impact.confirmedIdeas', { n: k.confirmedIdeas })})</span></td>
              </tr>
            ))}
            {impact.co2FromKwh && (
              <tr>
                <th scope="row">{t('usecases.impact.co2FromKwh')}</th>
                <td>–</td>
                <td>{formatNumber(impact.co2FromKwh.estimated)}</td>
                <td>{formatNumber(impact.co2FromKwh.confirmed)}</td>
              </tr>
            )}
            {impact.eurFromKwh && (
              <tr>
                <th scope="row">{t('usecases.impact.eurFromKwh')}</th>
                <td>–</td>
                <td>{formatNumber(impact.eurFromKwh.estimated)}</td>
                <td>{formatNumber(impact.eurFromKwh.confirmed)}</td>
              </tr>
            )}
          </tbody>
        </table></div>
      )}
      {impact.co2FromKwh && <p className="small muted">{t('usecases.impact.factors', { co2: formatNumber(impact.kgCo2PerKwh), eur: formatNumber(impact.eurPerKwh) })}</p>}
    </section>
  );
}

/** Confirm the reported value or correct it, always with a comment (R3-33). */
export function ConfirmForm({ item, onDone }: { item: Confirmation; onDone: () => void }) {
  const [outcome, setOutcome] = useState<'confirmed' | 'corrected'>(item.reported == null ? 'corrected' : 'confirmed');
  const [value, setValue] = useState(item.confirmedValue ?? item.reported ?? 0);
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();
  const prefix = `confirm-${item.number}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { outcome, comment, ...(outcome === 'corrected' ? { value } : {}) };
    if (await run(() => api.post(`/api/ideas/${item.ideaId}/benefit-confirmation`, body))) onDone();
  };
  return (
    <form onSubmit={submit}>
      <ErrorBox error={error} />
      <fieldset>
        <legend>{t('usecases.confirm.legend', { value: item.reported == null ? '–' : formatNumber(item.reported), unit: unit(item.benefitKind) })}</legend>
        <label className="check"><input type="radio" name={`${prefix}-outcome`} checked={outcome === 'confirmed'} disabled={item.reported == null} onChange={() => setOutcome('confirmed')} /> {t('usecases.confirm.confirm')}</label>
        <label className="check"><input type="radio" name={`${prefix}-outcome`} checked={outcome === 'corrected'} onChange={() => setOutcome('corrected')} /> {t('usecases.confirm.correct')}</label>
      </fieldset>
      {outcome === 'corrected' && (
        <Field id={`${prefix}-value`} label={t('usecases.confirm.value', { unit: unit(item.benefitKind) })}>
          <input id={`${prefix}-value`} type="number" min={0} step="any" value={value} onChange={(e) => setValue(Number(e.target.value))} required />
        </Field>
      )}
      <Field id={`${prefix}-comment`} label={t('usecases.confirm.comment')} hint={t('usecases.confirm.commentHint')}>
        <textarea id={`${prefix}-comment`} value={comment} onChange={(e) => setComment(e.target.value)} minLength={5} maxLength={3000} required aria-describedby={`${prefix}-comment-hint`} />
      </Field>
      <button className="primary" disabled={busy || comment.trim().length < 5}>{t('usecases.confirm.save')}</button>
    </form>
  );
}

export function ConfirmationTable({ items, canConfirm, onDone, showChallenge = false }: { items: Confirmation[]; canConfirm: boolean; onDone: () => void; showChallenge?: boolean }) {
  return (
    <section className="card" aria-labelledby="h-confirm">
      <h2 id="h-confirm">{t('usecases.confirm.title')}</h2>
      <p className="small muted">{t('usecases.confirm.intro')}</p>
      <ul className="idea-list">
        {items.map((x) => (
          <li key={x.ideaId}>
            <div className="row spread">
              <Link className="title" to={`/ideen/${x.ideaId}`}>#{x.number} {x.title ?? t('usecases.confidentialIdea')}</Link>
              <span className={`badge ${x.outcome ? 'green' : ''}`}>{x.outcome ? t(`usecases.outcome.${x.outcome}` as MessageKey) : t('usecases.outcome.open')}</span>
            </div>
            <p className="small">
              {showChallenge && x.challengeTitle && <>{x.challengeTitle} · </>}
              {t('usecases.confirm.reported', { value: x.reported == null ? '–' : formatNumber(x.reported), unit: unit(x.benefitKind) })}
              {x.confirmedValue != null && ` · ${t('usecases.confirm.confirmedValue', { value: formatNumber(x.confirmedValue), unit: unit(x.benefitKind) })}`}
              {x.confirmedAt && ` · ${t('usecases.confirm.by', { name: x.confirmedBy ?? '–', date: formatDateTime(x.confirmedAt) })}`}
            </p>
            {x.evidence && <p className="small muted pre">{t('usecases.confirm.evidence', { text: x.evidence })}</p>}
            {x.comment && <p className="small pre">{t('usecases.confirm.commentShown', { text: x.comment })}</p>}
            {canConfirm && !x.own && (
              <details className="jury-item">
                <summary>{x.outcome ? t('usecases.confirm.change') : t('usecases.confirm.open')}</summary>
                <ConfirmForm item={x} onDone={onDone} />
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Page for controlling (R3-33): every actual benefit to confirm, open ones first. */
export function BenefitConfirmations() {
  const { data, error, loading, reload } = useLoad<{ items: Confirmation[] }>('/api/benefit-confirmations');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const open = data.items.filter((x) => !x.outcome).length;
  return (
    <div className="stack">
      <h1>{t('usecases.confirmPage.title')}</h1>
      <p>{t('usecases.confirmPage.intro', { n: open })}</p>
      {data.items.length === 0 ? <p className="muted">{t('usecases.confirmPage.empty')}</p>
        : <ConfirmationTable items={data.items} canConfirm onDone={() => void reload()} showChallenge />}
    </div>
  );
}

// ---------------------------------------------------------------- hackathon (R3-34)

function HackathonSection({ challengeId, h, onDone }: { challengeId: string; h: Hackathon; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [message, setMessage] = useState<string | null>(null);
  const voteFor = async (ideaId: string | null) => {
    setMessage(null);
    const ok = ideaId ? await run(() => api.put(`/api/challenges/${challengeId}/vote`, { ideaId })) : await run(() => api.del(`/api/challenges/${challengeId}/vote`));
    if (ok) {
      setMessage(ideaId ? t('usecases.vote.saved') : t('usecases.vote.withdrawn'));
      onDone();
    }
  };
  const voteable = [...h.pitch, ...h.unordered];
  return (
    <section className="card" aria-labelledby="h-hackathon">
      <div className="row spread">
        <h2 id="h-hackathon">{t('usecases.hackathon.title')}</h2>
        <Link to={`/challenges/${challengeId}/teams`}>{t('usecases.hackathon.teams')}</Link>
      </div>
      <p className="small">
        {h.submissionOpensAt || h.submissionClosesAt
          ? t('usecases.hackathon.window', { from: h.submissionOpensAt ? formatDateTime(h.submissionOpensAt) : '–', to: h.submissionClosesAt ? formatDateTime(h.submissionClosesAt) : '–' })
          : t('usecases.hackathon.noWindow')}
        {' · '}
        <span className={`badge ${h.submissionOpen ? 'green' : ''}`}>{h.submissionOpen ? t('usecases.hackathon.open') : h.locked ? t('usecases.hackathon.locked') : t('usecases.hackathon.notYet')}</span>
      </p>
      <h3>{t('usecases.pitch.title')}</h3>
      {h.pitch.length === 0 ? <p className="muted small">{t('usecases.pitch.none')}</p> : (
        <ol>
          {h.pitch.map((p) => (
            <li key={p.id}>
              <Link to={`/ideen/${p.id}`}>#{p.number} {p.title}</Link>
              {p.teamName && <span className="small muted"> · {p.teamName}</span>}
              <span className="small muted"> · {t('usecases.pitch.slot', { from: p.startsAfterMinutes ?? 0, minutes: h.pitchMinutes })}</span>
            </li>
          ))}
        </ol>
      )}
      {h.audienceVoting && (
        <>
          <h3>{t('usecases.vote.title')}</h3>
          <p className="small muted">{t('usecases.vote.intro', { weight: h.audienceWeight })}</p>
          <ErrorBox error={error} />
          {message && <p className="alert success" role="status">{message}</p>}
          {!h.votingOpen ? <p className="small">{h.locked ? t('usecases.vote.closed') : t('usecases.vote.notYet')}</p>
            : h.isJury ? <p className="small">{t('usecases.vote.jury')}</p>
            : (
              <fieldset>
                <legend>{t('usecases.vote.legend')}</legend>
                {voteable.map((p) => (
                  <label key={p.id} className="check">
                    <input type="radio" name="audience-vote" checked={h.myVote === p.id} disabled={busy || h.ownIdeas.includes(p.id)} onChange={() => voteFor(p.id)} />
                    {' '}#{p.number} {p.teamName ?? p.title}{h.ownIdeas.includes(p.id) ? ` (${t('usecases.vote.ownTeam')})` : ''}
                  </label>
                ))}
                {h.myVote && <button type="button" className="link" disabled={busy} onClick={() => voteFor(null)}>{t('usecases.vote.withdraw')}</button>}
              </fieldset>
            )}
        </>
      )}
      {h.ranking && <CombinedRanking ranking={h.ranking} audience={h.audienceVoting} />}
    </section>
  );
}

function CombinedRanking({ ranking, audience }: { ranking: NonNullable<Hackathon['ranking']>; audience: boolean }) {
  return (
    <>
      <h3>{t('usecases.ranking.title')}</h3>
      <p className="small muted">{audience ? t('usecases.ranking.intro', { jury: ranking.juryWeight, audience: ranking.audienceWeight }) : t('usecases.ranking.juryOnly')}</p>
      <div className="table-wrap" tabIndex={0}><table>
        <thead>
          <tr>
            <th scope="col">{t('usecases.ranking.rank')}</th>
            <th scope="col">{t('usecases.ranking.team')}</th>
            <th scope="col">{t('usecases.ranking.jury')}</th>
            {audience && <th scope="col">{t('usecases.ranking.votes')}</th>}
            <th scope="col">{t('usecases.ranking.score')}</th>
          </tr>
        </thead>
        <tbody>
          {ranking.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.rank ?? '–'}</td>
              <td><Link to={`/ideen/${r.id}`}>#{r.number} {r.title}</Link>{r.teamName && <span className="small muted"> · {r.teamName}</span>}</td>
              <td>{r.juryScore != null ? `${formatNumber(r.juryScore)} (${r.juryRatings})` : '–'}</td>
              {audience && <td>{r.votes ?? 0}</td>}
              <td>{r.score != null ? formatNumber(r.score) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="small muted">{t('usecases.ranking.note')}</p>
    </>
  );
}

/** Team page (R3-34): teams with their members; anonymous teams without names. */
export function ChallengeTeams() {
  const { id } = useParams();
  const { data, error, loading } = useLoad<{ challenge: { id: string; title: string }; locked: boolean; teams: { id: string; number: number; title: string; teamName: string | null; members: { name: string; author: boolean }[] | null; size: number }[] }>(`/api/challenges/${id}/teams`);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <p className="small"><Link to={`/challenges/${data.challenge.id}`}>{t('usecases.teams.back', { title: data.challenge.title })}</Link></p>
      <h1>{t('usecases.teams.title')}</h1>
      {data.locked && <p className="alert info">{t('usecases.teams.locked')}</p>}
      {data.teams.length === 0 ? <p className="muted">{t('usecases.teams.empty')}</p> : (
        <div className="grid grid-2">
          {data.teams.map((x) => (
            <section key={x.id} className="card" aria-labelledby={`team-${x.number}`}>
              <h2 id={`team-${x.number}`}>{x.teamName ?? t('usecases.teams.noName')}</h2>
              <p><Link to={`/ideen/${x.id}`}>#{x.number} {x.title}</Link></p>
              {x.members ? (
                <ul>
                  {x.members.map((p, i) => <li key={i}>{p.name}{p.author ? ` (${t('usecases.teams.author')})` : ''}</li>)}
                </ul>
              ) : <p className="small muted">{t('usecases.teams.anonymous', { n: x.size })}</p>}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings for sponsor and triage

const TARGET_LABELS = () => labelMap('labels.benefit', TARGET_KINDS);

function ManageUseCases({ challengeId, data, onDone }: { challengeId: string; data: UseCases; onDone: () => void }) {
  const s = data.targetSettings;
  const hs = data.hackathonSettings!;
  const [target, setTarget] = useState({ kind: s.kind ?? '', value: s.value ?? '', from: s.from ?? '', until: s.until ?? '' });
  const [confirmer, setConfirmer] = useState<UserRef | null>(data.confirmer);
  const [hack, setHack] = useState({ ...hs, opens: toLocalInput(hs.submissionOpensAt), closes: toLocalInput(hs.submissionClosesAt) });
  const [order, setOrder] = useState<PitchItem[]>(() => [...(data.hackathon?.pitch ?? []), ...(data.hackathon?.unordered ?? [])]);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const save = async (body: Record<string, unknown>, msg: string) => {
    setSaved(null);
    if (await run(() => api.patch(`/api/challenges/${challengeId}/use-cases`, body))) {
      setSaved(msg);
      onDone();
    }
  };
  const saveTarget = (e: FormEvent) => {
    e.preventDefault();
    void save({
      targetKind: target.kind || null, targetValue: target.kind && target.value !== '' ? Number(target.value) : null,
      targetFrom: target.from || null, targetUntil: target.until || null, confirmerId: confirmer?.id ?? null,
    }, t('usecases.manage.targetSaved'));
  };
  const saveHackathon = (e: FormEvent) => {
    e.preventDefault();
    void save({
      hackathon: hack.hackathon, submissionOpensAt: fromLocalInput(hack.opens), submissionClosesAt: fromLocalInput(hack.closes),
      pitchMinutes: hack.pitchMinutes, audienceVoting: hack.audienceVoting, audienceWeight: hack.audienceWeight, pitchOrder: order.map((p) => p.id),
    }, t('usecases.manage.hackathonSaved'));
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  const shuffle = () => {
    const next = [...order];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    setOrder(next);
  };
  const kinds = TARGET_LABELS();
  return (
    <section className="card" aria-labelledby="h-usecases-manage">
      <h2 id="h-usecases-manage">{t('usecases.manage.title')}</h2>
      <ErrorBox error={error} />
      {saved && <p className="alert success" role="status">{saved}</p>}
      <form onSubmit={saveTarget}>
        <h3>{t('usecases.manage.targetTitle')}</h3>
        <p className="small muted">{t('usecases.manage.targetHint')}</p>
        <div className="grid grid-3">
          <Field id="uc-kind" label={t('usecases.manage.kind')}>
            <select id="uc-kind" value={target.kind} onChange={(e) => setTarget({ ...target, kind: e.target.value })}>
              <option value="">{t('usecases.manage.noTarget')}</option>
              {Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field id="uc-value" label={t('usecases.manage.value')}>
            <input id="uc-value" type="number" min={0} step="any" value={target.value} disabled={!target.kind} onChange={(e) => setTarget({ ...target, value: e.target.value })} required={!!target.kind} />
          </Field>
          <div />
          <Field id="uc-from" label={t('usecases.manage.from')}>
            <input id="uc-from" type="date" value={target.from} onChange={(e) => setTarget({ ...target, from: e.target.value })} />
          </Field>
          <Field id="uc-until" label={t('usecases.manage.until')}>
            <input id="uc-until" type="date" value={target.until} onChange={(e) => setTarget({ ...target, until: e.target.value })} />
          </Field>
        </div>
        <Field id="uc-confirmer" label={t('usecases.manage.confirmer')} hint={t('usecases.manage.confirmerHint')}>
          <UserPicker id="uc-confirmer" value={confirmer} onChange={setConfirmer} />
        </Field>
        <button className="primary" disabled={busy}>{t('usecases.manage.save')}</button>
      </form>
      <form onSubmit={saveHackathon} style={{ marginTop: 20 }}>
        <h3>{t('usecases.manage.hackathonTitle')}</h3>
        <label className="check">
          <input type="checkbox" checked={hack.hackathon} onChange={(e) => setHack({ ...hack, hackathon: e.target.checked })} /> {t('usecases.manage.hackathon')}
        </label>
        {hack.hackathon && (
          <>
            <div className="grid grid-3">
              <Field id="uc-opens" label={t('usecases.manage.opens')}>
                <input id="uc-opens" type="datetime-local" value={hack.opens} onChange={(e) => setHack({ ...hack, opens: e.target.value })} />
              </Field>
              <Field id="uc-closes" label={t('usecases.manage.closes')}>
                <input id="uc-closes" type="datetime-local" value={hack.closes} onChange={(e) => setHack({ ...hack, closes: e.target.value })} />
              </Field>
              <Field id="uc-minutes" label={t('usecases.manage.pitchMinutes')}>
                <input id="uc-minutes" type="number" min={1} max={60} value={hack.pitchMinutes} onChange={(e) => setHack({ ...hack, pitchMinutes: Number(e.target.value) })} />
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" checked={hack.audienceVoting} onChange={(e) => setHack({ ...hack, audienceVoting: e.target.checked })} /> {t('usecases.manage.audienceVoting')}
            </label>
            {hack.audienceVoting && (
              <Field id="uc-weight" label={t('usecases.manage.audienceWeight')} hint={t('usecases.manage.audienceWeightHint', { jury: 100 - hack.audienceWeight })}>
                <input id="uc-weight" type="number" min={0} max={100} value={hack.audienceWeight} aria-describedby="uc-weight-hint" onChange={(e) => setHack({ ...hack, audienceWeight: Number(e.target.value) })} />
              </Field>
            )}
            <fieldset>
              <legend>{t('usecases.pitch.order')}</legend>
              {order.length === 0 ? <p className="small muted">{t('usecases.pitch.noIdeas')}</p> : (
                <ol>
                  {order.map((p, i) => (
                    <li key={p.id} className="row">
                      <span>#{p.number} {p.teamName ?? p.title}</span>
                      <button type="button" className="link" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('usecases.pitch.up', { name: p.teamName ?? p.title })}>↑</button>
                      <button type="button" className="link" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={t('usecases.pitch.down', { name: p.teamName ?? p.title })}>↓</button>
                    </li>
                  ))}
                </ol>
              )}
              {order.length > 1 && <button type="button" onClick={shuffle}>{t('usecases.pitch.shuffle')}</button>}
            </fieldset>
          </>
        )}
        <button className="primary" disabled={busy}>{t('usecases.manage.save')}</button>
      </form>
    </section>
  );
}
