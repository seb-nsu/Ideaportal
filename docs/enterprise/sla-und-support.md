# Service Level und Support

Deutsch | [English](sla-und-support.en.md)

Kundenfassung der Zusagen für den SaaS-Betrieb. Grundlage: SLA-Vorschlag in [`../release-0/business/vertragsgrundlagen.md`](../release-0/business/vertragsgrundlagen.md) (Abschnitt 4) und Störungsprozess im [Betriebshandbuch](../release-0/technik/betriebshandbuch.md) (Abschnitt 5). **Stand: Vorschlag, vom Product Owner vor Vertragsabschluss zu bestätigen.** Keine Rechtsberatung; verbindlich ist der unterschriebene Vertrag.

## 1 Zusagen je Paket

| Merkmal | Team | Business | Enterprise |
| --- | --- | --- | --- |
| Verfügbarkeit je Kalendermonat | 99,0 % | 99,5 % | 99,5 %, optional 99,9 % |
| Wartungsfenster | angekündigt, außerhalb 7–19 Uhr | wie Team | mit dem Kunden abgestimmt |
| Support-Kanal | E-Mail | E-Mail | E-Mail und Telefon |
| Erste Antwort | 2 Werktage | 1 Werktag | kritisch 4 h, sonst 1 Werktag |
| Wiederherstellung (RPO / RTO) | 24 h / 1 Werktag | 24 h / 8 h | 4 h / 4 h (technisch noch zu bestätigen) |
| Gutschrift bei Unterschreitung | – | 5 % je angefangene 0,5 % | 10 % je angefangene 0,5 % |
| Statusseite `/status` | ja | ja | ja |

Werktage: Montag bis Freitag ohne bundeseinheitliche Feiertage, 8–18 Uhr MEZ/MESZ.

## 2 Messung

Verfügbar ist die Anwendung, wenn sie antwortet und ihre Datenbank erreicht. Die App misst alle 5 Minuten; fehlende Messungen zählen als nicht verfügbar. Angekündigte Wartungen zählen nicht. Die Statusseite zeigt die Verfügbarkeit der letzten 90 Tage und des laufenden Monats und ist Grundlage für Gutschriften. Vor dem Marktstart ergänzt ein externer Prüfdienst die Messung.

**Ausgenommen:** KI-Funktionen, soweit sie von Drittanbietern abhängen. Der Ideenfluss (Einreichen, Fristen, Entscheidungen) wartet nie auf die KI; fällt ein KI-Anbieter aus, arbeitet der eingebaute Anbieter mit Hinweis weiter.

## 3 Störungsklassen

| Stufe | Beispiel | Reaktion | Information an Kund:innen |
| --- | --- | --- | --- |
| P1 kritisch | Portal nicht erreichbar, Verdacht auf Datenabfluss zwischen Arbeitsbereichen | sofort | Statusseite und Admins innerhalb 1 h |
| P2 hoch | Fristen oder Mails laufen nicht | 4 h | Statusseite |
| P3 mittel | KI-Anbieter fällt aus (Ausweichlösung greift) | nächster Werktag | Hinweis in der App |
| P4 niedrig | Darstellungsfehler | nächste Version | – |

Nach jeder P1- und P2-Störung folgt innerhalb von 5 Werktagen ein Bericht mit Ursache und Maßnahmen.

**Datenschutzverletzung:** Information des Verantwortlichen unverzüglich, Ziel 24 Stunden (AVV). Die Meldung an die Aufsichtsbehörde (Art. 33 DSGVO, 72 Stunden) macht der Verantwortliche.

## 4 Sicherung

- Tägliche Sicherung der Datenbank, verschlüsselt beim Hoster; Aufbewahrung je Plan des Hosters (mindestens 7 Tage).
- Die Rücksicherung wird monatlich geprobt; Protokoll im [Betriebshandbuch](../release-0/technik/betriebshandbuch.md), Abschnitt 3.
- Kund:innen können jederzeit einen vollständigen Export ihres Arbeitsbereichs ziehen (Einstellungen › Daten).

## 5 Support-Zugriff

Der Betreiber sieht keine Inhalte eines Arbeitsbereichs, solange die Admin keinen **zeitlich begrenzten Support-Zugriff** erteilt. Jeder Zugriff steht mit Namen der Person beim Betreiber im Protokoll des Arbeitsbereichs.

## 6 Kontakt

Support-Adresse und Telefonnummer stehen im Vertrag und in den Rechtstexten des Portals (`OPERATOR_EMAIL`). Sicherheitslücken bitte nach [`../../SECURITY.md`](../../SECURITY.md) melden.
