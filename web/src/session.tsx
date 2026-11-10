import { createContext, useContext } from 'react';
import type { Me, PublicSettings, Role } from './api';

export interface Session {
  me: Me;
  settings: PublicSettings;
  refresh: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('no session');
  return s;
}

export function hasRole(me: Me, ...roles: Role[]): boolean {
  return roles.some((r) => me.user.roles.includes(r));
}

/** Has a role in the idea process (not only submitting); sees process terms and work tools. */
export function isStaff(me: Me): boolean {
  return hasRole(me, 'triage', 'admin', 'committee', 'lead', 'mentor', 'implementer', 'controlling');
}
