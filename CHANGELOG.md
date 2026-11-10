# Changelog

## Unveröffentlicht

Vorbereitung auf ein öffentliches Repository (10.11.2026): ursprünglicher Entwurf (`docs/00-ausgangslage/`), alter Review vor Version 2 (`docs/04-review/`) und die veralteten PDF-Exporte der Konzepte entfernt; Namen in den Dokumenten durch die Rolle „Product Owner“ ersetzt; Aussagen zum Verhältnis mit dem Arbeitgeber neutral formuliert; Metadaten des Konzept-Foliensatzes neutral.

Englisch ohne Lücken (09.11.2026): Namen der KI-Bausteine, Anbietervorlagen, Fehler von Modellen und Websuche sowie Warnhinweise an KI-Ergebnissen kommen aus dem Textkatalog (`aigw.*`) und erscheinen in der Sprache der lesenden Person; `npm run check:texts` prüft auch `server/src/ai/`. Neuer englischer Demo-Arbeitsbereich `demo-en` (Konten `…@demo-en.example`), die Demo öffnet in der Sprache der Seite. Neue englische Arbeitsbereiche bekommen die Tonalität der KI-Texte auf Englisch. README und alle Enterprise-Unterlagen gibt es zusätzlich auf Englisch (`README.en.md`, `docs/enterprise/*.en.md`).

Weniger Verbrauch von GitHub-Actions-Minuten (01.11.2026): CI bei Push nur noch auf `main` und `staging` (sonst über den Pull Request), Secret-Scan als Schritt in „Static checks“ statt eigenem Job, CodeQL bei Pull Requests nur bei Änderungen an `server/`, `web/` oder den Paketdateien, Dependabot für GitHub Actions und Docker monatlich. Branch-Schutz anpassen: Pflicht-Checks „Secret scan“ und „Analyze (javascript-typescript)“ entfernen.

Übersichtlichere Oberfläche nach der Usability-Prüfung aus Sicht von Mitarbeitenden (22.10.2026):

- **Navigation nach Rolle:** Start, Entdecken (Ideen, Challenges, Erfolge, Wünsche), Bearbeiten (Aufgaben, Eingang, Gremium, Portfolio, Auswertungen, Moderation, Nutzen bestätigen) und Verwaltung (Einstellungen, KI-Nachweise, Mitbestimmung, Externe), je mit Unternavigation. Hilfe und Abmelden im Konto-Menü. Kennzahlen und Radar sind ein Eintrag „Auswertungen“.
- **Mobil:** Leiste unten mit Start, Bereichen, Einreichen und Konto; Rollenwechsel der Demo eingeklappt; „Ähnliche Ideen“ erst nach dem Formular und nur mit Treffer.
- **Ideenseite:** Ideengeber:innen sehen die KI-Analyse als Kurzfassung mit „Das würde deine Idee stärker machen“, den Rest aufklappbar; Hinweise zu Modell, Kosten, Prüfstatus und Stichprobe nur für Triage und Admin. Statusleiste in Klartext (Erste Prüfung, Entscheidung) für Personen ohne Prozessrolle, „Ausarbeitung“ statt „Steckbrief“. Erfindung, Dublette und Co-Autor:innen unter „Weitere Aktionen“. Übersetzen nur, wenn ein Modell übersetzen kann, und eingeklappt.
- **Startseite:** Eigene Ideen mit nächstem Schritt und Antwortfrist (`dueOn` in `GET /api/ideas`), Hinweis auf offene Aufgaben, Checkliste „Deine erste Woche“ für Ideengeber:innen; doppelter Einreichen-Knopf entfernt.
- **Einreichen:** Ideen-Coach, Foto und Spracheingabe hinter „Hilfe beim Formulieren“; Team, vertraulich, anonym und „für andere“ unter „Weitere Optionen“. „Problem melden“ heißt jetzt „Problem beschreiben“.
- **Einstellungen:** 20 Reiter in fünf Gruppen (Prozess, KI, Personen und Zugang, Anbindungen, Vertrag und Daten) mit Suche; CO₂-Faktoren, Punkte und Benchmark mit eigener Überschrift.
- **Mein Konto:** Reiter Profil und Sprache, Benachrichtigungen, Abwesenheit, Anerkennung und Daten.

## 0.4.0 – 13.10.2026

Release 3 und 4 (gebaut am 13.10.2026, Stand je Story in `docs/release-3/` und `docs/release-4/`) und Enterprise-Reife nach der Enterprise-Prüfung (Unterlagen in `docs/enterprise/`):

- **Release 3:** Firmen-Login (OIDC) und SCIM, API-Tokens, OpenAPI und Webhooks, Slack und Teams, Konnektoren Jira, ServiceNow und Azure DevOps, Suche mit pgvector, Mitbestimmung, Mehrsprachigkeit, SaaS-Betrieb mit Betreiberkonsole und Statusseite, Pakete und Abrechnung (Entwürfe), Rollen je Bereich, externe Beteiligung, Einsatzfelder, Compliance.
- **Release 4:** KI-Qualitäts-Dashboard und Import mit KI, Trendradar und Problem-Radar, Wirkung und Lernen.
- **Audit-Log:** Anmeldungen, Abmeldungen und Fehlversuche mit IP-Hash, Browserkennung und Request-ID; Hash-Kette je Mandant mit Prüfung; Filter, Seiten und Export ohne Zeilengrenze; Weiterleitung an ein SIEM.
- **Beobachtbarkeit:** `X-Request-Id`, `LOG_LEVEL`, Lauf-ID für Hintergrundjobs, Prometheus unter `/api/metrics`, Health-Checks `/api/health/live` und `/api/health/ready`.
- **Härtung:** Start in Produktion nur mit `SECRET_KEY` ab 32 Zeichen, Secure-Cookies bei https, HKDF für Schlüssel, gleiche Antwortzeit für unbekannte Konten, Passwortregeln je Mandant mit Liste häufiger Passwörter und optional HIBP, Abmeldung nach Inaktivität, Schutz vor DNS-Rebinding.
- **Mandanten:** sperren und entsperren, Löschen mit erneuter Anmeldung, Frist und Löschnachweis, vollständiger ZIP-Export im Hintergrund, Übersteuerung von Funktionen und Grenzen je Mandant.
- **Administration:** persönliche Betreiberkonten mit Rollen und Pflicht-TOTP, Rolle Personenverwaltung (`user_admin`), Import von Personen aus CSV oder Excel, Sammelaktionen.
- **SAML 2.0** als zweiter Weg für den Firmen-Login (Entra ID, Okta, ADFS).
- **KI:** Bewertung je Baustein mit festen Regeln und optionalem Prüfmodell, Testsatz Version 2 mit 90 Ideen, Prüfberichte mit Vergleich, Eval-Kommandozeile und eigener CI-Workflow, Prompt-Version je Baustein, Markierung ungeprüfter Ausweichmodelle, Trennung von Eingaben gegen Prompt-Injection, Seite „KI im Portal“ mit Modellkarten.
- **Qualität und Lieferkette:** ESLint, Prettier für neue Dateien, Testabdeckung mit Schwellen, Frontend-Tests, RLS-Wächter, Upgrade-Test, Tests für bisher ungetestete Endpunkte, gepinnte Actions, gitleaks, Trivy, SBOM, CodeQL, Dependabot, Release-Workflow mit signiertem Image, `SECURITY.md`, `GET /api/version`.

### Upgrade-Hinweise

- Mit `NODE_ENV=production` (Standard im Image) startet die App nur mit `SECRET_KEY` ab 32 Zeichen. Kürzere Schlüssel vorher rotieren (`docs/betrieb.md`, „`SECRET_KEY` wechseln“).
- Health-Check von Load Balancer oder Plattform auf `/api/health/ready` umstellen; `/api/health` zeigt ohne `METRICS_TOKEN` nur den Status.
- Betreiberkonsole: erstes persönliches Inhaberkonto anlegen (`docs/enterprise/mandanten-und-administration.md`); danach gilt `OPERATOR_TOKEN` nicht mehr.
- Das Laufzeit-Image enthält kein npm mehr; Kommandozeilen im Container mit `node server/dist/…` aufrufen.
- Migrationen 031–034 laufen beim Start; vorher sichern (`docs/enterprise/versionen-und-upgrades.md`).
- `GET /api/admin/export` (JSON) ist abgekündigt; neu ist der ZIP-Export.

## 0.3.0 – 12.10.2026

Release 0 (Dokumente) und Release 2 (Ausarbeitung und KI-Analyse):

- Release 0: Nutzerwege, Navigation, Bildschirme, Benachrichtigungen, Textvorlagen, Barrierefreiheit; Pilotbereich, Scorecard, Schwellen, Einführungsplan; ADRs zu Anmeldung, Job-Queue, KI-Gateway und Suchanbieter, Datenfluss und Bedrohungsmodell; Entwurf DSFA, Verarbeitungsverzeichnis, Rechtsgrundlagen; KI-Testsatz mit 32 Ideen; Finanzmodell, Gesprächsleitfaden, Vertragsgrundlagen.
- Ausarbeitung: Pate und Timebox, gemeinsamer Steckbrief mit Sperre und Verlauf, gewichtete Scorecard, Gremiumssitzungen, delegierte Entscheidung, Experimente, Wirkungsreview, Portfolio-Board.
- Challenges mit eigenen Feldern, Teams, Jury und Rangliste; Erfolgsseite und Urkunde.
- KI-Gateway: Anbieter und Modell je Aufgabe und Baustein einstellbar (eingebaut, Anthropic, OpenAI-kompatibel), verschlüsselte Schlüssel, Kostenlimits, Protokoll, Qualitätsprüfung mit Testsatz und Freigabe, Schutz vor Prompt-Injection, anonymisierte Websuche.
- KI-Bausteine: Ideen-Coach, Sprache und Foto, Abgrenzung, Kurzanalyse, Triage-Vorschlag, Rückmeldung, Diskussionszusammenfassung, Wettbewerb, Patente, Positionierung, Marktgröße, interne Marktanalyse, Business Case, Risiko-Check, Experiment, Steckbrief-Entwurf, Gate-2-Vorlage, Gegenargumente, Challenge-Vorschläge, Erfolgsgeschichte.

## 0.2.0 – 12.10.2026

Pilotbetrieb als Capstone-Produkt, ohne Firmen-Login:

- Landingpage, Selbstregistrierung eines Arbeitsbereichs mit Beispielidee und erster Challenge, Einladungslink, öffentliche Demo mit Rollenwechsel, Anmeldung nur mit E-Mail und Passwort.
- Abwesenheit und Vertretung, einstellbare Benachrichtigungen mit Tageszusammenfassung, SMTP-Versand.
- Co-Autor:innen, Ideen zusammenführen, Anhänge mit Inhaltsprüfung und optionalem Virenscan.
- Import bestehender Ideen aus CSV und Excel mit Vorschau und Spaltenzuordnung.
- Löschfristen, Auskunft je Person, Anonymisieren, Arbeitsbereich löschen.
- Seite „Mein Konto“; Browser-Test mit Barrierefreiheitsprüfung in der CI; Deployment-Vorlage `render.yaml`.

## 0.1.0 – 12.10.2026

Erster lauffähiger Bau der Release-1-Kernstrecke: Einreichen mit Abgrenzungsprüfung, ähnliche Ideen, Community, Triage mit Fristen in Arbeitstagen, Rückfrage, Weiterleiten, Gate 2, Umsetzung mit Ist-Nutzen, Challenges, Dashboard, Einstellungen je Mandant, eigene Konten mit Zwei-Faktor-Anmeldung, Audit-Log, Datenexport und Mandantentrennung per Row-Level-Security. Stand je Story: `docs/release-1/umsetzungsstand.md`.
