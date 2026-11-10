# Mobile Kernaufgaben und Prüfplan Barrierefreiheit

Stand 12.10.2026 · Release 0 · Entwurf · Bezug: R1-12, R1-16, R1-21, R1-27, R1-42, R2-17

## Mobile Kernaufgaben

Diese Aufgaben müssen auf einem Smartphone (ab 360 px Breite, Touch, ohne Zoom) vollständig gehen. Alles andere darf mobil eingeschränkt sein.

| Nr. | Aufgabe | Rolle | Bildschirm | Release | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| M1 | Idee einreichen (4 Schritte, Entwurf speichern) | alle | `/einreichen` | 1 | in < 5 Min.; Tastatur verdeckt keine Knöpfe |
| M2 | Status, Restfrist und Verlauf sehen | alle | `/ideen/:id` | 1 | Statusleiste lesbar ohne Querformat |
| M3 | Rückfrage beantworten | Ideengebende | `/aufgaben`, `/ideen/:id` | 1 | aus der Mail mit einem Tipp erreichbar |
| M4 | Kommentieren und unterstützen | alle | `/ideen/:id` | 1 | Zielgröße Knöpfe ≥ 44 × 44 px |
| M5 | Benachrichtigungen lesen | alle | Glocke | 1 | Liste scrollt, Links führen zur Idee |
| M6 | Zufriedenheit bewerten | Ideengebende | `/ideen/:id` | 1 | Ein Tipp |
| M7 | Umsetzung: Fortschritt aktualisieren | Owner | `/aufgaben` | 1 | Prozent und Zieltermin |
| M8 | Per Sprache oder Foto einreichen | alle | `/einreichen` | 2 | Transkript als Vorschlag, editierbar |
| M9 | KI-Kurzanalyse lesen | Triage, Pate | `/ideen/:id` | 2 | Zusammenfassung zuerst, Details aufklappbar |

Nicht mobil optimiert (bewusst): Board mit vielen Spalten (mobil als Reiter), Steckbrief-Bearbeitung, Gremium-Vergleich, Einstellungen, Import.

## Zielniveau

**WCAG 2.1 Stufe AA** für alle Seiten. Für Kunden aus dem öffentlichen Sektor zusätzlich BITV 2.0 im Blick behalten (entspricht im Kern EN 301 549 / WCAG 2.1 AA). Ab dem 28.06.2025 gilt in Deutschland das Barrierefreiheitsstärkungsgesetz für bestimmte Produkte und Dienstleistungen an Verbraucher; ob es für ein B2B-Ideenportal greift, ist rechtlich zu prüfen (keine Rechtsberatung).

## Prüfplan

| Ebene | Was | Wie | Wann | Verantwortlich | Stand |
| --- | --- | --- | --- | --- | --- |
| 1 Automatisch | axe-core-Regeln WCAG 2.0/2.1 A und AA auf allen Hauptseiten | `e2e/smoke.mjs` (Playwright + axe) in der CI, Job `e2e`; Build schlägt bei Befund fehl | jeder Commit | Entwicklung | **läuft**, ohne Befund (Umsetzungsstand R1-42) |
| 2 Komponenten | Formularfelder mit Label und Hinweis, Fehlermeldungen mit `aria-describedby`, Dialoge mit Fokusfalle | Code-Review-Checkliste, Komponente `Field` | je Story | Entwicklung | teilweise |
| 3 Tastatur | Kernstrecke nur mit Tastatur | manuell, Checkliste unten | je Release | UX / Fachpate | offen |
| 4 Screenreader | Kernstrecke mit NVDA + Firefox (Windows) und VoiceOver + Safari (iOS) | manuell, Checkliste unten | je Release | UX, möglichst mit betroffener Person | **offen** |
| 5 Zoom und Kontrast | 200 % Zoom und 320 px Reflow; Kontrast ≥ 4,5 : 1 (Text), 3 : 1 (Bedienelemente) | manuell + Kontrastprüfer; Reflow 320 px und Sprunglink zusätzlich automatisch in `e2e/smoke.mjs` (AP-05) | je Release | UX | Reflow automatisch ohne Befund (zwei Befunde mit AP-05 behoben: Kopfzeile und Tabelle auf „Hilfe“ liefen bei 320 px über); manuell offen |
| 6 Externe Prüfung | BITV-Test oder vergleichbarer Audit | Dienstleister | vor Marktstart (Release 3) | Product Owner | geplant |

**Offen (Product Owner):** Person mit Screenreader-Erfahrung für Ebene 4 gewinnen (intern oder über den Pilotkunden).

### Kernstrecke für manuelle Tests

1. Landingpage → Arbeitsbereich anlegen → MFA einrichten
2. Anmelden → Idee einreichen (alle 4 Schritte, Anhang, Abgrenzungsdialog)
3. Idee öffnen → Status, Restfrist und Verlauf vorlesen lassen
4. Rückfrage beantworten → Zufriedenheit bewerten
5. Triage: Board → Idee → Spur wählen mit Begründung
6. Gate 2: Entscheidung erfassen
7. Release 2: Steckbrief lesen, KI-Aussage korrigieren, Scorecard ausfüllen
8. Phase 1: Gate-2-Vorlage lesen und einer Kennzahl zur Grundlage folgen; Dashboard-Durchlaufzeiten (Diagramm und Tabellenalternative); KI-Nachweis als PDF laden

### Checkliste Tastatur

- [ ] „Zum Inhalt springen“ ist erster Tab-Stopp und springt zu `#inhalt`
- [ ] Fokus immer sichtbar (mind. 2 px, Kontrast 3 : 1)
- [ ] Reihenfolge folgt der Lesereihenfolge; keine Tastaturfallen außer in modalen Dialogen
- [ ] Dialoge: Fokus beim Öffnen in den Dialog, `Esc` schließt, Fokus kehrt zurück
- [ ] Reiter (Einstellungen) mit Pfeiltasten, `role="tab"` und `aria-selected`
- [ ] Bewertung 1–5 (Zufriedenheit, Scorecard) mit Pfeiltasten bedienbar
- [ ] Aufklappbare KI-Abschnitte mit `Enter`/`Leertaste`, Zustand `aria-expanded`

### Checkliste Screenreader

- [ ] Seitentitel und eine `h1` je Seite; Überschriften ohne Sprünge
- [ ] Statusleiste als Liste mit aktuellem Schritt (`aria-current="step"`)
- [ ] Fristen-Ampel hat Text, nicht nur Farbe („überfällig“, „noch 2 Arbeitstage“)
- [ ] Neue Benachrichtigungen und Speichermeldungen über `aria-live="polite"`
- [ ] Ähnliche Ideen werden beim Tippen angekündigt, ohne zu unterbrechen
- [ ] KI-Kennzeichnung („KI-Entwurf“, „Beleg“, „Schätzung“) ist Teil des vorgelesenen Texts, nicht nur ein Symbol
- [ ] Tabellen (Dashboard, Gremium-Vergleich) mit `th` und `scope`
- [ ] Diagramme im Dashboard haben eine Tabellenalternative

### Befunde dokumentieren

Je Befund: Seite, WCAG-Kriterium (z. B. 1.4.3), Schweregrad, Story-ID, Screenshot. Kritische Befunde blockieren das Release (Definition of Done).

### Checkliste Zoom, Reflow und Kontrast

- [ ] Browser-Zoom 200 %: alle Inhalte der Kernstrecke lesbar, nichts abgeschnitten, keine überlappenden Texte
- [ ] 320 px Breite (oder 1280 px bei 400 % Zoom): kein waagerechtes Scrollen der Seite; breite Tabellen scrollen in ihrem eigenen Bereich
- [ ] Textabstände nach WCAG 1.4.12 (Zeilenhöhe 1,5, Absatz 2×, Buchstaben 0,12, Wörter 0,16) mit Bookmarklet: nichts geht verloren
- [ ] Kontrast Text ≥ 4,5 : 1, große Schrift und Bedienelemente ≥ 3 : 1, auch im dunklen Modus
- [ ] Ampeln, KI-Kennzeichnung und Diagramme sind ohne Farbe verständlich (Text oder Muster)
- [ ] Fokusrahmen bei 200 % sichtbar und nicht verdeckt (z. B. durch die Kopfzeile)

### Protokoll der manuellen Prüfung (AP-05, auszufüllen)

| Datum | Prüfende Person | Ebene | Gerät, Browser, Hilfsmittel | Kernstrecke Schritt | Ergebnis | Befund (WCAG-Kriterium, Schweregrad, Story) |
| --- | --- | --- | --- | --- | --- | --- |
| | | 3 Tastatur | | 1–8 | | |
| | | 4 Screenreader | NVDA + Firefox | 1–8 | | |
| | | 4 Screenreader | VoiceOver + Safari (iOS) | 2–4 | | |
| | | 5 Zoom und Kontrast | | 1–8 | | |

R1-42 gilt als abgeschlossen, wenn alle vier Zeilen ohne kritischen Befund ausgefüllt sind (Exit-Kriterium Phase 1: Screenreader-Test der Kernstrecke ohne Blocker).
