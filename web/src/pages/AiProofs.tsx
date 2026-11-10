import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading, useLoad } from '../components';
import { useSession } from '../session';
import { formatDateTime } from '../labels';
import { intlLocale, t } from '../i18n';

// Privacy proofs of the AI processing (R2-42) for the works council and admins: one line per
// idea with AI actions, the details as PDF. No idea texts; confidential ideas only by number.

interface ProofLine {
  ideaId: string;
  number: number;
  title: string | null;
  confidential: boolean;
  actions: number;
  external: number;
  searchQueries: number;
  costEur: number;
  lastAction: string;
}

export function AiProofs() {
  const { settings } = useSession();
  const [from, setFrom] = useState(`${Number(settings.today.slice(0, 4)) - 1}${settings.today.slice(4)}`);
  const [to, setTo] = useState(settings.today);
  const { data, error, loading } = useLoad<{ items: ProofLine[] }>(`/api/ai/proofs?from=${from}&to=${to}`);
  return (
    <div className="stack">
      <h1>{t('aiProofs.title')}</h1>
      <p className="muted">{t('aiProofs.intro')}</p>
      <div className="card row">
        <div><label htmlFor="pf-from">{t('aiProofs.from')}</label><input id="pf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="pf-to">{t('aiProofs.to')}</label><input id="pf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && (
        data.items.length === 0 ? <p className="muted">{t('aiProofs.empty')}</p> : (
          <div className="table-wrap card" tabIndex={0}>
            <div className="table-wrap" tabIndex={0}><table>
              <caption className="sr-only">{t('aiProofs.caption')}</caption>
              <thead><tr><th scope="col">{t('aiProofs.idea')}</th><th scope="col">{t('aiProofs.actions')}</th><th scope="col">{t('aiProofs.external')}</th><th scope="col">{t('aiProofs.searchQueries')}</th><th scope="col">{t('aiProofs.cost')}</th><th scope="col">{t('aiProofs.last')}</th><th scope="col">{t('aiProofs.proof')}</th></tr></thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.ideaId}>
                    <th scope="row">{p.title ? <Link to={`/ideen/${p.ideaId}`}>#{p.number} {p.title}</Link> : t('aiProofs.confidential', { n: p.number })}</th>
                    <td>{p.actions}</td>
                    <td>{p.external}</td>
                    <td>{p.searchQueries}</td>
                    <td>{t('aiProofs.costValue', { amount: p.costEur.toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 }) })}</td>
                    <td>{formatDateTime(p.lastAction)}</td>
                    <td><a href={`/api/ideas/${p.ideaId}/ai/proof.pdf`} download>{t('aiProofs.pdf')}</a></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )
      )}
    </div>
  );
}
