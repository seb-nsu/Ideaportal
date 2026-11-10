import { Link, useParams } from 'react-router-dom';
import { ErrorBox, Loading, useLoad } from '../components';
import { BENEFIT, formatDate, formatNumber } from '../labels';
import { useSession } from '../session';
import { t } from '../i18n';

// Success page (R2-38): published success stories (R2-37); names only with consent and the
// person's own setting. Printable certificate per story.

interface Story {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  ideaId: string;
  number: number;
  ideaTitle: string;
  topic: string | null;
  names: string[];
  benefitKind: string | null;
  benefitValue: number | null;
}

function benefitText(s: Story): string | null {
  if (!s.benefitKind) return null;
  return `${s.benefitValue != null ? `${formatNumber(s.benefitValue)} ` : ''}${BENEFIT[s.benefitKind] ?? s.benefitKind}`;
}

export function Success() {
  const { data, error, loading } = useLoad<Story[]>('/api/success-stories');
  return (
    <div className="stack">
      <h1>{t('success.title')}</h1>
      <p className="muted">{t('success.intro')}</p>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : (
        <>
          {data?.length === 0 && <p className="muted">{t('success.empty')}</p>}
          <div className="grid grid-2">
            {data?.map((s) => (
              <article key={s.id} className="card" aria-labelledby={`story-${s.id}`}>
                <h2 id={`story-${s.id}`}>{s.title}</h2>
                <p className="small muted" style={{ marginTop: 0 }}>
                  {formatDate(s.publishedAt)} · <Link to={`/ideen/${s.ideaId}`}>#{s.number} {s.ideaTitle}</Link>
                  {s.topic && ` · ${s.topic}`}
                </p>
                <p className="pre">{s.body}</p>
                {benefitText(s) && <p><strong>{t('success.impact')}</strong> {benefitText(s)}</p>}
                {s.names.length > 0 && <p className="small">{t('success.ideaBy', { names: s.names.join(', ') })}</p>}
                <Link to={`/erfolge/${s.id}/urkunde`} className="small">{t('success.viewCertificate')}</Link>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Certificate() {
  const { id } = useParams();
  const { me } = useSession();
  const { data, error, loading } = useLoad<Story>(`/api/success-stories/${id}`);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <div className="row no-print">
        <Link to="/erfolge">{t('success.back')}</Link>
        <button type="button" className="primary" onClick={() => window.print()}>{t('success.print')}</button>
      </div>
      <article className="certificate" aria-labelledby="cert-title">
        <p className="certificate-org">{me.tenant.name}</p>
        <h1 id="cert-title">{t('success.certificate')}</h1>
        <p>{t('success.thanks')}</p>
        <p className="certificate-idea">{t('success.ideaTitle', { title: data.ideaTitle })}</p>
        {data.names.length > 0 ? <p className="certificate-names">{data.names.join(' · ')}</p> : <p className="muted">{t('success.noNames')}</p>}
        <p>{data.title}</p>
        {benefitText(data) && <p>{t('success.impactText', { text: benefitText(data) })}</p>}
        <p className="small muted">{t('success.publishedOn', { date: formatDate(data.publishedAt) })}</p>
      </article>
    </div>
  );
}
