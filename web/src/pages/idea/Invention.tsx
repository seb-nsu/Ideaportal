import { useEffect, useState } from 'react';
import { api } from '../../api';
import { ErrorBox, useAction, useLoad } from '../../components';
import { formatDate, formatDateTime, t } from '../../i18n';

// Invention disclosure check at triage (R3-25): "possible invention?" with hints from the patent
// search (R2-24), the risk check (R2-29) and the text. The triage team answers; nothing is
// decided automatically. Forwarding to the patent office happens in the triage form.

type Check = 'possible' | 'no' | null;
interface View {
  enabled: boolean;
  check: Check;
  checkedAt: string | null;
  checkedBy: string | null;
  confidential: boolean;
  webSearchBlocked: boolean;
  hints: { source: 'R2-24' | 'R2-29' | 'text'; light: 'green' | 'yellow' | 'red' | null; text: string }[];
  patentChannels: { id: string; name: string }[];
  forwardedOn: string | null;
  claimUntil: string | null;
  claimMonths: number;
  notice: string;
}

export function InventionPanel({ ideaId, onDone }: { ideaId: string; onDone: () => void }) {
  const { data, error, setData } = useLoad<View>(`/api/ideas/${ideaId}/invention`);
  const [check, setCheck] = useState<Check>(null);
  const { busy, error: saveError, run } = useAction();
  useEffect(() => {
    if (data) setCheck(data.check);
  }, [data]);
  if (error || !data) return null;
  const save = async () => {
    const r = await run(() => api.put<View>(`/api/ideas/${ideaId}/invention`, { check }));
    if (r) {
      setData(r);
      onDone();
    }
  };
  const options: { value: Check; label: string }[] = [
    { value: null, label: t('compliance.invention.open') },
    { value: 'possible', label: t('compliance.invention.possible') },
    { value: 'no', label: t('compliance.invention.no') },
  ];

  return (
    <section className="card" aria-labelledby="h-invention">
      <h2 id="h-invention">{t('compliance.invention.title')}</h2>
      {data.forwardedOn && data.claimUntil && (
        <div className="alert info" role="status">
          {t('compliance.invention.forwarded', { date: formatDate(data.forwardedOn), until: formatDate(data.claimUntil), months: data.claimMonths })}
        </div>
      )}
      {!data.enabled && <p className="muted small">{t('compliance.invention.disabled')}</p>}
      {data.enabled && !data.forwardedOn && (
        <>
          <p className="small">{t('compliance.invention.intro')}</p>
          <ErrorBox error={saveError} />
          <fieldset>
            <legend>{t('compliance.invention.title')}</legend>
            {options.map((o) => (
              <label key={String(o.value)} className="check">
                <input type="radio" name="invention" checked={check === o.value} onChange={() => setCheck(o.value)} /> {o.label}
              </label>
            ))}
          </fieldset>
          <button type="button" disabled={busy || check === data.check} onClick={save}>{t('compliance.invention.save')}</button>
          {data.checkedBy && data.checkedAt && <p className="muted small">{t('compliance.invention.checkedBy', { name: data.checkedBy, date: formatDateTime(data.checkedAt) })}</p>}
        </>
      )}
      <h3>{t('compliance.invention.hints')}</h3>
      <ul className="small">
        {data.hints.map((h, i) => (
          <li key={i}>
            <strong>{t(`compliance.invention.source.${h.source}`)}</strong>
            {h.light && <> ({t(`compliance.invention.light.${h.light}`)})</>}: {h.text}
          </li>
        ))}
      </ul>
      {data.webSearchBlocked && <p className="small">{t('compliance.invention.noSearch')}</p>}
      {data.check === 'possible' && !data.forwardedOn && (
        <p className="small">
          {data.patentChannels.length
            ? t('compliance.invention.forwardTip', { channels: data.patentChannels.map((c) => c.name).join(', ') })
            : t('compliance.invention.noChannel')}
        </p>
      )}
      <p className="muted small">{data.notice}</p>
    </section>
  );
}
