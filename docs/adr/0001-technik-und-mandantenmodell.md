# ADR 0001 – Technik und Mandantenmodell für den ersten Bau

**Status:** angenommen (12.10.2026, AP-04). Release 1 und 2 sind auf dieser Grundlage gebaut und laufen im Pilotbetrieb; Änderungen nur über eine neue ADR.

## Kontext

CLAUDE.md und Umsetzungskonzept Abschnitt 2 schlagen TypeScript oder Python, React oder Vue und PostgreSQL mit Row-Level-Security vor. Für den ersten lauffähigen Stand wurde eine Wahl getroffen, damit gebaut werden kann. Sie ist bewusst leicht änderbar.

## Entscheidung

| Baustein | Wahl | Begründung |
| --- | --- | --- |
| Server | TypeScript, Node.js 22, Fastify | Ein Sprachstack für Server und Oberfläche; schnell, wenige Abhängigkeiten |
| Oberfläche | React 19 mit Vite, eigenes CSS | Verbreitet; kein UI-Framework nötig, Barrierefreiheit selbst im Griff |
| Datenbank | PostgreSQL 16 | Row-Level-Security, `pg_trgm`, Volltextsuche; `pgvector` optional für semantische Dubletten (Abschnitt Suche und Dubletten) |
| Validierung | zod | Gleiche Regeln für API und Einstellungen |
| Tests | Vitest gegen eine echte PostgreSQL | Mandantentrennung lässt sich nur gegen die echte Datenbank prüfen |

### Mandantenmodell

- Jede mandantenbezogene Tabelle hat `tenant_id` und eine Policy `tenant_id = current_tenant()`.
- Jede Anfrage läuft in einer Transaktion mit `SET LOCAL ROLE ideenportal_app` und `set_config('app.tenant_id', …)`. Diese Rolle ist nicht Eigentümerin der Tabellen, daher greifen die Policies immer (`FORCE ROW LEVEL SECURITY` zusätzlich).
- Nur Anmeldung, Sitzungsprüfung, Hintergrundjobs und Migrationen laufen mit der Eigentümer-Verbindung.
- Das Audit-Log ist per Trigger und Rechtevergabe nur anhängbar.
- Der Test `server/test/tenant-isolation.test.ts` prüft Lesen, Schreiben und API mit zwei Mandanten.

### Jobs

Fristen, Erinnerungen, Eskalationen, Wiedervorlagen und Mailversand laufen im App-Prozess alle 15 Minuten. Eine PostgreSQL-Advisory-Sperre verhindert doppelte Ausführung bei mehreren Instanzen.

### Suche und Dubletten (Ergänzung 13.10.2026, R3-28)

Die Übergangslösung mit Trigrammen aus Release 1 ist durch folgende Entscheidung ersetzt:

- **Volltextsuche in PostgreSQL:** generierte Spalte `ideas.search_vector` mit GIN-Index, Konfiguration `german` (Wortstämme) plus `simple` (Namen, Abkürzungen); Gewichte Titel A, Problem und Lösung B, Nutzen C. Abfrage mit `websearch_to_tsquery` (Anführungszeichen, `-ausschließen`, `or`), Rangfolge mit `ts_rank`. Die Teilwortsuche (`ILIKE`, Trigramm-Index) bleibt für kurze Begriffe und Wortteile, Tippfehler fängt die Trigramm-Wortähnlichkeit auf, wenn die Volltextsuche nichts findet. Kein externer Suchdienst.
- **Cursor-Paginierung** für Ideenliste und Board: undurchsichtiger Cursor aus Sortierschlüssel und Kennung, Folgeseiten mit `(schlüssel, id) < (…)`. Ohne `limit`/`cursor` bleibt die bisherige Antwort (Liste) erhalten.
- **Semantische Dubletten mit `pgvector`, optional:** Tabelle `idea_embeddings` (je Idee ein Vektor, `tenant_id`, Row-Level-Security, Index HNSW mit Kosinus-Abstand). Die Migration 017 versucht `CREATE EXTENSION vector`; gelingt das nicht (Erweiterung nicht installiert, Datenbanknutzer ohne Recht), läuft das Portal ohne sie weiter. Ob sie da ist, prüft die App zur Laufzeit (`vectorAvailable`); ohne sie nutzt die Dublettenprüfung wie bisher die Trigramm-Ähnlichkeit. Bei jedem Start ruft die Migration `enable_vector_search()` auf; wird die Erweiterung später eingeschaltet, stellt die App die Spalte von selbst auf `vector(256)` um und baut den Index.
- **Lokales Embedding-Modell hinter einer Schnittstelle** (`server/src/search/embedding.ts`, `EmbeddingModel` mit `id`, `dim`, `embed()`): Eingebaut ist ein deterministisches Modell ohne Download (gehashte Wort- und Zeichen-Trigramm-Merkmale, 256 Dimensionen, L2-normiert). Texte verlassen den Server nicht; deshalb läuft das Embedding nicht über das KI-Gateway. Embeddings entstehen nur für eingereichte, nicht vertrauliche Ideen. Bei Textänderung löscht ein Trigger das Embedding; die nächste Dublettenprüfung (Ideen der letzten zwei Tage) oder der Hintergrundjob berechnet es neu.
- **Index je Mandant:** Eine Tabelle für alle Mandanten mit `tenant_id` und Row-Level-Security; jede Abfrage sieht nur die Vektoren des eigenen Mandanten. Der HNSW-Index ist physisch gemeinsam, liefert aber 200 Kandidaten (`hnsw.ef_search`), bevor Row-Level-Security und Sichtbarkeit filtern. Ein physisch getrennter Index je Mandant (Partitionierung nach `tenant_id`) ist erst bei sehr vielen Mandanten nötig.
- **Indizes unter Row-Level-Security:** PostgreSQL nutzt eine Bedingung nur dann als Indexbedingung, wenn ihr Operator „leakproof“ ist; `@@`, `ILIKE` und die Trigramm-Operatoren sind es nicht. Die Funktionen `search_idea_ids` und `similar_idea_ids` laufen deshalb als Eigentümer (`SECURITY DEFINER`), filtern ausdrücklich nach `current_tenant()` und geben nur Kennung und Wert zurück; die Abfrage der App verknüpft sie unter Row-Level-Security mit `ideas` und prüft die Sichtbarkeit. Test der Trennung in `server/test/search.test.ts`.

**Wechsel auf ein echtes lokales Embedding-Modell** (z. B. `intfloat/multilingual-e5-small` oder `paraphrase-multilingual-MiniLM-L12-v2` als ONNX über `onnxruntime-node` oder `@huggingface/transformers`, Modelldatei im Container, kein externer Dienst):

1. Neue Klasse, die `EmbeddingModel` umsetzt (`id` z. B. `e5-small-v1-384`, `dim` 384), beim Start mit `setEmbeddingModel()` setzen; Modell und Version in der ADR festhalten.
2. Neue Migration, die `idea_embeddings.embedding` auf `vector(<dim>)` umstellt (Inhalt leeren, Spalte ändern, HNSW-Index neu) und `enable_vector_search()` auf die neue Dimension anpasst.
3. Die Embeddings füllen sich über den Hintergrundjob neu (Modell-ID in `idea_embeddings.model`, ältere Einträge gelten als veraltet). Schwelle `SEMANTIC_THRESHOLD` in `server/src/search/similar.ts` mit dem KI-Testsatz neu einstellen.
4. Lasttest (`docs/release-3/lasttest.md`) wiederholen; das Modell braucht CPU und Speicher im App-Prozess.

## Offen

- Firmen-Login (OpenID Connect, SAML) – R1-08
- SMTP-Relay je Mandant – R1-07 (heute: Outbox mit Transport „log“)
- Betriebsumgebung intern und EU-Cloud, Backups – R1-05
