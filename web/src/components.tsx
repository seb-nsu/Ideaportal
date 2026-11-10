import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type Deadline, type IdeaListItem, type UserRef } from './api';
import { LIGHT, STATUS_SHORT, formatDate } from './labels';
import { t, tn } from './i18n';

export function useLoad<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      setData(await api.get<T>(url));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('components.loadError'));
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/**
 * Paged list with cursor (R3-28): loads `url` with `limit`, appends further pages on loadMore().
 * The server answers { items, nextCursor } as soon as limit is set.
 */
export function usePaged<T, X = Record<string, never>>(url: string | null, limit = 50) {
  const [items, setItems] = useState<T[] | null>(null);
  const [extra, setExtra] = useState<X | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const withPage = useCallback(
    (cursor?: string) => (url ? `${url}${url.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` : null),
    [url, limit],
  );
  const reload = useCallback(async () => {
    const u = withPage();
    if (!u) return;
    setLoading(true);
    try {
      const page = await api.get<{ items: T[]; nextCursor: string | null } & X>(u);
      setItems(page.items);
      setNext(page.nextCursor);
      setExtra(page);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('components.loadError'));
    } finally {
      setLoading(false);
    }
  }, [withPage]);
  const loadMore = useCallback(async () => {
    const u = next ? withPage(next) : null;
    if (!u) return;
    setLoadingMore(true);
    try {
      const page = await api.get<{ items: T[]; nextCursor: string | null } & X>(u);
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setNext(page.nextCursor);
      setExtra(page);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('components.loadError'));
    } finally {
      setLoadingMore(false);
    }
  }, [next, withPage]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { items, extra, error, loading, loadingMore, hasMore: !!next, loadMore, reload };
}

/** "Mehr laden" below a paged list; renders nothing when there is no further page. */
export function LoadMore({ hasMore, busy, onClick }: { hasMore: boolean; busy: boolean; onClick: () => void }) {
  if (!hasMore) return null;
  return (
    <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
      <button type="button" onClick={onClick} disabled={busy} aria-busy={busy}>
        {t('components.loadMore')}
      </button>
    </div>
  );
}

/** Runs an action and keeps busy/error state for the form that triggered it. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, t('components.unknownError')));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function ErrorBox({ error }: { error: { message: string } | string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      {typeof error === 'string' ? error : error.message}
    </div>
  );
}

export function Loading() {
  return <p className="muted" aria-live="polite">{t('common.loading')}</p>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'completed' ? 'green' : status === 'rejected' || status === 'closed_no_answer' ? 'red' : status === 'in_question' || status === 'parked' ? 'yellow' : 'accent';
  return <span className={`badge ${tone}`}>{STATUS_SHORT[status] ?? status}</span>;
}

export function DeadlineLight({ deadline }: { deadline: Deadline | null }) {
  if (!deadline) return null;
  const { light, remainingWorkdays, dueOn } = deadline;
  const text =
    light === 'paused'
      ? t('components.deadline.paused', { n: remainingWorkdays })
      : remainingWorkdays >= 0
        ? tn('components.deadline.remaining', remainingWorkdays, { date: formatDate(dueOn) })
        : tn('components.deadline.overdue', -remainingWorkdays);
  return (
    <span className={`light ${light}`} title={LIGHT[light]}>
      <span className="sr-only">{LIGHT[light]}: </span>
      {text}
    </span>
  );
}

export function IdeaList({ ideas, empty }: { ideas: IdeaListItem[]; empty: string }) {
  if (!ideas.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="idea-list">
      {ideas.map((i) => (
        <li key={i.id}>
          <div className="row spread">
            <Link className="title" to={`/ideen/${i.id}`}>
              #{i.number} {i.title}
            </Link>
            <StatusBadge status={i.status} />
          </div>
          <div className="row small muted">
            {i.topic && <span>{i.topic}</span>}
            <span>{i.ideaType === 'product' ? t('components.ideaType.product') : t('components.ideaType.internal')}</span>
            {i.ideaKind === 'problem' && <span className="badge accent">{t('usecases.problem.badge')}</span>}
            <span>{i.authorName ?? t('components.anonymous')}</span>
            <span aria-label={t('components.supporters', { n: i.supporters })}>👍 {i.supporters}</span>
            <span aria-label={t('components.comments', { n: i.comments })}>💬 {i.comments}</span>
            {i.confidential && <span className="badge">{t('components.confidential')}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && (
        <div className="hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, input, textarea, select, a')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Person search for owners, co-workers and delegated submissions. */
export function UserPicker({ id, value, onChange, role }: { id: string; value: UserRef | null; onChange: (u: UserRef | null) => void; role?: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserRef[]>([]);
  useEffect(() => {
    if (value) return;
    if (!q.trim()) return setResults([]);
    const timer = setTimeout(() => {
      api
        .get<UserRef[]>(`/api/users?q=${encodeURIComponent(q)}${role ? `&role=${role}` : ''}`)
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [q, value, role]);
  if (value) {
    return (
      <div className="row">
        <span className="badge accent">
          {value.displayName}
          {value.orgUnit ? ` · ${value.orgUnit}` : ''}
        </span>
        <button type="button" className="link" onClick={() => onChange(null)}>
          {t('components.change')}
        </button>
      </div>
    );
  }
  return (
    <div>
      <input id={id} type="search" placeholder={t('components.searchName')} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {results.length > 0 && (
        <ul className="idea-list" aria-label={t('components.searchResults')}>
          {results.map((u) => (
            <li key={u.id} style={{ padding: '4px 0' }}>
              <button type="button" className="link" onClick={() => { setQ(''); onChange(u); }}>
                {u.displayName}
              </button>{' '}
              <span className="muted small">{u.orgUnit}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Reads a file as base64 without the data-URL prefix. */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
