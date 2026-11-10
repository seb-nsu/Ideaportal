import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading, useLoad } from '../components';
import { formatDate } from '../labels';
import { t } from '../i18n';
import { EmptyState, FirstWeek } from './Onboarding';

interface TaskItem {
  id: string;
  number: number;
  title: string;
  status: string;
  implementationStatus?: string;
  targetDate?: string;
  progress?: number;
  timeboxUntil?: string | null;
  endsOn?: string;
  hypothesis?: string;
  dueOn?: string;
  due?: boolean;
  storyTitle?: string;
}

interface TaskData {
  implementations: TaskItem[];
  questions: TaskItem[];
  confirmations: TaskItem[];
  mentoring: TaskItem[];
  experiments: TaskItem[];
  impactReviews: TaskItem[];
  impactConfirmations: TaskItem[];
  stories: TaskItem[];
  jury: { id: string; title: string; endsOn: string; open: number }[];
  meetings: { id: string; title: string; meetsOn: string }[];
}

function TaskSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <ul className="idea-list">{children}</ul>
    </section>
  );
}

const ideaLink = (item: TaskItem) => <Link to={`/ideen/${item.id}`}>#{item.number} {item.title}</Link>;

export function Tasks() {
  const { data, error, loading } = useLoad<TaskData>('/api/tasks');
  if (loading && !data) return <Loading />;
  const lists = data ? [data.implementations, data.questions, data.confirmations, data.mentoring ?? [], data.experiments ?? [], data.impactReviews ?? [],
    data.impactConfirmations ?? [], data.stories ?? [], data.jury ?? [], data.meetings ?? []] : [];
  const empty = data && lists.every((l) => l.length === 0);
  return (
    <div className="stack">
      <h1>{t('tasks.title')}</h1>
      <ErrorBox error={error} />
      <FirstWeek />
      {empty && <section className="card"><EmptyState text={t('tasks.empty')} place="tasks" /></section>}
      {!!data?.questions.length && (
        <TaskSection title={t('tasks.questions')}>
          {data.questions.map((item) => <li key={item.id}>{ideaLink(item)}</li>)}
        </TaskSection>
      )}
      {!!data?.confirmations.length && (
        <TaskSection title={t('tasks.confirmations')}>
          {data.confirmations.map((item) => <li key={item.id}>{ideaLink(item)}</li>)}
        </TaskSection>
      )}
      {!!data?.stories?.length && (
        <TaskSection title={t('tasks.stories')}>
          {data.stories.map((item) => <li key={item.id}>{ideaLink(item)}<div className="small muted">{t('tasks.storyTitle', { title: item.storyTitle })}</div></li>)}
        </TaskSection>
      )}
      {!!data?.meetings?.length && (
        <TaskSection title={t('tasks.meetings')}>
          {data.meetings.map((m) => <li key={m.id}><Link to={`/gremium/${m.id}`}>{m.title}</Link><div className="small muted">{t('tasks.meetsOn', { date: formatDate(m.meetsOn) })}</div></li>)}
        </TaskSection>
      )}
      {!!data?.mentoring?.length && (
        <TaskSection title={t('tasks.mentoring')}>
          {data.mentoring.map((item) => <li key={item.id}>{ideaLink(item)}<div className="small muted">{t('tasks.timebox', { date: formatDate(item.timeboxUntil) })}</div></li>)}
        </TaskSection>
      )}
      {!!data?.experiments?.length && (
        <TaskSection title={t('tasks.experiments')}>
          {data.experiments.map((item, i) => <li key={`${item.id}-${i}`}>{ideaLink(item)}<div className="small muted">{item.hypothesis} · {t('tasks.endsOn', { date: formatDate(item.endsOn) })}</div></li>)}
        </TaskSection>
      )}
      {!!data?.impactReviews?.length && (
        <TaskSection title={t('tasks.impactReviews')}>
          {data.impactReviews.map((item) => (
            <li key={item.id}>
              {ideaLink(item)}
              <div className="small">{item.due ? <span className="badge yellow">{t('tasks.due')}</span> : <span className="muted">{t('tasks.dueOn', { date: formatDate(item.dueOn) })}</span>}</div>
            </li>
          ))}
        </TaskSection>
      )}
      {!!data?.impactConfirmations?.length && (
        <TaskSection title={t('tasks.impactConfirmations')}>
          {data.impactConfirmations.map((item) => <li key={item.id}>{ideaLink(item)}</li>)}
        </TaskSection>
      )}
      {!!data?.jury?.length && (
        <TaskSection title={t('tasks.jury')}>
          {data.jury.map((c) => <li key={c.id}><Link to={`/challenges/${c.id}`}>{c.title}</Link><div className="small muted">{t('tasks.juryOpen', { n: c.open })}</div></li>)}
        </TaskSection>
      )}
      {!!data?.implementations.length && (
        <TaskSection title={t('tasks.implementations')}>
          {data.implementations.map((item) => (
            <li key={item.id}>
              {ideaLink(item)}
              <div className="small muted">
                {item.implementationStatus === 'proposed' ? t('tasks.confirmHandover') : t('tasks.progress', { n: item.progress })} · {t('tasks.targetDate', { date: formatDate(item.targetDate) })}
              </div>
            </li>
          ))}
        </TaskSection>
      )}
    </div>
  );
}
