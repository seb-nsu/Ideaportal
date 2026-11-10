import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, useAction } from '../components';
import { getLocale, intlLocale, t } from '../i18n';

// Translation of an idea or a comment on demand (R3-30). The original stays visible; the
// translation appears below it, marked as AI translation. The server caches it per language.

interface Translation {
  target: string;
  sourceLanguage: string | null;
  fields: Record<string, string>;
  cached: boolean;
  local: boolean;
}

interface Languages {
  languages: string[];
  available: boolean;
  availableConfidential: boolean;
}

let languagesPromise: Promise<Languages> | null = null;
const loadLanguages = () => (languagesPromise ??= api.get<Languages>('/api/translate/languages').catch(() => {
  languagesPromise = null;
  return { languages: [getLocale()], available: false, availableConfidential: false };
}));

/** Name of a language in the reader's language, e.g. "Französisch". */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([intlLocale()], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const STORE = 'translateTarget';
function storedTarget(): string {
  try {
    return localStorage.getItem(STORE) ?? getLocale();
  } catch {
    return getLocale();
  }
}
function storeTarget(v: string) {
  try {
    localStorage.setItem(STORE, v);
  } catch {
    // not essential
  }
}

function useLanguages(): Languages | null {
  const [langs, setLangs] = useState<Languages | null>(null);
  useEffect(() => {
    let live = true;
    void loadLanguages().then((l) => live && setLangs(l));
    return () => {
      live = false;
    };
  }, []);
  return langs;
}

const FIELD_LABELS = (): Record<string, string> => ({
  title: t('insights.translate.fieldTitle'),
  problem: t('ideaDetail.problem'),
  solution: t('ideaDetail.idea'),
  benefit: t('ideaDetail.benefit'),
});

/** Button with target language for the idea texts (title, problem, solution, benefit). */
export function TranslateIdea({ ideaId }: { ideaId: string }) {
  const info = useLanguages();
  const langs = info?.languages ?? [];
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(storedTarget);
  const [result, setResult] = useState<Translation | null>(null);
  const { busy, error, run } = useAction();
  const translate = async () => {
    storeTarget(target);
    const r = await run(() => api.post<Translation>(`/api/ideas/${ideaId}/translate`, { target }));
    if (r) setResult(r);
  };
  const labels = FIELD_LABELS();
  // Only offered when a model can translate, and folded until someone needs it (usability review 10/2026).
  if (!info?.available) return null;
  if (!open && !result) {
    return <p className="small" style={{ marginTop: 12 }}><button type="button" className="link" onClick={() => setOpen(true)}>{t('insights.translate.open')}</button></p>;
  }
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="row">
        <label htmlFor={`tr-${ideaId}`} className="small">{t('insights.translate.target')}</label>
        <select id={`tr-${ideaId}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          {(langs.length ? langs : [target]).map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
        </select>
        <button type="button" onClick={translate} disabled={busy}>{busy ? t('insights.translate.busy') : t('insights.translate.button')}</button>
      </div>
      <ErrorBox error={error} />
      {result && (
        <section className="alert info" aria-label={t('insights.translate.label', { language: languageName(result.target) })} lang={result.target}>
          <p className="small" style={{ marginTop: 0 }}>
            <strong>{t('insights.translate.label', { language: languageName(result.target) })}</strong>
            {result.local && <> · {t('insights.translate.local')}</>} · {t('insights.translate.note')}
          </p>
          {Object.entries(result.fields).map(([k, v]) => (
            <div key={k}>
              <h3 className="small" style={{ marginBottom: 2 }}>{labels[k] ?? k}</h3>
              <p className="pre" style={{ marginTop: 0 }}>{v || '–'}</p>
            </div>
          ))}
          <button type="button" className="link small" onClick={() => setResult(null)}>{t('insights.translate.hide')}</button>
        </section>
      )}
    </div>
  );
}

/** Small link under a comment; uses the last chosen target language. */
export function TranslateComment({ ideaId, commentId }: { ideaId: string; commentId: string }) {
  const info = useLanguages();
  const [result, setResult] = useState<Translation | null>(null);
  const { busy, error, run } = useAction();
  const translate = async () => {
    const r = await run(() => api.post<Translation>(`/api/ideas/${ideaId}/translate`, { target: storedTarget(), commentId }));
    if (r) setResult(r);
  };
  if (result) {
    return (
      <div className="small" lang={result.target} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8, marginBottom: 6 }}>
        <strong>{t('insights.translate.label', { language: languageName(result.target) })}</strong>
        <p className="pre" style={{ margin: '2px 0' }}>{result.fields.body}</p>
        <button type="button" className="link small" onClick={() => setResult(null)}>{t('insights.translate.hide')}</button>
      </div>
    );
  }
  if (!info?.available) return null;
  return (
    <>
      <button type="button" className="link small" onClick={translate} disabled={busy}>
        {busy ? t('insights.translate.busy') : `${t('insights.translate.button')} (${languageName(storedTarget())})`}
      </button>
      <ErrorBox error={error} />
    </>
  );
}
