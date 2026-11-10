import { Field, useLoad } from '../components';
import { formatNumber, t, tn } from '../i18n';

// Visible response guarantee per tenant (R1-46): the promise and its fulfilment over the last
// 90 days on the start page, the setting under Einstellungen › Prozess.

interface Quota {
  enabled: boolean;
  workdays: number;
  alertBelowPercent: number;
  windowDays: number;
  counted: number;
  met: number;
  pending: number;
  quota: number | null;
}

export function GuaranteeCard() {
  const { data } = useLoad<Quota>('/api/guarantee');
  if (!data?.enabled) return null;
  const ok = data.quota == null || data.quota >= data.alertBelowPercent;
  return (
    <section className="card guarantee" aria-labelledby="h-guarantee">
      <h2 id="h-guarantee">{t('guarantee.heading')}</h2>
      <p style={{ marginTop: 0 }}>{t('guarantee.promise', { n: data.workdays })}</p>
      {data.quota == null ? (
        <p className="muted" style={{ margin: 0 }}>{t('guarantee.noData', { days: data.windowDays })}</p>
      ) : (
        <p style={{ margin: 0 }}>
          <span className="kpi-inline">{formatNumber(data.quota, 1)} %</span>{' '}
          <span className={`badge ${ok ? 'green' : 'yellow'}`}>{ok ? t('guarantee.kept') : t('guarantee.below')}</span>{' '}
          <span className="small">{t('guarantee.detail', { met: data.met, counted: data.counted, days: data.windowDays })}</span>
        </p>
      )}
      {data.pending > 0 && <p className="small muted" style={{ margin: '6px 0 0' }}>{tn('guarantee.pending', data.pending)}</p>}
    </section>
  );
}

type Value = { enabled: boolean; workdays: number; alertBelowPercent: number };

export function GuaranteeSettings({ value, onChange }: { value: Value; onChange: (v: Value) => void }) {
  return (
    <>
      <h2 style={{ marginTop: 20 }}>{t('guarantee.settings.heading')}</h2>
      <p className="small muted">{t('guarantee.settings.hint')}</p>
      <label className="check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} /> {t('guarantee.settings.enabled')}
      </label>
      <div className="grid grid-3">
        <Field id="guarantee-workdays" label={t('guarantee.settings.workdays')}>
          <input id="guarantee-workdays" type="number" min={1} max={60} value={value.workdays} onChange={(e) => onChange({ ...value, workdays: Number(e.target.value) })} />
        </Field>
        <Field id="guarantee-threshold" label={t('guarantee.settings.threshold')} hint={t('guarantee.settings.thresholdHint')}>
          <input id="guarantee-threshold" type="number" min={0} max={100} value={value.alertBelowPercent} aria-describedby="guarantee-threshold-hint"
            onChange={(e) => onChange({ ...value, alertBelowPercent: Number(e.target.value) })} />
        </Field>
      </div>
    </>
  );
}
