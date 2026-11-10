import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { IdeaListItem } from '../api';
import { ErrorBox, IdeaList, LoadMore, Loading, usePaged } from '../components';
import { STATUS_SHORT } from '../labels';
import { useSession } from '../session';
import { t } from '../i18n';

// Search and filter (R1-22) with full-text ranking and "Mehr laden" (R3-28).
export function Ideas() {
  const { settings } = useSession();
  const [q, setQ] = useState('');
  const [topic, setTopic] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('new');
  // Problem exchange (R3-31): "/ideen?art=problem" shows only problems.
  const [problems, setProblems] = useState(() => new URLSearchParams(window.location.search).get('art') === 'problem');
  const [query, setQuery] = useState('');
  const params = new URLSearchParams({ scope: 'all', sort });
  if (query) params.set('q', query);
  if (topic) params.set('topic', topic);
  if (status) params.set('status', status);
  if (problems) params.set('kind', 'problem');
  const list = usePaged<IdeaListItem>(`/api/ideas?${params}`, 50);

  return (
    <div className="stack">
      <div className="row spread">
        <h1>{t('ideas.title')}</h1>
        <Link className="button" to="/einreichen?art=problem">{t('usecases.problems.report')}</Link>
      </div>
      <form
        className="card row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q);
          // A new search term ranks by relevance; without a term relevance has no meaning.
          if (q.trim() && sort === 'new') setSort('relevance');
          if (!q.trim() && sort === 'relevance') setSort('new');
        }}
      >
        <div style={{ flex: 2, minWidth: 200 }}>
          <label htmlFor="q">{t('ideas.search')}</label>
          <input id="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ideas.keyword')} />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="topic">{t('ideas.topic')}</label>
          <select id="topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">{t('ideas.all')}</option>
            {settings.topics.map((tp) => <option key={tp}>{tp}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="status">{t('ideas.status')}</label>
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('ideas.all')}</option>
            {Object.entries(STATUS_SHORT).filter(([k]) => k !== 'draft').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="sort">{t('ideas.sort')}</label>
          <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            {query && <option value="relevance">{t('ideas.sort.relevance')}</option>}
            <option value="new">{t('ideas.sort.new')}</option>
            <option value="updated">{t('ideas.sort.updated')}</option>
            <option value="supporters">{t('ideas.sort.supporters')}</option>
          </select>
        </div>
        <label className="check" style={{ alignSelf: 'flex-end' }}>
          <input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} /> {t('usecases.problems.filter')}
        </label>
        <button type="submit" className="primary" style={{ alignSelf: 'flex-end' }}>{t('ideas.submit')}</button>
      </form>
      <section className="card" aria-live="polite">
        <ErrorBox error={list.error} />
        {list.loading ? <Loading /> : <IdeaList ideas={list.items ?? []} empty={t('ideas.empty')} />}
        {!list.loading && <LoadMore hasMore={list.hasMore} busy={list.loadingMore} onClick={() => void list.loadMore()} />}
      </section>
    </div>
  );
}
