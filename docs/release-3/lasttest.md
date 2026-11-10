# Lasttest mit 10.000 Ideen (R3-28)

Stand 13.10.2026. Der Lasttest prüft, ob Suche, Listen, Board und Dublettenprüfung mit 10.000 Ideen in einem Arbeitsbereich schnell genug bleiben. Er läuft über den ganzen Weg einer Anfrage: Fastify, Sitzung, `withTenant()` als Rolle `ideenportal_app` mit Row-Level-Security.

## Durchführen

```bash
# leere Datenbank nur für den Lasttest (nie gegen den Betrieb)
su postgres -c "psql -c 'CREATE DATABASE ideenportal_load OWNER ideenportal'"
DATABASE_URL=postgres://ideenportal:ideenportal@localhost:5432/ideenportal_load \
  MAIL_TRANSPORT=none npm run loadtest --workspace server
```

Optionen: `IDEAS=10000` (Anzahl), `RUNS=40` (Messungen je Szenario), `KEEP=1` (vorhandene Lasttest-Daten weiterverwenden). Das Skript `server/src/db/loadtest.ts` legt den Arbeitsbereich `lasttest` mit 50 Personen an (bei jedem Lauf ohne `KEEP` neu), erzeugt 10.000 Ideen mit festem Zufallsstartwert (Statusverteilung: 30 % umgesetzt, 15 % abgelehnt, 10 % weitergeleitet, 15 % eingereicht, 3 % Rückfrage, 7 % Ausarbeitung, 10 % in Umsetzung, 5 % geparkt, 5 % Entwurf; 8 % vertraulich), Fristen für offene Ideen und rund 36.500 Unterstützungen. Mit `pgvector` berechnet es vorab alle Embeddings. Danach misst es jedes Szenario nach einem Aufwärmlauf und gibt p50 und p95 aus.

## Ergebnisse

Umgebung: Entwicklungsrechner, 4 Kerne, 16 GB, PostgreSQL 16.15 lokal, Node.js 22, Standardeinstellungen von PostgreSQL. 10.000 Ideen, davon 3.820 auf dem Board. Je Szenario 40 Messungen.

| Szenario | ohne pgvector p50 / p95 (ms) | mit pgvector p50 / p95 (ms) |
| --- | ---: | ---: |
| Volltextsuche, erste Seite mit 50 Treffern nach Relevanz (12 Suchbegriffe, davon 2 mit Tippfehler) | 52 / 153 | 54 / 173 |
| Ideenliste, erste Seite (50, neueste) | 9 / 12 | 8 / 11 |
| Ideenliste, Folgeseiten 2–21 per Cursor (je Seite) | 9 / 10 | 9 / 11 |
| Ideenliste, erste Seite nach Unterstützung | 65 / 99 | 63 / 76 |
| Ideenliste ohne `limit` (bisherige Antwort, 200 Einträge) | 12 / 16 | 12 / 14 |
| Board, erste Seite (100) | 32 / 41 | 30 / 40 |
| Board vollständig (ohne `limit`, 3.820 Karten) | 171 / 207 | 164 / 218 |
| Dublettenprüfung beim Schreiben | 531 / 599 (Trigramme) | 12 / 15 (pgvector, HNSW) |

Embeddings für 8.671 Ideen (eingereicht, nicht vertraulich) berechnen und speichern: rund 21 s einmalig, danach nur geänderte Ideen.

## Bewertung

- **Listen und Board** bleiben mit Cursor-Paginierung unabhängig von der Seitentiefe bei rund 10 ms je Seite. Ohne Paginierung braucht das ganze Board knapp 0,2 s und überträgt alle Karten; die Oberfläche lädt deshalb 100 Karten und dann „Mehr laden“.
- **Volltextsuche:** typischer Suchbegriff unter 60 ms. Die langsamsten Messungen sind Tippfehler, bei denen die Volltextsuche nichts findet und die Trigramm-Suche einspringt.
- **Dublettenprüfung:** Mit `pgvector` rund 12 ms. Ohne die Erweiterung braucht die Trigramm-Ähnlichkeit gut 0,5 s, weil sie die Wortähnlichkeit für jeden Kandidaten aus dem Index nachrechnet; die Testdaten mit wenigen Vorlagen sind dafür ein ungünstiger Fall. Die Prüfung läuft verzögert beim Schreiben (400 ms nach der letzten Eingabe) und blockiert nichts. Empfehlung: ab etwa 5.000 Ideen je Arbeitsbereich `pgvector` einschalten (`docs/betrieb.md`).
- **Gefundene und behobene Engpässe:** Fehlende Indizes auf `deadlines(idea_id)` und `comments(idea_id)` (Board vorher 0,66 s für die erste Seite); Volltext- und Trigramm-Indizes wurden unter Row-Level-Security nicht genutzt, weil PostgreSQL nicht-„leakproof“-Operatoren nicht als Indexbedingung verwendet. Lösung: die Funktionen `search_idea_ids` und `similar_idea_ids` (Migration 017) filtern ausdrücklich nach dem Mandanten der Anfrage und liefern nur Kennungen; die aufrufende Abfrage verknüpft sie wieder unter Row-Level-Security. Sortierung nach Unterstützung zählt jetzt einmal je Abfrage statt je Zeile.

## Grenzen

- Ein Rechner, keine parallelen Nutzerinnen; der Test misst Antwortzeiten, nicht den Durchsatz.
- Die Ideentexte sind aus wenigen Bausteinen erzeugt; echte Texte sind vielfältiger, die Trigramm-Suche findet dann weniger Kandidaten.
- Gemessen ohne Netzlatenz zwischen App und Datenbank (bei Render zusätzlich etwa 1 ms je Abfrage).
