export const external = {
  'external.forbidden': 'Diese Funktion steht externen Konten nicht zur Verfügung.',
  'external.disabled': 'Externe Beteiligung ist in diesem Arbeitsbereich nicht eingeschaltet.',
  'external.linkInvalid': 'Der Link ist ungültig, oder die Challenge ist nicht mehr für Externe geöffnet.',
  'external.noAccess': 'Du nimmst an dieser Challenge nicht teil.',
  'external.challengeNotExternal': 'Die Challenge ist nicht für Externe geöffnet.',
  'external.challengeClosed': 'Die Challenge nimmt gerade keine Ideen an.',
  'external.consentRequired': 'Bitte stimme zuerst den Nutzungsbedingungen und dem Einwilligungstext der Challenge zu.',
  'external.consentChanged': 'Der Text wurde inzwischen geändert. Bitte lies die neue Fassung und stimme erneut zu.',
  'external.consentUnknown': 'Dieser Einwilligungstext ist nicht mehr gültig.',
  'external.accountExists': 'Zu dieser E-Mail-Adresse gibt es schon ein Konto. Bitte melde dich an und öffne den Link danach erneut.',
  'external.internalAccount': 'Zu dieser E-Mail-Adresse gibt es ein internes Konto. Interne Personen brauchen keine Einladung.',
  'external.spam': 'Der Beitrag wurde als Spam erkannt und nicht gespeichert.',
  'external.tooManyLinks': 'Der Beitrag enthält zu viele Links. Erlaubt sind höchstens {max}.',
  'external.invite.subject': 'Einladung zur Challenge „{challenge}“',
  'external.invite.intro': '{name} lädt dich ein, Ideen zur Challenge „{challenge}“ einzureichen. Lege hier dein Passwort fest:',
  'external.access.subject': 'Neue Challenge für dich: „{challenge}“',
  'external.access.body': 'Du kannst jetzt auch an der Challenge „{challenge}“ teilnehmen. Melde dich an: {url}',
  'external.defaultTerms':
    'Entwurf – vor dem Einsatz rechtlich prüfen und anpassen.\n\n' +
    'Nutzungsbedingungen für externe Teilnehmende\n\n' +
    '1. Das Ideenportal dient dazu, Ideen zu Challenges des Betreibers einzureichen. Es ist kein Meldekanal für Hinweise auf Rechtsverstöße.\n' +
    '2. Du reichst nur Inhalte ein, die du selbst entwickelt hast oder für die du die nötigen Rechte hast. Inhalte Dritter, Geschäftsgeheimnisse anderer Unternehmen und personenbezogene Daten Dritter reichst du nicht ein.\n' +
    '3. Welche Rechte der Betreiber an deinen Ideen erhält und wie vertraulich sie behandelt werden, regelt der Einwilligungstext der jeweiligen Challenge.\n' +
    '4. Du siehst deine eigenen Ideen und die freigegebenen Ideen anderer Teilnehmender derselben Challenge. Interne Ideen, Kommentare und Auswertungen des Betreibers siehst du nicht.\n' +
    '5. Beiträge können vor der Veröffentlichung geprüft werden. Beiträge mit Werbung, Beleidigungen oder rechtswidrigen Inhalten werden nicht veröffentlicht oder entfernt.\n' +
    '6. Es besteht kein Anspruch auf Umsetzung, Rückmeldung in bestimmter Form oder Vergütung, soweit der Einwilligungstext der Challenge nichts anderes regelt.\n' +
    '7. Du kannst dein Konto jederzeit löschen lassen. Die Datenschutzhinweise des Betreibers gelten ergänzend.',
  'external.defaultConsent':
    'Entwurf – vor dem Einsatz rechtlich prüfen und anpassen.\n\n' +
    'Einwilligung zu Nutzungsrechten und Vertraulichkeit\n\n' +
    '1. Mit dem Einreichen räumst du dem Betreiber das einfache, zeitlich und räumlich unbeschränkte Recht ein, deine Idee zu prüfen, weiterzuentwickeln und umzusetzen.\n' +
    '2. Deine Idee wird vertraulich behandelt: Sie ist nur für das Team des Betreibers und – nach Freigabe – für andere Teilnehmende dieser Challenge sichtbar, es sei denn, du markierst sie als vertraulich.\n' +
    '3. Eine Vergütung erfolgt nur, wenn sie für diese Challenge ausdrücklich zugesagt ist.\n' +
    '4. Bevor du eine Idee einreichst, die eine Erfindung sein könnte, sprich bitte mit uns. Solche Ideen werden vor jeder Veröffentlichung auf Schutzrechte geprüft (Erfindungsprüfung).',
  'external.reportExists': 'Du hast diesen Beitrag schon gemeldet.',
  'external.reportOwn': 'Eigene Beiträge kannst du nicht melden.',
  'external.reportClosed': 'Die Meldung ist schon bearbeitet.',
  'external.notPending': 'Diese Idee wartet nicht auf Freigabe.',
  'external.feature.off': 'Feature-Wünsche sind in diesem Arbeitsbereich nicht eingeschaltet.',
  'external.feature.notFound': 'Feature-Wunsch nicht gefunden.',
  'external.feature.publicOff': 'Die Status-Seite ist nicht öffentlich.',
  'external.feature.statusSubject': 'Feature-Wunsch #{number}: ',
  'external.feature.statusBody': 'Der Feature-Wunsch „{title}“ hat jetzt den Status: ',
  'external.feature.statusNote': 'Hinweis des Produktteams: {note}',
  'external.feature.status.new': 'neu',
  'external.feature.status.planned': 'geplant',
  'external.feature.status.in_progress': 'in Arbeit',
  'external.feature.status.done': 'umgesetzt',
  'external.feature.status.declined': 'abgelehnt',
} as const;
