// SaaS operations (AP-17): settings version (R3-41), operator console and support access (R3-07), status page (R3-10).
export const saas = {
  'saas.settingsConflict': 'Die Einstellungen wurden inzwischen von jemand anderem geändert. Die aktuelle Fassung ist geladen; trage deine Änderung bitte erneut ein.',
  'saas.settingsVersionInvalid': 'Die Versionsangabe (If-Match) ist ungültig.',
  'saas.operatorDisabled': 'Die Betreiberkonsole ist nicht eingerichtet.',
  'saas.operatorUnauthenticated': 'Bitte melde dich an der Betreiberkonsole an.',
  'saas.operatorLoginFailed': 'Zugangsschlüssel oder Code ist falsch.',
  'saas.slugTaken': 'Diese Kurzbezeichnung ist bereits vergeben.',
  'saas.tenantNotFound': 'Arbeitsbereich nicht gefunden.',
  'saas.supportNoGrant': 'Der Arbeitsbereich hat keinen Support-Zugriff freigegeben.',
  'saas.incidentNotFound': 'Meldung nicht gefunden.',
  'saas.invite.subject': 'Dein Arbeitsbereich im Ideenportal ist eingerichtet',
  'saas.invite.intro': 'Der Arbeitsbereich „{workspace}“ ist für dich eingerichtet. Du bist dort Admin. Mit diesem Link legst du dein Passwort fest (24 Stunden gültig):',
} as const;
