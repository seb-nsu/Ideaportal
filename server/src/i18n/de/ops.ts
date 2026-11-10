export const ops = {
  'ops.jobsStale': 'Hintergrundregeln (Fristen, Erinnerungen, Mails) liefen seit {minutes} Minuten nicht.',
  'ops.jobsFailed': 'Der letzte Lauf der Hintergrundregeln ist fehlgeschlagen.',
  'ops.aiQueue': 'KI-Warteschlange: {count} Aufträge warten (Schwelle {max}).',
  'ops.aiOldest': 'Ältester KI-Auftrag wartet seit {minutes} Minuten.',
  'ops.outboxBacklog': 'Mail-Rückstau: {count} Mails warten (Schwelle {max}).',
  'ops.outboxOldest': 'Älteste Mail wartet seit {minutes} Minuten auf den Versand.',
  'ops.subjectRaised': '[Ideenportal] Alarm',
  'ops.subjectCleared': '[Ideenportal] Entwarnung',
  'ops.raisedText': 'Ideenportal: {alerts} Details: {url}',
  'ops.clearedText': 'Ideenportal: wieder normal ({keys}).',
} as const;
