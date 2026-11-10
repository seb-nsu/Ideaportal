export const jobs = {
  'jobs.overdue.subject': 'Frist überschritten: #{number} „{title}“',
  'jobs.overdue.body': 'Die Frist für #{number} „{title}“ ist seit {days} Arbeitstag(en) überschritten (fällig {date}). Bitte kümmere dich um eine Entscheidung.',
  'jobs.event.escalated': 'Frist überschritten (fällig {date}), an die Leitung eskaliert.',
  'jobs.reminder.subject': 'Erinnerung: Frist für #{number} „{title}“',
  'jobs.reminder.body': 'Die Frist für #{number} „{title}“ endet in {days} Arbeitstag(en) am {date}.',
  'jobs.late.subject': 'Umsetzung im Verzug: #{number} „{title}“',
  'jobs.late.body': 'Der Zieltermin {date} für #{number} „{title}“ ist überschritten. Bitte aktualisiere Fortschritt und Zieltermin oder schließe die Umsetzung mit dem Ist-Nutzen ab.',
  'jobs.guarantee.subject': 'Antwortgarantie unterschritten: {quota} % statt {threshold} %',
  'jobs.guarantee.body': 'In den letzten 90 Tagen haben {met} von {due} Ideen innerhalb von {workdays} Arbeitstagen eine erste Rückmeldung bekommen ({quota} %). Die Schwelle liegt bei {threshold} %. Bitte prüft die offenen Ideen auf dem Board. Dieser Hinweis kommt erst wieder, wenn die Quote die Schwelle erreicht hat und erneut unterschreitet.',
} as const;
