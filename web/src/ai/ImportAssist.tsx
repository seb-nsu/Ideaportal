import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Field, readBase64, useAction } from '../components';
import { labelMap, t } from '../i18n';

// Import of old ideas with AI support (R4-12): the AI cleans the texts and proposes topic
// fields, the duplicate check marks rows that are already in the portal or in the file, and a
// person decides per row what is imported and whether the AI suggestion is taken over.

const FIELDS = ['title', 'problem', 'solution', 'benefit', 'topic', 'email', 'confidential'] as const;
type ImportField = (typeof FIELDS)[number];
type CleanField = 'title' | 'problem' | 'solution' | 'benefit' | 'topic';
const CHANGES = ['encoding', 'html', 'greeting', 'whitespace', 'caps', 'title_shortened', 'title_from_text', 'topic_mapped', 'topic_suggested'] as const;

interface Texts { title: string; problem: string; solution: string; benefit: string }
interface PreviewRow {
  row: number;
  original: Texts & { topic: string };
  suggestion: (Texts & { topic: string | null; changes: (typeof CHANGES)[number][]; fields: CleanField[] }) | null;
  confidential: boolean;
  email: string;
  authorKnown: boolean;
  duplicate: { kind: 'portal' } | { kind: 'file'; row: number } | null;
  similar: { id: string; number: number; title: string; score: number }[];
  include: boolean;
  skipReason: 'title' | 'duplicate' | 'similar' | null;
}
interface Preview {
  filename: string;
  headers: string[];
  mapping: Partial<Record<ImportField, number>>;
  rows: PreviewRow[];
  ai: { used: boolean; batches: number; errors: string[]; actionIds: string[] };
  report: { total: number; included: number; duplicates: number; similar: number; confidential: number; suggestions: number; unknownAuthors: number };
}
interface Committed { imported: number; duplicates: number[]; aiMarked: number }
interface Choice { include: boolean; useAi: boolean }

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function ImportAssist() {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>> | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [done, setDone] = useState<Committed | null>(null);
  const { busy, error, run } = useAction();
  const FIELD = labelMap('importAssist.field', FIELDS);
  const CHANGE = labelMap('importAssist.change', CHANGES);
  // Without a recognizable title column the server answers with the headers so they can be mapped by hand.
  const unmapped = error?.details as { headers?: string[]; mapping?: Preview['mapping'] } | undefined;
  useEffect(() => {
    if (unmapped?.headers && !mapping) setMapping(unmapped.mapping ?? {});
  }, [unmapped, mapping]);
  const headers = preview?.headers ?? unmapped?.headers ?? [];

  const load = async (f: { name: string; data: string }, map?: Partial<Record<ImportField, number>>) => {
    const r = await run(() => api.post<Preview>('/api/admin/import/ai/preview', { filename: f.name, data: f.data, ...(map ? { mapping: map } : {}) }));
    if (r) {
      setPreview(r);
      setMapping(r.mapping);
      setChoices(Object.fromEntries(r.rows.map((x) => [x.row, { include: x.include, useAi: !!x.suggestion?.fields.length }])));
    }
  };
  const choose = async (f: File | undefined) => {
    setPreview(null);
    setMapping(null);
    setDone(null);
    if (!f) return setFile(null);
    const data = { name: f.name, data: await readBase64(f) };
    setFile(data);
    await load(data);
  };
  const set = (row: number, patch: Partial<Choice>) => setChoices({ ...choices, [row]: { ...choices[row], ...patch } });

  const chosen = preview?.rows.filter((r) => choices[r.row]?.include && r.skipReason !== 'title') ?? [];
  const commit = async () => {
    if (!preview) return;
    const rows = chosen.map((r) => {
      const ai = choices[r.row].useAi && r.suggestion ? r.suggestion : null;
      const v = ai ?? { ...r.original, topic: r.original.topic || null };
      return {
        row: r.row, title: v.title, problem: v.problem, solution: v.solution, benefit: v.benefit, topic: v.topic || null,
        email: r.email, confidential: r.confidential, aiFields: ai ? ai.fields : [],
      };
    });
    const res = await run(() => api.post<Committed>('/api/admin/import/ai/commit', { filename: preview.filename, rows, actionIds: preview.ai.actionIds }));
    if (res) {
      setDone(res);
      setPreview(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-import-ai">
      <h2 id="h-import-ai">{t('importAssist.title')}</h2>
      <p>{t('importAssist.intro')}</p>
      <ErrorBox error={error} />
      {done && (
        <div className="alert success" role="status">
          {t('importAssist.done', { n: done.imported, ai: done.aiMarked })}
          {done.duplicates.length > 0 && ` ${t('importAssist.doneDuplicates', { rows: done.duplicates.join(', ') })}`}
        </div>
      )}
      <Field id="import-ai-file" label={t('importAssist.file')} hint={t('importAssist.fileHint')}>
        <input id="import-ai-file" type="file" accept=".csv,.txt,.xlsx" onChange={(e) => choose(e.target.files?.[0])} disabled={busy} aria-describedby="import-ai-file-hint" />
      </Field>
      {busy && <p className="muted" aria-live="polite">{t('importAssist.working')}</p>}

      {file && mapping && headers.length > 0 && (
        <fieldset>
          <legend>{t('importAssist.mapColumns')}</legend>
          <div className="grid grid-3">
            {FIELDS.map((f) => (
              <Field key={f} id={`ai-map-${f}`} label={FIELD[f]}>
                <select id={`ai-map-${f}`} value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                  <option value="">{t('importAssist.skipColumn')}</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || t('importAssist.column', { n: i + 1 })}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <button type="button" onClick={() => void load(file, mapping)} disabled={busy}>{t('importAssist.refresh')}</button>
        </fieldset>
      )}

      {preview && (
        <>
          <p>
            {t('importAssist.summary', { total: preview.report.total, included: preview.report.included, suggestions: preview.report.suggestions, duplicates: preview.report.duplicates, confidential: preview.report.confidential })}
            {preview.report.unknownAuthors > 0 && ` ${t('importAssist.unknownAuthors', { n: preview.report.unknownAuthors })}`}
          </p>
          {preview.ai.errors.length > 0 && (
            <div className="alert warn" role="status">
              {t('importAssist.aiErrors')}
              <ul>{preview.ai.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <p className="small muted">{t('importAssist.aiHint')}</p>
          <ul className="idea-list">
            {preview.rows.map((r) => {
              const c = choices[r.row] ?? { include: false, useAi: false };
              const s = r.suggestion;
              const shown = c.useAi && s ? s : { ...r.original, topic: r.original.topic || null };
              return (
                <li key={r.row} className="stack" style={{ gap: 4 }}>
                  <div className="row spread">
                    <label className="check">
                      <input type="checkbox" checked={c.include && r.skipReason !== 'title'} disabled={r.skipReason === 'title'} onChange={(e) => set(r.row, { include: e.target.checked })} />
                      {' '}<strong>{t('importAssist.row', { n: r.row })}</strong> {shown.title || t('importAssist.noTitle')}
                    </label>
                    <span className="row">
                      {r.confidential && <span className="badge yellow">{t('importAssist.confidential')}</span>}
                      {r.duplicate?.kind === 'portal' && <span className="badge red">{t('importAssist.duplicatePortal')}</span>}
                      {r.duplicate?.kind === 'file' && <span className="badge red">{t('importAssist.duplicateFile', { row: r.duplicate.row })}</span>}
                      {r.skipReason === 'title' && <span className="badge">{t('importAssist.skipTitle')}</span>}
                      {!r.authorKnown && <span className="badge">{t('importAssist.authorUnknown')}</span>}
                    </span>
                  </div>
                  <span className="small">{short(shown.problem || shown.solution)}</span>
                  <span className="small">{t('importAssist.topic')} {shown.topic || '–'}</span>
                  {s && s.fields.length > 0 && (
                    <div className="stack" style={{ gap: 2 }}>
                      <label className="check small">
                        <input type="checkbox" checked={c.useAi} onChange={(e) => set(r.row, { useAi: e.target.checked })} />
                        {' '}<span className="badge accent">{t('importAssist.aiBadge')}</span> {t('importAssist.useAi', { fields: s.fields.map((f) => FIELD[f]).join(', ') })}
                      </label>
                      {s.changes.length > 0 && <span className="small muted">{t('importAssist.changes', { list: s.changes.map((x) => CHANGE[x]).join(', ') })}</span>}
                      {c.useAi && s.fields.includes('title') && <span className="small muted">{t('importAssist.originalTitle', { title: r.original.title || '–' })}</span>}
                    </div>
                  )}
                  {r.similar.length > 0 && (
                    <span className="small">
                      {t('importAssist.similar')}{' '}
                      {r.similar.map((x, i) => (
                        <span key={x.id}>{i > 0 && ', '}<Link to={`/ideen/${x.id}`}>#{x.number} {x.title}</Link> ({Math.round(x.score * 100)} %)</span>
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div>
            <button type="button" className="primary" onClick={commit} disabled={busy || chosen.length === 0}>
              {t('importAssist.run', { n: chosen.length })}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
