// Sicherheit und Beobachtbarkeit: Passwortregeln, Leerlauf-Abmeldung, Protokoll-Export, SIEM.
export const security = {
  'security.password.tooShort': 'Das Passwort muss mindestens {min} Zeichen lang sein.',
  'security.password.tooLong': 'Das Passwort darf höchstens {max} Zeichen lang sein.',
  'security.password.common': 'Dieses Passwort ist zu verbreitet. Bitte wähle ein anderes.',
  'security.password.personal': 'Das Passwort darf nicht deine E-Mail-Adresse oder den Namen des Arbeitsbereichs enthalten.',
  'security.password.breached': 'Dieses Passwort ist aus Datenlecks bekannt. Bitte wähle ein anderes.',
  'security.idleMin': 'Die Abmeldung bei Inaktivität ist aus (0) oder dauert mindestens 5 Minuten.',
  'security.siem.notFound': 'Es ist kein SIEM-Ziel eingerichtet.',
  'security.siem.failingSubject': 'Weiterleitung des Protokolls an das SIEM schlägt fehl',
  'security.siem.failingBody':
    'Die Weiterleitung an {host} ist {n}-mal nacheinander fehlgeschlagen. Es geht nichts verloren: Das Portal versucht es weiter. Bitte prüfe das Ziel unter Verwaltung › Sicherheit.',
  'security.auditCsv.seq': 'Nr. in der Kette',
  'security.auditCsv.email': 'E-Mail',
  'security.auditCsv.ipHash': 'Adresse (Hash)',
  'security.auditCsv.userAgent': 'Browser',
  'security.auditCsv.requestId': 'Anfrage-ID',
  'security.auditCsv.rowHash': 'Prüfsumme',
} as const;
