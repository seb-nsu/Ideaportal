export const learning = {
  // Metrics before and after (R4-04)
  'learning.metric.notFound': 'Die Kennzahl wurde nicht gefunden.',
  'learning.metric.defineOnlyGate2': 'Kennzahlen werden an Gate 2 festgelegt: solange die Idee in Ausarbeitung ist, von Pate, Einreichenden, Triage-Team oder Gremium.',
  'learning.metric.connectorNeeded': 'Für eine Messung über einen Konnektor braucht es den Konnektor und die Abfrage.',
  'learning.metric.period': 'Das Ende des Zeitraums liegt vor dem Anfang.',
  'learning.metric.periodLong': 'Der Vergleichszeitraum darf höchstens ein Jahr lang sein.',
  'learning.metric.recordForbidden': 'Werte erfassen können das Triage-Team, der Pate, die für die Umsetzung verantwortliche Person und API-Tokens mit der Rolle Umsetzung, Triage oder Administration.',
  'learning.metric.fromConnector': 'Die Werte dieser Kennzahl kommen aus dem Konnektor und werden automatisch gemessen.',
  'learning.metric.notConnector': 'Diese Kennzahl wird nicht über einen Konnektor gemessen.',
  'learning.event.defined': 'Kennzahl für den Vorher-nachher-Vergleich festgelegt: {name} ({unit}).',
  // Report draft for Gate 3 (R4-04)
  'learning.report.heading': 'Entwurf Wirkungsbericht für #{number} „{title}“',
  'learning.report.noMetric': 'An Gate 2 wurde keine Kennzahl festgelegt.',
  'learning.report.metric': 'Kennzahl: {name} ({unit})',
  'learning.report.baseline': '- Vorher: {value} {unit} (Zeitraum {from} bis {to})',
  'learning.report.baselineMissing': '- Vorher: noch kein Wert gemessen',
  'learning.report.after': '- Nachher: {value} {unit} (Zeitraum {from} bis {to})',
  'learning.report.afterMissing': '- Nachher: noch kein Wert gemessen',
  'learning.report.change.better': '- Veränderung: {change} {unit} ({percent} %), in die gewünschte Richtung',
  'learning.report.change.worse': '- Veränderung: {change} {unit} ({percent} %), entgegen der gewünschten Richtung',
  'learning.report.change.same': '- Veränderung: keine',
  'learning.report.benefit': 'Nutzen in Euro: geplant {plan}, Ist {actual}.',
  'learning.report.band': 'Frühere Prognosen desselben Ideentyps: Ist-Nutzen meist zwischen {low} % und {high} % der Prognose ({n} abgeschlossene Ideen).',
  'learning.report.bandMissing': 'Trefferband früherer Prognosen: noch nicht genug abgeschlossene Ideen.',
  'learning.report.footer': 'Entwurf aus den gemessenen Werten. Bewertung und Empfehlung trifft die prüfende Person.',
  // Effort estimate (R4-06)
  'learning.effort.forbidden': 'Die Aufwandsschätzung sehen Pate, Triage-Team, Gremium und Bereichsleitungen.',
} as const;
