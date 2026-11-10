import { ErrorBox, Loading, useLoad } from '../components';
import { intlLocale, labelMap, t } from '../i18n';

// "KI im Portal" (R3-22): which AI building block does what, with which model and hosting, which
// data it receives, how it did in the test set and where people decide. For every signed-in member.

interface ModelInfo {
  providerId: string;
  provider: string;
  kind: 'builtin' | 'anthropic' | 'openai_compatible';
  hosting: 'local' | 'eu' | 'other';
  model: string;
  local: boolean;
}
interface ModelChange {
  at: string;
  agent: string;
  from: string | null;
  to: string;
}
interface AgentInfo {
  agent: string;
  name: string;
  purpose: string;
  story: string;
  enabled: boolean;
  release: { released: boolean; reason: string; score?: number; minScore?: number };
  model: ModelInfo | null;
  data: { kinds: string[]; labels: string[]; note: string };
  promptVersion: string;
  evaluation: { at: string; score: number; minScore: number; passed: boolean; n: number; current: boolean; promptVersion: string | null } | null;
  oversight: { kind: string; text: string };
  history: ModelChange[];
}
interface Transparency {
  enabled: boolean;
  requireEval: boolean;
  fallbackServerSide: boolean;
  confidential: ModelInfo | null;
  models: ModelInfo[];
  agents: AgentInfo[];
}

const HOSTING = labelMap('aiTransparency.hosting', ['local', 'eu', 'other'] as const);
const KIND = labelMap('aiTransparency.kind', ['builtin', 'anthropic', 'openai_compatible'] as const);
const date = (iso: string) => new Date(iso).toLocaleDateString(intlLocale());
const pct = (n: number) => `${Math.round(n * 100)} %`;

function modelLine(m: ModelInfo): string {
  return t('aiTransparency.modelLine', { provider: m.provider, model: m.model, kind: KIND[m.kind], hosting: HOSTING[m.hosting] });
}

function status(a: AgentInfo): { text: string; tone: string } {
  if (!a.enabled) return { text: t('aiTransparency.status.off'), tone: '' };
  if (!a.release.released) return { text: t('aiTransparency.status.blocked'), tone: 'red' };
  return { text: t('aiTransparency.status.on'), tone: 'green' };
}

function AgentCard({ a }: { a: AgentInfo }) {
  const s = status(a);
  const e = a.evaluation;
  return (
    <section className="card stack" aria-labelledby={`ai-${a.agent}`}>
      <h3 id={`ai-${a.agent}`}>
        {a.name} <span className={`badge ${s.tone}`}>{s.text}</span>
      </h3>
      <p>{a.purpose}</p>
      <dl className="small">
        <dt>{t('aiTransparency.model')}</dt>
        <dd>{a.model ? modelLine(a.model) : t('aiTransparency.noModel')}</dd>
        <dt>{t('aiTransparency.data')}</dt>
        <dd>
          <ul>
            {a.data.labels.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {a.data.note && <span className="muted">{a.data.note}</span>}
        </dd>
        <dt>{t('aiTransparency.evaluation')}</dt>
        <dd>
          {!e ? (
            t('aiTransparency.noEval')
          ) : (
            <>
              <span className={`badge ${e.passed ? 'green' : 'red'}`}>{e.passed ? t('aiTransparency.passed') : t('aiTransparency.failed')}</span>{' '}
              {t('aiTransparency.evalLine', { score: pct(e.score), min: pct(e.minScore), n: e.n, date: date(e.at) })}
              {!e.current && (
                <>
                  {' '}
                  · <span className="muted">{t('aiTransparency.evalOutdated')}</span>
                </>
              )}
            </>
          )}
        </dd>
        <dt>{t('aiTransparency.oversight')}</dt>
        <dd>{a.oversight.text}</dd>
        <dt>{t('aiTransparency.promptVersion')}</dt>
        <dd>
          <code>{a.promptVersion}</code>
        </dd>
      </dl>
      {a.history.length > 0 && (
        <details>
          <summary>{t('aiTransparency.history', { n: a.history.length })}</summary>
          <ul className="small">
            {a.history.slice(0, 20).map((h, i) => (
              <li key={i}>
                {date(h.at)}: {h.from ?? '–'} → {h.to}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function AiTransparency() {
  const { data, error, loading } = useLoad<Transparency>('/api/ai/transparency');
  return (
    <div className="stack">
      <h1>{t('aiTransparency.title')}</h1>
      <p className="muted">{t('aiTransparency.intro')}</p>
      <ErrorBox error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <section className="card stack" aria-labelledby="ai-principles">
              <h2 id="ai-principles">{t('aiTransparency.principles')}</h2>
              <ul>
                <li>{t('aiTransparency.principle.decide')}</li>
                <li>{t('aiTransparency.principle.persons')}</li>
                <li>{t('aiTransparency.principle.sources')}</li>
                <li>{t('aiTransparency.principle.confidential')}</li>
                <li>{data.requireEval ? t('aiTransparency.principle.evalRequired') : t('aiTransparency.principle.evalOptional')}</li>
                <li>{data.fallbackServerSide ? t('aiTransparency.principle.fallbackOn') : t('aiTransparency.principle.fallbackOff')}</li>
              </ul>
              {!data.enabled && <p className="alert info">{t('aiTransparency.disabled')}</p>}
            </section>

            <section className="card stack" aria-labelledby="ai-models">
              <h2 id="ai-models">{t('aiTransparency.models')}</h2>
              <ul>
                {data.models.map((m) => (
                  <li key={`${m.providerId}/${m.model}`}>
                    {modelLine(m)}{' '}
                    <a href={`/api/ai/transparency/model-card.md?provider=${encodeURIComponent(m.providerId)}&model=${encodeURIComponent(m.model)}`} download>
                      {t('aiTransparency.modelCard')}
                    </a>
                  </li>
                ))}
              </ul>
              {data.confidential && <p className="small">{t('aiTransparency.confidentialModel', { model: modelLine(data.confidential) })}</p>}
            </section>

            <h2>{t('aiTransparency.agents')}</h2>
            {data.agents.map((a) => (
              <AgentCard key={a.agent} a={a} />
            ))}
          </>
        )
      )}
    </div>
  );
}
