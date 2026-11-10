import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Dialog } from '../components';
import { formatDateTime } from '../labels';
import { t } from '../i18n';

interface Inbox {
  items: { id: number; subject: string; body: string; ideaId: string | null; readAt: string | null; createdAt: string }[];
  unread: number;
}

export function Notifications() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => api.get<Inbox>('/api/notifications').then(setInbox).catch(() => undefined);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);
  const show = async () => {
    setOpen(true);
    if (inbox?.unread) {
      await api.post('/api/notifications/read');
      void load();
    }
  };
  return (
    <>
      <button type="button" onClick={show} aria-label={t('notifications.button', { n: inbox?.unread ?? 0 })}>
        🔔{inbox?.unread ? <span className="badge red">{inbox.unread}</span> : null}
      </button>
      {open && (
        <Dialog title={t('notifications.title')} onClose={() => setOpen(false)}>
          {!inbox?.items.length && <p className="muted">{t('notifications.empty')}</p>}
          <ul className="idea-list">
            {inbox?.items.map((n) => (
              <li key={n.id}>
                <div className="small muted">{formatDateTime(n.createdAt)}</div>
                {n.ideaId ? <Link to={`/ideen/${n.ideaId}`} onClick={() => setOpen(false)}><strong>{n.subject}</strong></Link> : <strong>{n.subject}</strong>}
                <p className="pre small">{n.body}</p>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setOpen(false)}>{t('common.close')}</button>
        </Dialog>
      )}
    </>
  );
}
