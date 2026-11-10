import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Field, readBase64, useAction, useLoad } from '../components';
import { AiLabel, CLAIM_CLASS, CLAIM_LABEL, CONF, KIND_LABEL, REVIEW, REVIEW_CLASS, type AiResult, type ReviewStatus } from './AiPanel';
import { formatDate, formatNumber, labelMap, t, tn } from '../i18n';

// AI help outside the idea page: Gate 2 brief per meeting (R2-33, R2-34), challenge
// suggestions from strategy documents (R2-36) and success story drafts (R2-37).

interface BriefItem {
  ideaId: string;
  number: number;
  title: string;
  brief: AiResult | null;
  counterarguments: AiResult | null;
  sources: { title: string; url: string }[];
  words: number;
  readingMinutes: number;
  figures: Figure[];
  /** Review status per building block (R2-44). */
  reviews?: { kind: string; label: string; status: ReviewStatus; by: string | null; at: string | null }[];
  reviewRequired?: boolean;
}

/** Review status of every AI building block of the idea, with person and date (R2-44). */
function Reviews({ items, required }: { items: NonNullable<BriefItem['reviews']>; required?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="small">
      <h4>{t('aiQuality.brief.reviews')}</h4>
      {required && items.some((r) => r.status === 'unchecked') && <p className="alert info">{t('aiQuality.review.required')}</p>}
      <ul className="ai-claims">
        {items.map((r) => (
          <li key={r.kind}>
            {KIND_LABEL[r.kind] ?? r.label}: <span className={`badge ${REVIEW_CLASS[r.status]}`}>{REVIEW[r.status]}</span>
            {r.by && r.at && <span className="muted"> {t('aiQuality.review.by', { name: r.by, date: formatDate(r.at) })}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Figure {
  label: string;
  value: number;
  unit: string;
  basis: 'source' | 'calculation' | 'estimate' | 'rating';
  confidence: 'low' | 'medium' | 'high' | null;
  note: string;
  sources: { title: string; url: string }[];
  href: string;
}

const BASIS = labelMap('aiExtras.basis', ['source', 'calculation', 'estimate', 'rating'] as const);
const num = (v: number) => formatNumber(v, 2);

/** Key figures with their basis: source, calculation, estimate or rating (R2-43). */
function Figures({ items }: { items: Figure[] }) {
  if (!items.length) return null;
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <caption>{t('aiExtras.figures.caption')}</caption>
        <thead><tr><th scope="col">{t('aiExtras.figures.figure')}</th><th scope="col">{t('aiExtras.figures.value')}</th><th scope="col">{t('aiExtras.figures.basis')}</th></tr></thead>
        <tbody>
          {items.map((f) => (
            <tr key={`${f.label}-${f.unit}`}>
              <th scope="row">{f.label}</th>
              <td>{num(f.value)} {f.unit}</td>
              <td>
                <span className="badge">{BASIS[f.basis]}</span> {f.confidence && <span className="small muted">{CONF[f.confidence]} · </span>}
                <Link to={f.href}>{f.note}</Link>
                {f.sources.map((s, i) => <span key={s.url}> <a className="small" href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>[{i + 1}]</a></span>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The brief's statements: every one labelled, facts with a link to their source. */
function BriefSections({ brief }: { brief: AiResult }) {
  return (
    <>
      {brief.sections.map((s) => (
        <div key={s.heading}>
          <h4>{s.heading}</h4>
          <ul className="ai-claims">
            {s.claims.map((c) => (
              <li key={c.id} className="ai-claim">
                <span className={`badge ${CLAIM_CLASS[c.kind]}`}>{CLAIM_LABEL[c.kind]}</span> {c.correction?.action === 'correct' ? c.correction.text : c.text}
                {c.kind === 'estimate' && c.confidence && <span className="muted small"> · {CONF[c.confidence]}</span>}
                {c.sources.map((id) => {
                  const src = brief.sources.find((x) => x.id === id);
                  return src ? <a key={id} className="small ai-ref" href={src.url} target="_blank" rel="noreferrer noopener" title={src.title}>[{id}]</a> : null;
                })}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** Measures how long each brief is on screen and reports it without the reader (R2-43). */
function useReadingTime(meetingId: string) {
  const seen = useRef(new Map<string, number>());
  const since = useRef(new Map<string, number>());
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const stop = (id: string) => {
      const start = since.current.get(id);
      if (start != null) seen.current.set(id, (seen.current.get(id) ?? 0) + (Date.now() - start));
      since.current.delete(id);
    };
    observer.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.idea!;
        if (e.isIntersecting && document.visibilityState === 'visible') since.current.set(id, Date.now());
        else stop(id);
      }
    }, { threshold: 0.4 });
    document.querySelectorAll<HTMLElement>('article[data-idea]').forEach((el) => observer.current!.observe(el));
    const flush = () => {
      for (const id of [...since.current.keys()]) stop(id);
      for (const [id, ms] of seen.current) {
        const seconds = Math.min(3600, Math.round(ms / 1000));
        if (seconds >= 5) void api.post(`/api/meetings/${meetingId}/ai/brief/read`, { ideaId: id, seconds }).catch(() => undefined);
      }
      seen.current.clear();
    };
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      observer.current?.disconnect();
      flush();
    };
  }, [meetingId]);
  return (el: HTMLElement | null) => { if (el && observer.current) observer.current.observe(el); };
}

function Points({ title, items }: { title: string; items: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </>
  );
}

/** One page per idea for the committee, plus counterarguments; the committee decides. */
export function MeetingBrief({ meetingId, canCreate }: { meetingId: string; canCreate: boolean }) {
  const { data, reload } = useLoad<BriefItem[]>(`/api/meetings/${meetingId}/ai/brief`);
  const [errors, setErrors] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  const track = useReadingTime(meetingId);
  if (!data || data.length === 0) return null;
  const any = data.some((d) => d.brief);
  const create = async () => {
    const res = await run(() => api.post<{ ok: boolean; errors: string[] }>(`/api/meetings/${meetingId}/ai/brief`));
    if (res) {
      setErrors(res.errors);
      void reload();
    }
  };
  return (
    <section className="card" aria-labelledby="h-brief">
      <div className="row spread">
        <h2 id="h-brief">{t('aiExtras.brief.title')} <span className="badge accent">{t('aiExtras.brief.badge')}</span></h2>
        {canCreate && (
          <button type="button" onClick={create} disabled={busy}>
            {busy ? t('aiExtras.brief.creating') : any ? t('aiExtras.brief.recreate') : t('aiExtras.brief.create')}
          </button>
        )}
      </div>
      <p className="small muted">{t('aiExtras.brief.intro')}</p>
      <ErrorBox error={error} />
      {errors.length > 0 && (
        <div className="alert warn" role="alert">
          {t('aiExtras.brief.partial')}
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {!any && !busy && <p className="muted">{t('aiExtras.brief.none')}</p>}
      {data.filter((d) => d.brief || d.counterarguments || d.reviews?.length).map((d) => {
        const b = d.brief?.data as { strengths?: string[]; risks?: string[]; openQuestions?: string[] } | undefined;
        const c = d.counterarguments?.data as { counterarguments?: { text: string }[]; premortem?: string; earlyWarnings?: string[] } | undefined;
        return (
          <article key={d.ideaId} className="ai-result" data-idea={d.ideaId} ref={track}>
            <h3><Link to={`/ideen/${d.ideaId}/steckbrief/analysen`}>#{d.number} {d.title}</Link></h3>
            {d.brief && <><AiLabel meta={d.brief.meta} /> <span className="small muted">{tn('aiExtras.brief.reading', d.readingMinutes, { words: d.words })}</span></>}
            {d.brief && <BriefSections brief={d.brief} />}
            <Figures items={d.figures} />
            <Reviews items={d.reviews ?? []} required={d.reviewRequired} />
            <div className="grid grid-3">
              <div><Points title={t('aiExtras.brief.strengths')} items={b?.strengths} /></div>
              <div><Points title={t('aiExtras.brief.risks')} items={b?.risks} /></div>
              <div><Points title={t('aiExtras.brief.openQuestions')} items={b?.openQuestions} /></div>
            </div>
            {c && (
              <details>
                <summary>{t('aiExtras.brief.counterSummary')}</summary>
                <Points title={t('aiExtras.brief.counterarguments')} items={c.counterarguments?.map((x) => x.text)} />
                {c.premortem && <><h4>{t('aiExtras.brief.premortem')}</h4><p>{c.premortem}</p></>}
                <Points title={t('aiExtras.brief.earlyWarnings')} items={c.earlyWarnings} />
              </details>
            )}
            {d.sources.length > 0 && (
              <details>
                <summary>{t('aiExtras.brief.sources', { n: d.sources.length })}</summary>
                <ul className="ai-sources">{d.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a></li>)}</ul>
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}

interface Suggestion { title: string; question: string; reasoning: string; topic: string | null }

/** Strategy text or file in, 3–5 challenge suggestions out; one click fills the form. */
export function ChallengeSuggestions({ onApply }: { onApply: (s: Suggestion) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  if (!open) {
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>{t('aiExtras.challenge.title')}</button>
      </p>
    );
  }
  const suggest = async () => {
    const body: { text?: string; file?: { name: string; data: string } } = {};
    if (text.trim()) body.text = text;
    if (file) body.file = { name: file.name, data: await readBase64(file) };
    const res = await run(() => api.post<{ suggestions: Suggestion[] }>('/api/ai/challenge-suggestions', body));
    if (res) setItems(res.suggestions);
  };
  return (
    <fieldset className="stack">
      <legend>{t('aiExtras.challenge.title')} <span className="badge accent">{t('aiExtras.challenge.badge')}</span></legend>
      <Field id="cs-text" label={t('aiExtras.challenge.textLabel')} hint={t('aiExtras.challenge.textHint')}>
        <textarea id="cs-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} aria-describedby="cs-text-hint" />
      </Field>
      <div className="row">
        <button type="button" onClick={() => fileRef.current?.click()}>{file ? t('aiExtras.challenge.file', { name: file.name }) : t('aiExtras.challenge.chooseFile')}</button>
        <input ref={fileRef} type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button type="button" className="primary" onClick={suggest} disabled={busy || (!text.trim() && !file)}>{busy ? t('aiExtras.challenge.evaluating') : t('aiExtras.challenge.suggest')}</button>
        <button type="button" onClick={() => setOpen(false)}>{t('aiExtras.challenge.close')}</button>
      </div>
      <ErrorBox error={error} />
      {items && (
        <ul className="idea-list" aria-live="polite">
          {items.map((s, i) => (
            <li key={i}>
              <strong>{s.title}</strong>
              <p style={{ margin: '4px 0' }}>{s.question}</p>
              <p className="small muted" style={{ margin: '4px 0' }}>{s.reasoning}{s.topic ? t('aiExtras.challenge.topic', { topic: s.topic }) : ''}</p>
              <button type="button" onClick={() => onApply(s)}>{t('aiExtras.challenge.apply')}</button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** Draft of the success story; the text lands in the editor and stays editable. */
export function SuccessStoryDraft({ ideaId, onDraft }: { ideaId: string; onDraft: (d: { title: string; body: string }) => void }) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  const draft = async () => {
    const res = await run(() => api.post<{ title: string; body: string; warnings: string[] }>(`/api/ideas/${ideaId}/ai/success-story`));
    if (res) {
      setWarnings(res.warnings ?? []);
      onDraft({ title: res.title, body: res.body });
    }
  };
  return (
    <div className="stack" style={{ marginBottom: 8 }}>
      <div className="row">
        <button type="button" onClick={draft} disabled={busy}>{busy ? t('aiExtras.story.writing') : t('aiExtras.story.draft')}</button>
      </div>
      <ErrorBox error={error} />
      {warnings.length > 0 && <div className="alert warn" role="status">{warnings.join(' ')}</div>}
    </div>
  );
}

