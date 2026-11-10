import { api } from '../api';
import { ErrorBox, Loading, useAction, useLoad } from '../components';
import { formatNumber, t, type MessageKey } from '../i18n';

// Gamification per challenge (R2-53): own points and badges, opt-in to the leaderboard of this
// challenge, the leaderboard of people who agreed, and the admin switches. Nothing per person
// appears anywhere else (no dashboard, no export).

interface View {
  enabled: boolean;
  leaderboardEnabled: boolean;
  canManage: boolean;
  points: { pointsSubmit: number; pointsComment: number; pointsRating: number };
  me: { ideas: number; comments: number; ratings: number; points: number; badges: string[]; consent: boolean } | null;
  leaderboard: { rank: number; name: string; points: number; badges: string[]; me: boolean }[] | null;
}

const badge = (id: string) => t(`insights.game.badge.${id}` as MessageKey);

export function Gamification({ challengeId }: { challengeId: string }) {
  const { data, error, loading, setData } = useLoad<View>(`/api/challenges/${challengeId}/gamification`);
  const action = useAction();
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  if (!data.enabled && !data.canManage) return null;

  const consent = async (value: boolean) => {
    const r = await action.run(() => api.put<View>(`/api/challenges/${challengeId}/gamification/consent`, { consent: value }));
    if (r) setData(r);
  };
  const toggle = async (patch: { enabled?: boolean; leaderboard?: boolean }) => {
    const r = await action.run(() => api.patch<View>(`/api/challenges/${challengeId}/gamification`, patch));
    if (r) setData(r);
  };

  return (
    <section className="card stack" aria-labelledby="h-game">
      <h2 id="h-game">{t('insights.game.title')}</h2>
      <ErrorBox error={action.error} />
      {!data.enabled && <p className="muted">{t('insights.game.off')}</p>}
      {data.enabled && data.me && (
        <>
          <p className="small muted">{t('insights.game.intro', { submit: data.points.pointsSubmit, comment: data.points.pointsComment, rating: data.points.pointsRating })}</p>
          <p>
            <strong>{t('insights.game.myPoints', { n: formatNumber(data.me.points) })}</strong>
            <br />
            <span className="small">{t('insights.game.breakdown', { ideas: data.me.ideas, comments: data.me.comments, ratings: data.me.ratings })}</span>
          </p>
          <div>
            <h3 className="small">{t('insights.game.badges')}</h3>
            {data.me.badges.length ? (
              <ul className="row" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {data.me.badges.map((b) => <li key={b}><span className="badge green">{badge(b)}</span></li>)}
              </ul>
            ) : <p className="small muted">{t('insights.game.noBadges')}</p>}
          </div>
          {data.leaderboardEnabled ? (
            <>
              <label className="check">
                <input type="checkbox" checked={data.me.consent} disabled={action.busy} onChange={(e) => void consent(e.target.checked)} aria-describedby="game-consent-hint" />{' '}
                {t('insights.game.consent')}
              </label>
              <p className="small muted" id="game-consent-hint">{t('insights.game.consentHint')}</p>
              <h3>{t('insights.game.leaderboard')}</h3>
              {data.leaderboard && data.leaderboard.length > 0 ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t('insights.game.col.rank')}</th>
                        <th scope="col">{t('insights.game.col.name')}</th>
                        <th scope="col">{t('insights.game.col.points')}</th>
                        <th scope="col">{t('insights.game.col.badges')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.leaderboard.map((r) => (
                        <tr key={`${r.rank}-${r.name}`}>
                          <td>{r.rank}</td>
                          <td>{r.name}{r.me && <> {t('insights.game.you')}</>}</td>
                          <td>{formatNumber(r.points)}</td>
                          <td>{r.badges.map(badge).join(', ') || '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="small muted">{t('insights.game.leaderboardEmpty')}</p>}
            </>
          ) : <p className="small muted">{t('insights.game.leaderboardOff')}</p>}
        </>
      )}
      {data.canManage && (
        <fieldset>
          <legend className="small">{t('insights.game.admin')}</legend>
          <label className="check">
            <input type="checkbox" checked={data.enabled} disabled={action.busy} onChange={(e) => void toggle({ enabled: e.target.checked })} />{' '}
            {t('insights.game.adminEnabled')}
          </label>
          <label className="check">
            <input type="checkbox" checked={data.enabled && data.leaderboardEnabled} disabled={action.busy || !data.enabled} onChange={(e) => void toggle({ leaderboard: e.target.checked })} />{' '}
            {t('insights.game.adminLeaderboard')}
          </label>
        </fieldset>
      )}
    </section>
  );
}
