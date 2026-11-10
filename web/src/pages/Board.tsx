import { Link } from 'react-router-dom';
import type { Deadline, Role } from '../api';
import { DeadlineLight, ErrorBox, LoadMore, Loading, StatusBadge, useLoad, usePaged } from '../components';
import { useSession } from '../session';
import { formatDate } from '../labels';
import { t } from '../i18n';
import { EmptyState, FirstStart } from './Onboarding';

interface BoardItem {
  id: string;
  number: number;
  title: string;
  topic: string | null;
  status: string;
  confidential: boolean;
  authorName: string;
  supporters: number;
  resubmitOn: string | null;
  deadline: Deadline | null;
}

const columns = () => [
  { title: t('board.col.new'), statuses: ['submitted'] },
  { title: t('board.col.question'), statuses: ['in_question'] },
  { title: t('board.col.elaboration'), statuses: ['elaboration'] },
  { title: t('board.col.implementation'), statuses: ['fast_lane', 'implementing', 'piloting', 'integrated'] },
  { title: t('board.col.parked'), statuses: ['parked'] },
];

const BOARD_ROLES: Role[] = ['triage', 'committee', 'admin'];

// Triage board with deadline traffic light, sorted by due date (R1-23); pages of 100 with
// "Mehr laden", column counts over the whole board (R3-28).
export function Board() {
  const board = usePaged<BoardItem, { counts: Record<string, number> }>('/api/triage/board', 100);
  const { items: data, error, loading } = board;
  const counts = board.extra?.counts ?? {};
  // Roles with a scope (R3-29): the board only holds the ideas of the person's areas.
  const { me } = useSession();
  const scoped = BOARD_ROLES.every((r) => !me.user.roles.includes(r) || !!me.user.scopes?.[r]);
  const areas = useLoad<{ items: { id: string; name: string }[] }>(scoped ? '/api/dashboard/areas' : null);
  if (loading && !data) return <Loading />;
  const overdue = data?.filter((i) => i.deadline?.light === 'red').length ?? 0;
  return (
    <div className="stack">
      <div className="row spread">
        <h1>{t('board.title')}</h1>
        <div className="row">
          {overdue > 0 && <span className="badge red">{t('board.overdue', { n: overdue })}</span>}
          <Link to="/gremium" className="button">{t('board.meetings')}</Link>
          <Link to="/portfolio" className="button">{t('board.portfolio')}</Link>
        </div>
      </div>
      {scoped && !!areas.data && <p className="small muted">{t('areas.boardHint', { areas: areas.data.items.map((a) => a.name).join(', ') })}</p>}
      <ErrorBox error={error} />
      {data?.length === 0 && <section className="card"><EmptyState text={t('board.empty')} place="board" /></section>}
      <FirstStart screen="board" />
      <div className="board">
        {columns().map((col) => {
          const items = (data ?? []).filter((i) => col.statuses.includes(i.status));
          const total = col.statuses.reduce((sum, st) => sum + (counts[st] ?? 0), 0);
          return (
            <section key={col.title} className="board-col" aria-label={col.title}>
              <h2>
                {col.title} <span className="badge">{Math.max(total, items.length)}</span>
              </h2>
              {items.map((i) => (
                <Link key={i.id} className="board-card" to={`/ideen/${i.id}`}>
                  <div className="small muted">#{i.number} · {i.topic}</div>
                  <strong>{i.title}</strong>
                  <div className="row small" style={{ marginTop: 6 }}>
                    {col.statuses.length > 1 && <StatusBadge status={i.status} />}
                    {i.confidential && <span className="badge">{t('board.confidential')}</span>}
                    {i.deadline && <DeadlineLight deadline={i.deadline} />}
                    {i.resubmitOn && <span className="muted">{t('board.resubmit', { date: formatDate(i.resubmitOn) })}</span>}
                  </div>
                </Link>
              ))}
            </section>
          );
        })}
      </div>
      <LoadMore hasMore={board.hasMore} busy={board.loadingMore} onClick={() => void board.loadMore()} />
    </div>
  );
}
