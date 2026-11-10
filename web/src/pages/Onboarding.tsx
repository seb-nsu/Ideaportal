import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Me, type Role } from '../api';
import { Dialog } from '../components';
import { useSession } from '../session';
import { t, type MessageKey } from '../i18n';

// Short tour on first login (R1-38), first start per role on the first visit of Board, Steckbrief
// and Gremium, the "first week" checklist under "Meine Aufgaben" and empty states with the next
// step for the person's role (R2-48). Seen steps and ticked items are stored per person on the server.

export function Onboarding({ onClose }: { onClose: () => void }) {
  const { settings } = useSession();
  const [step, setStep] = useState(0);
  const steps = [
    { title: t('onboarding.step1.title'), text: t('onboarding.step1.text') },
    { title: t('onboarding.step2.title'), text: t('onboarding.step2.text', { n: settings.deadlines.gate1Workdays }) },
    { title: t('onboarding.step3.title'), text: t('onboarding.step3.text') },
  ];
  return <Steps steps={steps} step={step} setStep={setStep} onClose={onClose} />;
}

function Steps({ steps, step, setStep, onClose }: { steps: { title: string; text: string }[]; step: number; setStep: (n: number) => void; onClose: () => void }) {
  const s = steps[step];
  return (
    <Dialog title={s.title} onClose={onClose}>
      <p>{s.text}</p>
      <p className="small muted">{t('onboarding.progress', { step: step + 1, total: steps.length })}</p>
      <div className="row spread">
        <button type="button" onClick={onClose}>{t('onboarding.skip')}</button>
        {step < steps.length - 1 ? (
          <button type="button" className="primary" onClick={() => setStep(step + 1)}>{t('onboarding.next')}</button>
        ) : (
          <button type="button" className="primary" onClick={onClose}>{t('onboarding.start')}</button>
        )}
      </div>
    </Dialog>
  );
}

/** True while the general tour is open; the first start of a screen waits for it. */
export const TourContext = createContext(false);

// ---------------------------------------------------------------- stored state per person

export interface OnboardingState {
  introsSeen: string[];
  firstWeek: { done: string[]; hidden: boolean };
}

let cache: { userId: string; promise: Promise<OnboardingState> } | null = null;

function loadState(userId: string): Promise<OnboardingState> {
  if (!cache || cache.userId !== userId) {
    const promise = api.get<OnboardingState>('/api/me/onboarding');
    cache = { userId, promise };
    promise.catch(() => { cache = null; });
  }
  return cache.promise;
}

function useOnboardingState() {
  const { me } = useSession();
  const [state, setState] = useState<OnboardingState | null>(null);
  useEffect(() => {
    let live = true;
    loadState(me.user.id).then((s) => live && setState(s)).catch(() => undefined);
    return () => { live = false; };
  }, [me.user.id]);
  const update = useCallback((next: OnboardingState) => {
    cache = { userId: me.user.id, promise: Promise.resolve(next) };
    setState(next);
  }, [me.user.id]);
  return { state, update };
}

// ---------------------------------------------------------------- first start per role and screen

export type IntroScreen = 'board' | 'steckbrief' | 'gremium';
const INTRO_ROLES: Record<IntroScreen, Role[]> = { board: ['triage', 'admin'], steckbrief: ['mentor'], gremium: ['committee'] };

/**
 * Three steps on the first visit of a screen for the role that works there. Skipping or finishing
 * is remembered per person and screen. `enabled` lets a page widen the audience (the idea's mentor
 * or sponsor on the Steckbrief).
 */
export function FirstStart({ screen, enabled }: { screen: IntroScreen; enabled?: boolean }) {
  const { me } = useSession();
  const tourOpen = useContext(TourContext);
  const { state, update } = useOnboardingState();
  const [step, setStep] = useState(0);
  const forRole = enabled ?? INTRO_ROLES[screen].some((r) => me.user.roles.includes(r));
  if (!forRole || tourOpen || !state || state.introsSeen.includes(screen)) return null;
  const steps = [1, 2, 3].map((n) => ({
    title: t(`onboarding.${screen}.${n}.title` as MessageKey),
    text: t(`onboarding.${screen}.${n}.text` as MessageKey),
  }));
  const close = () => {
    update({ ...state, introsSeen: [...state.introsSeen, screen] });
    void api.post('/api/me/onboarding/intro', { screen }).catch(() => undefined);
  };
  return <Steps steps={steps} step={step} setStep={setStep} onClose={close} />;
}

// ---------------------------------------------------------------- next step per role

type Kind = 'admin' | 'triage' | 'committee' | 'mentor' | 'submitter';

/** The role that shapes first steps and empty states: the most specific one the person has. */
export function primaryRole(me: Me): Kind {
  const r = me.user.roles;
  if (r.includes('admin')) return 'admin';
  if (r.includes('triage')) return 'triage';
  if (r.includes('committee')) return 'committee';
  if (r.includes('mentor')) return 'mentor';
  return 'submitter';
}

const NEXT: Record<Kind, { to: string; key: string }> = {
  admin: { to: '/einstellungen', key: 'admin' },
  triage: { to: '/board', key: 'triage' },
  committee: { to: '/gremium', key: 'committee' },
  mentor: { to: '/ideen', key: 'mentor' },
  submitter: { to: '/einreichen', key: 'submitter' },
};

type Place = 'tasks' | 'board' | 'meetings' | 'mine';

function nextStep(place: Place, role: Kind): { to: string; key: string } {
  if (place === 'mine') return NEXT.submitter;
  if (place === 'board') return role === 'admin' ? { to: '/einstellungen', key: 'adminBoard' } : { to: '/challenges', key: 'triageBoard' };
  if (place === 'meetings') return role === 'admin' || role === 'triage' ? { to: '/board', key: 'triageMeetings' } : { to: '/portfolio', key: 'committeeMeetings' };
  return NEXT[role];
}

/** Empty state: what is missing, the next step for the person's role and a button for it. */
export function EmptyState({ text, place }: { text: string; place: Place }) {
  const { me } = useSession();
  const next = nextStep(place, primaryRole(me));
  return (
    <div className="empty-state">
      <p className="muted" style={{ margin: 0 }}>{text}</p>
      <p style={{ margin: 0 }}>{t(`onboarding.next.${next.key}.text` as MessageKey)}</p>
      <Link className="button" to={next.to}>{t(`onboarding.next.${next.key}.button` as MessageKey)}</Link>
    </div>
  );
}

// ---------------------------------------------------------------- first week checklist (Meine Aufgaben)

interface Item { id: string; to: string }

const COMMON: Item[] = [
  { id: 'account', to: '/konto' },
  { id: 'help', to: '/hilfe' },
];
const BY_ROLE: Record<Kind, Item[]> = {
  admin: [{ id: 'settings', to: '/einstellungen' }, { id: 'invite', to: '/einstellungen' }, { id: 'guarantee', to: '/' }],
  triage: [{ id: 'board', to: '/board' }, { id: 'triage', to: '/board' }, { id: 'meeting', to: '/gremium' }],
  committee: [{ id: 'gremium', to: '/gremium' }, { id: 'brief', to: '/gremium' }, { id: 'portfolio', to: '/portfolio' }],
  mentor: [{ id: 'mentoring', to: '/aufgaben' }, { id: 'dossier', to: '/aufgaben' }, { id: 'experiment', to: '/aufgaben' }],
  submitter: [{ id: 'submit', to: '/einreichen' }, { id: 'support', to: '/ideen' }, { id: 'challenge', to: '/challenges' }],
};

export function FirstWeek() {
  const { me } = useSession();
  const { state, update } = useOnboardingState();
  const [error, setError] = useState(false);
  if (!state || state.firstWeek.hidden) return null;
  const items = [...BY_ROLE[primaryRole(me)], ...COMMON];
  const done = new Set(state.firstWeek.done);
  const save = (next: OnboardingState['firstWeek']) => {
    const previous = state;
    update({ ...state, firstWeek: next });
    setError(false);
    api.put('/api/me/onboarding/first-week', next).catch(() => { update(previous); setError(true); });
  };
  const toggle = (id: string) => save({ done: done.has(id) ? [...done].filter((x) => x !== id) : [...done, id], hidden: false });
  const count = items.filter((i) => done.has(i.id)).length;
  const repeat = () => {
    update({ ...state, introsSeen: [] });
    void api.del('/api/me/onboarding/intro').catch(() => undefined);
  };
  return (
    <section className="card" aria-labelledby="h-first-week">
      <h2 id="h-first-week">{t('onboarding.week.heading')}</h2>
      <p className="small muted">{t('onboarding.week.progress', { n: count, total: items.length })}</p>
      {error && <p className="alert error" role="alert">{t('onboarding.week.error')}</p>}
      <ul className="checklist">
        {items.map((i) => (
          <li key={i.id}>
            <label className="check">
              <input type="checkbox" checked={done.has(i.id)} onChange={() => toggle(i.id)} /> {t(`onboarding.week.${i.id}` as MessageKey)}
            </label>{' '}
            <Link className="small" to={i.to} aria-label={t('onboarding.week.goLabel', { item: t(`onboarding.week.${i.id}` as MessageKey) })}>{t('onboarding.week.go')}</Link>
          </li>
        ))}
      </ul>
      {count === items.length && <p className="alert success" role="status">{t('onboarding.week.allDone')}</p>}
      <div className="row">
        <button type="button" onClick={() => save({ done: [...done], hidden: true })}>{t('onboarding.week.hide')}</button>
        <button type="button" className="link" onClick={repeat}>{t('onboarding.week.repeat')}</button>
      </div>
    </section>
  );
}
