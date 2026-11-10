import { getLocale, t } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'accept-language': getLocale(), ...(body === undefined ? { 'x-requested-with': 'fetch' } : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? t('components.unknownError'), data?.code, data?.details);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T = { ok: boolean }>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T = { ok: boolean }>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  put: <T = unknown>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T = { ok: boolean }>(url: string) => request<T>('DELETE', url),
};

export type Role = 'submitter' | 'mentor' | 'triage' | 'committee' | 'lead' | 'implementer' | 'admin' | 'works_council' | 'controlling' | 'external' | 'user_admin';

export interface Me {
  // scopes (R3-29): roles held for some areas only, role → area IDs.
  user: { id: string; email: string; displayName: string; orgUnit: string | null; roles: Role[]; mfaEnabled: boolean; locale?: 'de' | 'en'; scopes?: Partial<Record<Role, string[]>> };
  mfaPending: boolean;
  mfaSetupRequired: boolean;
  onboarded: boolean;
  tenant: { name: string; slug: string };
  /** Signed in to the shared demo workspace. */
  demo?: boolean;
  /** 'oidc' or 'saml' after the company login (R3-26); then the identity provider handles the second factor. */
  authMethod?: 'password' | 'oidc' | 'saml';
}

export interface PublicConfig {
  signup: boolean;
  demo: boolean;
}

export interface TargetChannel {
  id: string;
  name: string;
  kind: string;
  contact: string;
  url: string;
}

export interface PublicSettings {
  topics: string[];
  targetChannels: TargetChannel[];
  deadlines: { gate1Workdays: number; elaborationWorkdays: number; reminderWorkdaysBefore: number; maxQuestionRounds: number; maxParkMonths: number };
  thresholds: { fastLaneMaxPersonDays: number; fastLaneMaxEuro: number; delegationMaxPersonDays: number; delegationMaxEuro: number };
  elaboration: {
    timeboxWeeks: number;
    mentorWarnActive: number;
    lockMinutes: number;
    meetingMaxIdeas: number;
    meetingPackWorkdays: number;
    experimentReminderWorkdays: number;
    impactReviewMonths: number;
  };
  texts: { privacyNotice: string; faq: { q: string; a: string }[] };
  lanes: Record<string, string>;
  minGroupSize: number;
  /** External participation and feature requests switched on (R3-19, R3-20). */
  external?: boolean;
  featureRequests?: boolean;
  today: string;
}

export interface IdeaListItem {
  id: string;
  number: number;
  title: string;
  topic: string | null;
  status: string;
  ideaType: 'internal' | 'product';
  /** Problem exchange (R3-31). */
  ideaKind?: 'idea' | 'problem';
  confidential: boolean;
  anonymous: boolean;
  authorName: string | null;
  supporters: number;
  comments: number;
  submittedAt: string | null;
  createdAt: string;
  /** Open answer deadline (usability review 10/2026). */
  dueOn?: string | null;
}

export interface Deadline {
  phase: 'gate1' | 'elaboration';
  dueOn: string;
  remainingWorkdays: number;
  light: 'green' | 'yellow' | 'red' | 'paused';
  paused: boolean;
}

export interface UserRef {
  id: string;
  displayName: string;
  orgUnit: string | null;
  email?: string;
}

/** Criterion of the weighted scorecard (R2-03) or a challenge jury (R2-35). */
export interface Criterion {
  id: string;
  label: string;
  question: string;
  weight: number;
  anchors: { 1: string; 3: string; 5: string };
}

export interface CustomField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select';
  options: string[];
  required: boolean;
}
