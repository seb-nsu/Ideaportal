import { Link } from 'react-router-dom';
import { CHANNEL_KINDS } from '../labels';
import { useSession } from '../session';
import { t } from '../i18n';

// FAQ including the boundary to reporting channels, and the privacy notice (R1-38, R1-41, section 6).
export function Help() {
  const { settings } = useSession();
  return (
    <div className="stack">
      <h1>{t('help.title')}</h1>
      <section className="card">
        <h2>{t('help.whatBelongs')}</h2>
        <p>{t('help.whatBelongsText')}</p>
        {settings.targetChannels.length === 0 ? (
          <p className="muted">{t('help.contactOffice')}</p>
        ) : (
          <div className="table-wrap" tabIndex={0}><table>
            <thead><tr><th scope="col">{t('help.concern')}</th><th scope="col">{t('help.channel')}</th><th scope="col">{t('help.contact')}</th></tr></thead>
            <tbody>
              {settings.targetChannels.map((c) => (
                <tr key={c.id}>
                  <td>{CHANNEL_KINDS[c.kind] ?? c.kind}</td>
                  <td>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}</td>
                  <td>{c.contact}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <p className="small" style={{ marginTop: 12 }}><strong>{t('help.important')}</strong> {t('help.notWhistleblowing')}</p>
      </section>
      <section className="card">
        <h2>{t('help.faq')}</h2>
        {settings.texts.faq.map((f) => (
          <details key={f.q} style={{ marginBottom: 10 }}>
            <summary><strong>{f.q}</strong></summary>
            <p className="pre" style={{ marginTop: 6 }}>{f.a}</p>
          </details>
        ))}
      </section>
      <section className="card">
        <h2>{t('help.howItWorks')}</h2>
        <ol>
          <li><strong>{t('help.step.submit')}</strong> {t('help.step.submitText')}</li>
          <li><strong>{t('help.step.gate1')}</strong> {t('help.step.gate1Text', { n: settings.deadlines.gate1Workdays })}</li>
          <li><strong>{t('help.step.gate2')}</strong> {t('help.step.gate2Text')}</li>
          <li><strong>{t('help.step.implement')}</strong> {t('help.step.implementText')}</li>
        </ol>
        <p className="small muted">{t('help.questionNote')}</p>
      </section>
      <section className="card">
        <h2>{t('help.privacy')}</h2>
        <p className="pre">{settings.texts.privacyNotice}</p>
      </section>
      <section className="card">
        <h2>{t('aiTransparency.helpTitle')}</h2>
        <p>{t('aiTransparency.helpText')} <Link to="/ki-im-portal">{t('aiTransparency.helpLink')}</Link></p>
      </section>
    </div>
  );
}
