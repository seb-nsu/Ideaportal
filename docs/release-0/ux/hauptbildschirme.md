# Skizzen der Hauptbildschirme

Stand 12.10.2026 · Release 0 · Entwurf, Skizzen 1, 3, 4, 5 und 6 an den gebauten Stand nach AP-07 angeglichen

Strukturierte Wireframes als Textskizzen. Release-1-Bildschirme beschreiben den gebauten Stand (`web/src/pages/`), Release-2-Bildschirme sind Vorgaben für den Bau. Breite Ansicht links, mobile Abweichungen jeweils darunter.

Legende: `[Knopf]` · `( )` Auswahl · `▸` aufklappbar · `▮▮▮▯` Fortschritt · `🟢🟡🔴` stehen für die Fristen-Ampel (im Produkt mit Text, nicht nur Farbe).

## 1 Startseite `/` (Release 1)

```
┌───────────────────────────────────────────────────────────────────────┐
│ Ideenportal · <Arbeitsbereich>   Start Ideen Challenges Meine Aufgaben  │
│                                  Board Dashboard Einstellungen Hilfe    │
│                                [Idee einreichen] 🔔 [Mein Konto] [Abm.] │
├───────────────────────────────────────────────────────────────────────┤
│ Hallo Lea                                                               │
│ ┌ Unsere Antwortgarantie (R1-46) ─────────────────────────────────────┐ │
│ │ Jede Idee bekommt innerhalb von 10 Arbeitstagen eine erste Rückmeldung│ │
│ │ 93,3 % [eingehalten] · 28 von 30 Ideen der letzten 90 Tage rechtzeitig│ │
│ │ 3 Ideen sind noch innerhalb der Frist.                               │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌ Aktive Challenges ───────────────┐ ┌ Meine Ideen ───────────────────┐ │
│ │ „Weniger Papier im Büro“ bis 30.11│ │ #42 Raumbuchung   Neu · 6 AT ⏱ │ │
│ │ [Idee zur Challenge]              │ │ #37 Checkliste    Schnellspur  │ │
│ └───────────────────────────────────┘ └────────────────────────────────┘ │
│ ┌ Neue Ideen (Filter: Themenfeld ▾ Status ▾  Suche …) ────────────────┐ │
│ │ #45 Abwärme nutzen · Nachhaltigkeit · 3 Unterstützungen · 2 Komm.   │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌ Erfolge ────────────────────────────────────────────────────────────┐ │
│ │ #12 Bestellfreigabe bis 500 € – 120 h/Jahr gespart                   │ │
└───────────────────────────────────────────────────────────────────────┘
```

Mobil: eine Spalte in der Reihenfolge Antwortgarantie → Challenges → Meine Ideen → Neue Ideen → Erfolge. Ein fester Knopf „Idee einreichen“ unten ist nicht gebaut; der Knopf steht oben in der Kopfzeile.

Antwortgarantie: abschaltbar unter Einstellungen › Prozess; „unter dem Ziel“ (gelb), wenn die Quote die Hinweisschwelle unterschreitet. Als Rückmeldung zählen Entscheidung an Gate 1, Rückfrage oder Zusammenführen; Ideen innerhalb der Frist zählen noch nicht. Leere Liste „Meine Ideen“: „Nächster Schritt: Reiche deine erste Idee ein.“ `[Erste Idee einreichen]` (R2-48).

## 2 Einreichung `/einreichen` (Release 1, R2 mit Coach)

```
┌ Idee einreichen ─────────────────────── Schritt ①──②──③──④ ─┐
│ ① Worum geht es?  Titel [__________________]                   │
│ ② Problem  „Welches Problem siehst du?“  [Textfeld] Hilfetext   │
│ ③ Idee     „Deine Idee“                   [Textfeld]            │
│    Nutzen  „Welchen Nutzen erwartest du?“ [Textfeld]            │
│ ④ Themenfeld [▾]  Art: ( ) intern  ( ) Produkt/Kunde            │
│    Challenge (optional) [▾]   ☐ vertraulich  ☐ anonym           │
│    Anhänge (bis 10 MB)  Co-Autor:innen  Ideengeber:in (delegiert)│
│ ┌ Ähnliche Ideen ───────────────────────────────┐               │
│ │ #31 Ungenutzte Buchungen löschen [ansehen] [anschließen] │     │
│ └───────────────────────────────────────────────┘               │
│ [Entwurf speichern]                           [Weiter] / [Absenden]│
└───────────────────────────────────────────────────────────────┘
Dialog beim Absenden: „Das ist eine Idee, keine Meldung.“ ☐ bestätigt
  Bei Treffer: „Dein Text klingt nach <Beschwerde>. Zuständig ist: <Kanal, Kontakt, Link>.“
  [Trotzdem als Idee einreichen]  [Abbrechen – nichts wird gespeichert]
```

Release 2: Umschalter `( ) Formular  ( ) Im Dialog mit dem Ideen-Coach` (R2-16); der Coach füllt die Felder, Originaltext bleibt erhalten. Mikrofon- und Kamera-Knopf (R2-17) nur mobil sichtbar.

## 3 Idee mit Status `/ideen/:id` (Release 1 + 2)

```
┌ #42 Besprechungsräume mit Check-in freigeben ───────────────────────┐
│ Eingereicht ━━● Gate 1: Triage ─── Gate 2 ─── Umgesetzt             │
│ Status: Eingereicht – wartet auf Triage · Frist 26.10. (noch 6 AT)   │
│ Nächster Schritt: Das Triage-Team entscheidet innerhalb der Frist.   │
├──────────────────────────────────────────────────────────────────────┤
│ Problem … │ Idee … │ Erwarteter Nutzen …                              │
│ ▸ KI-Kurzanalyse  [KI-Entwurf · geprüft: nein]  (bis Gate 1)  (R2)  │
│    Zusammenfassung (3 Sätze)                                         │
│    Lösungen am Markt: A, B, C   [Beleg] Quelle · abgerufen 12.10.    │
│    Hebel: 40 Räume × … [Schätzung · Konfidenz mittel]                │
│    Empfehlung: Ausarbeiten  [Annahme]                                │
├ Gate 1: Triage (nur Triage) ─────────────────────────────────────────┤
│ Spur: (Schnellspur) (Ausarbeiten) (Weiterleiten) (Ablehnen)          │
│ KI-Vorschlag: Ausarbeiten · Konfidenz 0,7 · Begründung ▸  (R2-18)     │
│ Nachricht an die Ideengeberin [Vorlage ▾] [KI-Entwurf]  [Entscheiden]│
│ [Rückfrage stellen]  [Zusammenführen]                                │
├ Verlauf ──────────────────────────────────────────────────────────── │
│ 12.10. eingereicht · 13.10. Kurzanalyse erstellt (KI)                │
├ Diskussion (3) ─── [Unterstützen ♥ 5] ───────────────────────────────┤
```

Ab der Ausarbeitung (gebaut, R2-47) ersetzt die Seite die KI-Analysen durch die Eckdaten und eine Steckbrief-Karte:

```
├ Ausarbeitung ── Pate: Pat Pate · Timebox bis 24.11. (noch 30 AT) · Aufwand · Plan-Nutzen ┤
├ Steckbrief ─────────────────────────────────────────── [Steckbrief öffnen] ┤
│ 4 von 7 Abschnitten ausgefüllt · 1 offener Punkt                           │
│ Zusammenfassung · Analysen · Scorecard · Experimente · Wirkung (Links)    │
```

## 4 Triage-Board `/board` (Release 1)

```
┌ Board ── Filter: Themenfeld ▾  nur meine ☐ ─────────────────────────────┐
│ Neu (7)          │ Rückfrage (2)   │ Ausarbeitung (4) │ Umsetzung (5)    │
│ 🔴 #40 überfällig │ ⏸ #38 pausiert  │ 🟡 #29 Gate 2 in │ #22 70 % ▮▮▮▯    │
│ 🟡 #41 noch 2 AT  │                 │   8 AT           │                  │
│ 🟢 #42 noch 6 AT  │                 │                  │                  │
└──────────────────────────────────────────────────────────────────────────┘
```

Sortierung nach Frist; Ampel mit Text („überfällig“, „noch 2 AT“). Mobil (gebaut): Spalten untereinander; Spalten als Reiter sind nicht gebaut.

Erster Aufruf (R2-48, Triage und Admin): Dialog mit drei Schritten – Ampel, vier Spuren, KI-Vorschläge – mit `[Überspringen]` `[Weiter]` `[Los geht’s]`; wird je Person gemerkt. Leeres Board: Hinweis, nächster Schritt und Knopf (Triage: `[Challenge anlegen]`, Admin: `[Import und Einladung]`).

## 5 Steckbrief mit Analysen `/ideen/:id/steckbrief/:reiter` (Release 2, gebaut mit R2-47)

Gebauter Stand: eigene Seite mit Reitern (WAI-ARIA-Tabs: Pfeiltasten, Pos1/Ende, ein Tab-Stopp), jeder Reiter mit eigener Adresse.

```
┌ ← Zur Idee #29 ─────────────────────────────────────────────────────────┐
│ Steckbrief: Raum-Check-in            [Ausarbeitung]                      │
│ Zusammenfassung │ Analysen │ Scorecard │ Experimente │ Wirkung            │
│ ─────────────── (Kurztext, was der Reiter enthält)                       │
│ Zusammenfassung: Eckdaten (Pate, Timebox, Horizont, Aufwand, Plan-Nutzen) │
│                  + Abschnitte mit Sperre, Verlauf, offenen Punkten        │
│ Analysen:        KI-Analysen wie bisher (aufklappbar, gekennzeichnet)    │
│ Scorecard:       Durchschnitt ab Mindestzahl, eigene Bewertung            │
│ Experimente:     Liste, [Experiment anlegen], Ergebnis erfassen          │
│ Wirkung:         Wirkungsreview und Erfolgsgeschichte (nach Abschluss)   │
└──────────────────────────────────────────────────────────────────────────┘
```

Mobil: Reiter brechen in zwei bis drei Zeilen um; Inhalte einspaltig, ohne waagerechtes Scrollen bei 320 px. Erster Aufruf für Pate und Sponsor (R2-48): drei Schritte zu Reitern, Abschnitten mit Sperre, Timebox und Gate 2.

Ursprüngliche Skizze (Inhalte gelten weiter, die Anordnung folgt den Reitern):

```
┌ Steckbrief #29 · Patin: A. Weber · Timebox bis 24.11. (noch 23 AT) ─────┐
│ Zusammenfassung (1 Seite, KI-Entwurf, von Patin geprüft ☐)               │
│ Empfehlung: Kaufen · Score 3,8 · Business Case: Amortisation 14–20 Mon.  │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ Nutzen          ✎ bearbeitet von Lea (gesperrt bis 10:42)              │
│ ▸ Aufwand         ▸ Risiken   ▸ Betroffene   ▸ Umsetzungsweg             │
│ ▸ Wettbewerb und Lösungen  (Matrix: Anbieter × Funktionen, Preise)       │
│ ▸ Markt  (Produkt: TAM/SAM/SOM als Spanne · intern: Hebel, Preise)       │
│ ▸ Patente und Stand der Technik  „Hinweis, keine Freigabe“               │
│ ▸ Kaufen, bauen oder Prozess ändern (Positionierungskarte)               │
│ ▸ Business Case (3 Szenarien, Annahmen editierbar)                       │
│ ▸ Risiko- und Compliance-Check (Ampel, zuständige Fachstelle)            │
│ ▸ Experiment-Vorschlag [als Experiment übernehmen]                       │
│ Jede Aussage: [Beleg|Annahme|Schätzung] [korrigieren] [verwerfen]         │
├ Scorecard ── 5 Kriterien × 1–5, Anker per Tooltip ── Gesamt 3,8 ─────────┤
│ [Zur Entscheidung an Gate 2 vorlegen]                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

## 6 Gremiumsansicht `/gremium/:id` (Release 2)

```
┌ Sitzung 18.11. · Agenda 4/5 · Unterlagen versendet 11.11. ──────────────┐
│ Vergleich  │ #29 Raum-Check-in │ #33 OCR-Rechnungen │ #35 Abwärme │ …  │
│ Score      │ 3,8               │ 4,1                │ 3,5         │    │
│ Nutzen/Jahr│ 15–25 T€ [Schätz.]│ 40–60 T€ [Beleg]   │ 30 T€ [Sch.]│    │
│ Aufwand    │ 10–15 PT          │ 30 PT + Lizenz     │ 80 T€ Inv.  │    │
│ Gegenarg.  │ ▸ 3               │ ▸ 4                │ ▸ 3         │    │
├──────────────────────────────────────────────────────────────────────────┤
│ Entscheidung #29: (Umsetzen)(Erproben)(Integrieren)(Parken ≤6 M.)(Ablehnen)│
│ Owner [▾]  Zieltermin [ ]  Begründung [Pflicht]  [Entscheidung speichern] │
└──────────────────────────────────────────────────────────────────────────┘
```

Gate-2-Vorlage (gebaut): Der Titel jeder Idee führt auf den Reiter „Analysen“ des Steckbriefs; Kennzahlen verlinken auf den Reiter, aus dem sie stammen (Zusammenfassung, Analysen, Scorecard). Erster Aufruf für das Gremium (R2-48): drei Schritte – Sitzungen, Vorlage lesen, Entscheidung mit Begründung. Leere Sitzungsliste: Triage `[Ideen in Ausarbeitung]`, Gremium `[Zum Portfolio]`.

## 7 Dashboard `/dashboard` (Release 1)

```
┌ Dashboard ── Zeitraum ▾  Bereich ▾ ── [CSV] ──────────────────────────────┐
│ Eingereichte Ideen 48 │ Fristtreue Gate 1 86 % │ Ø Tage bis Gate 1 7,2   │
│ Realisierungsquote 31 % │ Zufriedenheit 4,2 / 5                            │
│ Ideenfluss (Balken je Status) │ Ist-Nutzen je Nutzenart                   │
│ Nach Bereich: Bereiche unter 5 Personen → „Weitere Bereiche“              │
└──────────────────────────────────────────────────────────────────────────┘
```

## 8 KI-Einstellungen `/einstellungen` → Reiter KI (Release 2)

```
┌ KI ── ☑ KI eingeschaltet ───────────────────────────────────────────────┐
│ Anbieter: Eingebaut (lokal) · Anthropic (other, Schlüssel ●●●● gesetzt)  │
│          [Anbieter hinzufügen ▾ Anthropic | Mistral EU | Ollama | eigener]│
│ Modelle je Aufgabe: schnell [claude-haiku-5-5] tief [claude-opus-5-5]    │
│   vertraulich [nur lokale Anbieter ▾]  Bild [..] Sprache [..]            │
│ Budget: je Idee [5 €]  je Monat [200 €]  Verbrauch Oktober 37 € ▮▯▯▯     │
│ Websuche: (keine)(Brave)(SearXNG)  Kosten/Anfrage 0,005 €  Monat 20 €    │
│ Interne Begriffe (werden vor der Suche entfernt) [Liste]                 │
│ Agenten: Kurzanalyse ● freigegeben (0,86 ≥ 0,80) · Triage-Vorschlag ○    │
│   nicht freigegeben (0,52 < 0,60) [Testsatz laufen lassen] [Freigabe …]  │
└──────────────────────────────────────────────────────────────────────────┘
```

## 9 Meine Aufgaben `/aufgaben` (gebaut, R2-48)

Oben die Checkliste „Deine erste Woche“: drei Punkte je Rolle (Admin, Triage, Gremium, Pate, Ideengebende) plus „Mein Konto“ und „Hilfe“, jeweils mit Häkchen und Link „öffnen“; `[Checkliste ausblenden]`, „Erste Schritte der Bildschirme erneut zeigen“. Gespeichert je Person auf dem Server. Ohne Aufgaben: Leerzustand mit nächstem Schritt und Knopf je Rolle.

**Offen (Product Owner):** Skizzen 6 und 8 mit UX im Klicktest (AP-05) prüfen. Mobiles Menü (Review P-06) erst nach dem Klicktest.
