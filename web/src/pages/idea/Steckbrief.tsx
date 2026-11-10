import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ErrorBox, Loading, StatusBadge, useLoad } from '../../components';
import { isStaff, useSession } from '../../session';
import { labelMap, t, tn } from '../../i18n';
import { AiPanel } from '../../ai/AiPanel';
import { FirstStart } from '../Onboarding';
import { EffortEstimate, ImpactMetrics, ImpactReportDraft } from './Impact';
import { AFTER_GATE2, Dossier, Experiments, ImpactReview, MentorCard, Scorecard, SuccessStory, type Overview } from './Elaboration';

// Steckbrief as its own page with tabs (R2-47): summary, analyses, scorecard, experiments and
// impact. Every tab has its own address (/ideen/:id/steckbrief/:tab), so links from the Gate 2
// brief, mails and bookmarks open the right tab. The idea page shows the key facts and a link.

export const STECKBRIEF_TABS = ['zusammenfassung', 'analysen', 'scorecard', 'experimente', 'wirkung'] as const;
export type SteckbriefTab = (typeof STECKBRIEF_TABS)[number];
const TAB_LABEL = labelMap('steckbrief.tab', STECKBRIEF_TABS);
const TAB_INTRO = labelMap('steckbrief.intro', STECKBRIEF_TABS);

/** Statuses in which an idea has a Steckbrief. */
export const WITH_STECKBRIEF = ['elaboration', ...AFTER_GATE2];

export const steckbriefPath = (ideaId: string, tab: SteckbriefTab = 'zusammenfassung', hash = '') => `/ideen/${ideaId}/steckbrief/${tab}${hash}`;

/** Old anchors on the idea page and the tab that now holds them. */
export function tabForAnchor(hash: string): SteckbriefTab | null {
  const id = hash.replace(/^#/, '');
  if (!id) return null;
  if (id === 'h-dossier' || id === 'h-elab' || id.startsWith('dossier-')) return 'zusammenfassung';
  if (id === 'h-ai' || id.startsWith('ai-') || id.startsWith('src-')) return 'analysen';
  if (id === 'h-score') return 'scorecard';
  if (id === 'h-exp') return 'experimente';
  if (id === 'h-impact' || id === 'h-story') return 'wirkung';
  return null;
}

/** Scrolls to the anchor of the address once the tab content has loaded; opens a closed AI result. */
function useScrollToAnchor(tab: string) {
  const { hash } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 40) window.clearInterval(timer);
      if (!el) return;
      if (el instanceof HTMLDetailsElement) el.open = true;
      el.scrollIntoView({ block: 'start' });
    }, 150);
    return () => window.clearInterval(timer);
  }, [hash, tab]);
}

interface IdeaHead {
  id: string;
  number: number;
  title: string;
  status: string;
  confidential: boolean;
}

export function Steckbrief() {
  const { id, tab: tabParam } = useParams();
  const navigate = useNavigate();
  const { me } = useSession();
  const tab: SteckbriefTab = (STECKBRIEF_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as SteckbriefTab) : 'zusammenfassung';
  const idea = useLoad<IdeaHead>(`/api/ideas/${id}`);
  const has = !!idea.data && WITH_STECKBRIEF.includes(idea.data.status);
  const overview = useLoad<Overview>(has ? `/api/ideas/${id}/elaboration` : null);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  useScrollToAnchor(tab);

  if (idea.loading && !idea.data) return <Loading />;
  if (!idea.data) return <ErrorBox error={idea.error ?? t('steckbrief.notFound')} />;
  const d = idea.data;
  const head = (
    <div>
      <p className="muted small" style={{ margin: 0 }}>
        <Link to={`/ideen/${d.id}`}>{t('steckbrief.backToIdea', { number: d.number })}</Link>
      </p>
      <h1>{isStaff(me) ? t('steckbrief.title', { title: d.title }) : t('steckbrief.plain.title', { title: d.title })}</h1>
      <div className="row small">
        <StatusBadge status={d.status} />
        {d.confidential && <span className="badge">{t('steckbrief.confidential')}</span>}
      </div>
    </div>
  );
  if (!has) {
    return (
      <div className="stack">
        {head}
        <p className="alert info" role="status">{t('steckbrief.none')}</p>
      </div>
    );
  }

  const go = (next: SteckbriefTab, focus = false) => {
    navigate(steckbriefPath(d.id, next));
    if (focus) tabs.current[next]?.focus();
  };
  // Arrow keys move between the tabs, Home and End jump to the first and last one (WAI-ARIA tabs).
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = STECKBRIEF_TABS.indexOf(tab);
    const to = e.key === 'ArrowRight' ? (i + 1) % STECKBRIEF_TABS.length
      : e.key === 'ArrowLeft' ? (i - 1 + STECKBRIEF_TABS.length) % STECKBRIEF_TABS.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? STECKBRIEF_TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    go(STECKBRIEF_TABS[to], true);
  };
  const ov = overview.data;
  const refresh = () => {
    void overview.reload();
    void idea.reload();
  };
  const isPatron = !!ov && (ov.mentor?.id === me.user.id || ov.sponsor?.id === me.user.id);

  return (
    <div className="stack">
      {head}
      <div className="tabs" role="tablist" aria-label={t('steckbrief.tablist')}>
        {STECKBRIEF_TABS.map((k) => (
          <button
            key={k}
            ref={(el) => { tabs.current[k] = el; }}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={tab === k ? `panel-${k}` : undefined}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => go(k)}
            onKeyDown={onKey}
          >
            {TAB_LABEL[k]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="stack steckbrief-panel">
        <p className="muted small" style={{ margin: 0 }}>{TAB_INTRO[tab]}</p>
        {overview.error && <ErrorBox error={overview.error} />}
        {!ov ? <Loading /> : <TabContent tab={tab} ideaId={d.id} status={d.status} ov={ov} onChanged={refresh} />}
      </div>
      <FirstStart screen="steckbrief" enabled={isPatron || me.user.roles.includes('mentor')} />
    </div>
  );
}

function TabContent({ tab, ideaId, status, ov, onChanged }: { tab: SteckbriefTab; ideaId: string; status: string; ov: Overview; onChanged: () => void }) {
  const hint = (text: string): ReactNode => <p className="card muted">{text}</p>;
  switch (tab) {
    case 'zusammenfassung': {
      const showDossier = status === 'elaboration' || ov.sections.some((s) => s.version > 0);
      return (
        <>
          <MentorCard ideaId={ideaId} data={ov} onDone={onChanged} />
          {showDossier ? <Dossier ideaId={ideaId} data={ov} onDone={onChanged} /> : hint(t('steckbrief.noDossier'))}
          {status === 'elaboration' && <EffortEstimate ideaId={ideaId} />}
        </>
      );
    }
    case 'analysen':
      return <AiPanel ideaId={ideaId} />;
    case 'scorecard':
      return <><Scorecard ideaId={ideaId} />{hint(t('steckbrief.scorecardHint'))}</>;
    case 'experimente':
      return <><Experiments ideaId={ideaId} onDone={onChanged} />{hint(t('steckbrief.experimentsHint'))}</>;
    case 'wirkung':
      return status === 'completed' ? (
        <>
          <ImpactMetrics ideaId={ideaId} status={status} />
          <ImpactReportDraft ideaId={ideaId} />
          <ImpactReview ideaId={ideaId} onDone={onChanged} />
          <SuccessStory ideaId={ideaId} />
        </>
      ) : (
        <>
          <ImpactMetrics ideaId={ideaId} status={status} />
          {hint(t('steckbrief.impactLater'))}
        </>
      );
  }
}

/** Key facts of the Steckbrief on the idea page, with a link to every tab (R2-47). */
export function SteckbriefSummary({ ideaId, onChanged }: { ideaId: string; onChanged: () => void }) {
  const { data, error, reload } = useLoad<Overview>(`/api/ideas/${ideaId}/elaboration`);
  const { me } = useSession();
  const staff = isStaff(me);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const filled = data.sections.filter((s) => s.content.trim()).length;
  const openPoints = data.sections.reduce((n, s) => n + s.openPoints.length, 0);
  return (
    <>
      <MentorCard ideaId={ideaId} data={data} onDone={() => { void reload(); onChanged(); }} />
      <section className="card" aria-labelledby="h-steckbrief">
        <div className="row spread">
          <h2 id="h-steckbrief">{staff ? t('steckbrief.summary.heading') : t('steckbrief.plain.heading')}</h2>
          <Link className={staff ? 'button primary' : 'button'} to={steckbriefPath(ideaId)}>{staff ? t('steckbrief.summary.open') : t('steckbrief.plain.open')}</Link>
        </div>
        <p>
          {t('steckbrief.summary.sections', { filled, total: data.sections.length })}
          {openPoints > 0 && <> · {tn('steckbrief.summary.openPoints', openPoints)}</>}
        </p>
        {staff && (
          <nav aria-label={t('steckbrief.summary.tabsNav')}>
            <ul className="row steckbrief-links">
              {STECKBRIEF_TABS.map((k) => <li key={k}><Link to={steckbriefPath(ideaId, k)}>{TAB_LABEL[k]}</Link></li>)}
            </ul>
          </nav>
        )}
      </section>
    </>
  );
}
