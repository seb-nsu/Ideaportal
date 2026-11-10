import { Link } from 'react-router-dom';
import type { IdeaListItem } from '../api';
import { ErrorBox, IdeaList, Loading, StatusBadge, useLoad } from '../components';
import { NEXT_STEP, formatDate } from '../labels';
import { isStaff, useSession } from '../session';
import { t, tn } from '../i18n';
import { GuaranteeCard } from './Guarantee';
import { EmptyState, FirstWeek } from './Onboarding';

interface ChallengeItem {
  id: string;
  title: string;
  question: string;
  endsOn: string;
  active: boolean;
  ideas: number;
}

// Start page "Meine Ideen" with feed, active challenges and successes (R1-22).
export function Home() {
  const { me } = useSession();
  const mine = useLoad<IdeaListItem[]>('/api/ideas?scope=mine&sort=updated');
  const feed = useLoad<IdeaListItem[]>('/api/ideas?scope=feed&sort=new');
  const challenges = useLoad<ChallengeItem[]>('/api/challenges');
  const successes = useLoad<IdeaListItem[]>('/api/ideas?scope=feed&status=completed&sort=updated');
  const active = challenges.data?.filter((c) => c.active) ?? [];
  const tasks = useLoad<Record<string, unknown[]>>('/api/tasks');
  const openTasks = Object.values(tasks.data ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  const staff = isStaff(me);

  return (
    <div className="stack">
      <h1>{t('home.hello', { name: me.user.displayName.split(' ')[0] })}</h1>
      {openTasks > 0 && (
        <p className="alert warn" role="status">
          {tn('home.openTasks', openTasks)} <Link to="/aufgaben">{t('home.openTasksLink')}</Link>
        </p>
      )}
      <GuaranteeCard />
      {active.length > 0 && (
        <section className="card" aria-labelledby="h-challenges">
          <h2 id="h-challenges">{t('home.activeChallenges')}</h2>
          <div className="grid grid-2">
            {active.map((c) => (
              <div key={c.id}>
                <Link to={`/challenges/${c.id}`}><strong>{c.title}</strong></Link>
                <p className="small">{c.question}</p>
                <p className="small muted">{t('home.challengeMeta', { date: formatDate(c.endsOn), n: c.ideas })}</p>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="grid grid-2">
        <section className="card" aria-labelledby="h-mine">
          <h2 id="h-mine">{t('home.myIdeas')}</h2>
          <ErrorBox error={mine.error} />
          {mine.loading && <Loading />}
          {!mine.loading && (mine.data?.length ? <MyIdeas ideas={mine.data} /> : <EmptyState text={t('home.myIdeasEmpty')} place="mine" />)}
        </section>
        <section className="card" aria-labelledby="h-feed">
          <h2 id="h-feed">{t('home.newIdeas')}</h2>
          <ErrorBox error={feed.error} />
          {feed.loading ? <Loading /> : <IdeaList ideas={(feed.data ?? []).slice(0, 8)} empty={t('home.noIdeas')} />}
          <Link to="/ideen">{t('home.browseAll')}</Link>
        </section>
      </div>
      {!staff && <FirstWeek />}
      {(successes.data?.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="h-success">
          <h2 id="h-success">{t('home.successes')}</h2>
          <IdeaList ideas={(successes.data ?? []).slice(0, 5)} empty="" />
        </section>
      )}
    </div>
  );
}

/** Own ideas with what happens next and the answer deadline, so nobody has to open each idea. */
function MyIdeas({ ideas }: { ideas: IdeaListItem[] }) {
  return (
    <ul className="idea-list">
      {ideas.map((i) => (
        <li key={i.id}>
          <div className="row spread">
            <Link className="title" to={`/ideen/${i.id}`}>#{i.number} {i.title}</Link>
            <StatusBadge status={i.status} />
          </div>
          <p className={i.status === 'in_question' ? 'small next-step attention' : 'small next-step'}>
            {NEXT_STEP[i.status]}
            {i.dueOn && <> <strong>{t('home.dueOn', { date: formatDate(i.dueOn) })}</strong></>}
          </p>
        </li>
      ))}
    </ul>
  );
}
