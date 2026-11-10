# Firmen-Login mit SAML 2.0 (R3-26)

Deutsch | [English](saml.en.md)

Stand: 13.10.2026. SAML 2.0 ist eine Alternative zum Firmen-Login mit OpenID Connect (OIDC). Je Arbeitsbereich gilt **ein** Protokoll. Gruppen → Rollen, erlaubte E-Mail-Domains, Just-in-time-Anlage, „lokale Konten abschalten“ und SCIM funktionieren für beide Protokolle gleich (ADR 0002, Abschnitt Firmen-Login).

## Was gebaut ist

| Baustein | Umsetzung | Datei |
| --- | --- | --- |
| Einstellungen | Einstellungen › Anmeldung: Protokoll OIDC oder SAML; Entity-ID und Anmelde-URL des Identitätsanbieters, bis zu zwei Signaturzertifikate (Zertifikatswechsel), Attributnamen mit Vorgaben für Entra ID, Okta und ADFS, Schalter „IdP-initiierte Anmeldung“ (Standard aus) | `web/src/pages/SamlSettings.tsx`, `web/src/pages/IdentityAdmin.tsx` |
| Metadaten des Identitätsanbieters | Laden über URL (SSRF-Schutz wie bei OIDC: nur https, keine internen Adressen, außer `OIDC_ALLOW_PRIVATE_URLS=true`) oder als XML einfügen. Dokumente mit DOCTYPE/ENTITY werden abgelehnt (kein XXE) | `POST /api/admin/identity/saml/metadata`, `server/src/lib/saml.ts` |
| Verbindung prüfen | Pflichtfelder, Zertifikate lesbar und gültig, Warnung bei Ablauf in weniger als 30 Tagen, Abgleich mit der Metadaten-URL (andere Entity-ID, andere Anmelde-URL, neues Zertifikat beim Anbieter) | `POST /api/admin/identity/saml/check` |
| Service Provider je Arbeitsbereich | Entity-ID `<PUBLIC_URL>/api/auth/saml/<Mandanten-ID>/metadata`, ACS-URL `<PUBLIC_URL>/api/auth/saml/<Mandanten-ID>/acs` (Mandanten-ID oder Slug), SP-Metadaten als XML (`…/metadata?download` zum Herunterladen) | `server/src/routes/saml.ts` |
| SP-initiierte Anmeldung | `GET /api/auth/saml/<slug>/login?weiter=/pfad` sendet einen AuthnRequest mit HTTP-Redirect-Binding (ohne RequestedAuthnContext, der Anbieter entscheidet über MFA). Die Request-ID steht 10 Minuten in `saml_requests`, gebunden an den Browser (Cookie `ip_saml`) | `server/src/routes/saml.ts` |
| ACS | HTTP-POST-Binding. Bibliothek `@node-saml/node-saml` (xml-crypto, xmldom) prüft Signatur, Audience, NotBefore/NotOnOrAfter (2 Minuten Toleranz), Issuer und InResponseTo. Zusätzlich: Recipient (bearer) und Destination gleich der ACS-URL, Issuer der signierten Assertion, Assertion-ID nur einmal verwendbar (`saml_used_assertions`), Request-ID nur einmal verwendbar und nur von einer Prüfung gleichzeitig (`claimed_by`), Browserbindung | `server/src/lib/saml.ts` |
| Signaturen | Signierte Assertion **oder** signierte Antwort, die die Assertion enthält. Unsigniert, mit fremdem Schlüssel, verändert, mit zwei Assertions oder verschachtelt (XSW) → abgelehnt | Tests `server/test/saml.test.ts` |
| Login-Seite | „Mit Firmen-Login anmelden“ startet je nach Protokoll OIDC oder SAML (`GET /api/auth/sso` liefert `protocol`) | `web/src/pages/Login.tsx` |
| Konten | Gleiche Regeln wie OIDC (`provision()`): Suche über die NameID (gespeichert in `users.oidc_subject`; transiente NameIDs werden nicht gespeichert), sonst über die E-Mail-Adresse, sonst Just-in-time-Anlage. Ohne E-Mail-Attribut gilt die NameID, wenn sie eine Adresse ist | `server/src/routes/identity.ts` |
| Sitzung | `auth_method = 'saml'`; wie bei OIDC keine eigene Zwei-Faktor-Anmeldung, der Identitätsanbieter ist zuständig | `server/src/http.ts` |
| Audit-Log | `auth.sso_login` mit `protocol: 'saml'` (und `idpInitiated`), `auth.sso_failed` mit `protocol: 'saml'` und kurzem Grund (z. B. `signature`, `audience`, `time`, `in_response_to`, `recipient`, `replay`, `browser`, `domain`), `user.jit_create` mit `source: 'saml'`. Kein Inhalt der Assertion im Log | `server/src/routes/saml.ts` |

Migration: `server/migrations/034_saml.sql` (Spalten `tenant_identity.protocol` und `tenant_identity.saml`, erweiterte Prüfung `sessions.auth_method`, Tabellen `saml_requests` und `saml_used_assertions` mit Row-Level-Security, nur Systemverbindung).

Hinweis zur Benennung: Die Spalte `tenant_identity.oidc_enabled` (API-Feld `oidcEnabled`) ist der Hauptschalter „Firmen-Login an“ für **beide** Protokolle. Der Name bleibt aus Kompatibilität.

Neue Abhängigkeiten: `@node-saml/node-saml` 5.1, `@xmldom/xmldom` 0.8 (beide Server), `xml-crypto` 6 (nur Tests, signiert die Antworten des Test-Anbieters).

Neue Umgebungsvariablen: keine. Es gelten `PUBLIC_URL` (bestimmt Entity-ID und ACS-URL – nach einer Änderung müssen die Werte beim Identitätsanbieter angepasst werden), `COOKIE_SECURE` und `OIDC_ALLOW_PRIVATE_URLS`.

## Einrichtung durch die Admin

1. Einstellungen › Anmeldung öffnen, Protokoll **SAML 2.0** wählen.
2. Unter „Werte für den Identitätsanbieter“ Entity-ID und ACS-URL kopieren oder die Metadaten herunterladen.
3. Beim Identitätsanbieter die Anwendung anlegen (siehe unten), dann die Metadaten-URL des Anbieters eintragen und „Metadaten laden“ (oder XML einfügen).
4. Erlaubte E-Mail-Domains und Gruppen → Rollen eintragen, „Firmen-Login einschalten“, speichern.
5. „Verbindung prüfen“, dann in einem privaten Fenster mit einem Testkonto anmelden.
6. Erst wenn das klappt und die Admin selbst mit SAML angemeldet ist, lassen sich lokale Konten abschalten. Notfallzugang wie bei OIDC: `npm run identity -w server -- local-login <slug> on`.

### Microsoft Entra ID (Unternehmensanwendung, SAML)

1. Entra Admin Center › Unternehmensanwendungen › Neue Anwendung › Eigene Anwendung erstellen („Nicht im Katalog“).
2. Einmaliges Anmelden › SAML. Grundlegende SAML-Konfiguration: **Bezeichner (Entitäts-ID)** = Entity-ID aus dem Portal, **Antwort-URL** = ACS-URL. Anmelde-URL optional: `<PUBLIC_URL>/api/auth/saml/<slug>/login`.
3. Attribute & Ansprüche: Standard reicht (E-Mail über `emailaddress`, Name aus Vor- und Nachname). Für Rollen: „Gruppenanspruch hinzufügen“ (Sicherheitsgruppen, Quelle „Gruppen-ID“ oder bei synchronisierten Gruppen `sAMAccountName`). Für die Abteilung einen Anspruch `department` (ohne Namespace) mit `user.department` anlegen. Im Portal „Vorgaben: Entra ID“ wählen.
4. SAML-Zertifikate: „App-Verbundmetadaten-URL“ kopieren und im Portal laden. Signaturoption „SAML-Assertion signieren“ (Standard) oder „Antwort und Assertion signieren“; beides wird akzeptiert. Algorithmus SHA-256.
5. Benutzer und Gruppen zuweisen. MFA über Richtlinien für bedingten Zugriff.
6. Grenze: Bei mehr als 150 Gruppen sendet Entra ID statt der Gruppen nur einen Verweis. Dann bleiben die Gruppen des Kontos unverändert (z. B. aus SCIM). Abhilfe: „Der Anwendung zugewiesene Gruppen“ im Gruppenanspruch.

### Okta

1. Admin Console › Applications › Create App Integration › SAML 2.0.
2. **Single sign-on URL** = ACS-URL („Use this for Recipient URL and Destination URL“ angehakt), **Audience URI (SP Entity ID)** = Entity-ID. Name ID format: `EmailAddress` oder `Persistent`; Application username: E-Mail.
3. Attribute Statements: `email` = `user.email`, `firstName` = `user.firstName`, `lastName` = `user.lastName`, `department` = `user.department`. Group Attribute Statements: `groups`, Filter z. B. „Starts with“ `ideenportal-`. Im Portal „Vorgaben: Okta“ wählen (Name `displayName`, alternativ das Feld leer lassen, dann gilt Vor- plus Nachname).
4. Response und Assertion Signature: „Signed“ (Standard), SHA-256.
5. Unter „Sign On“ die **Metadata URL** kopieren und im Portal laden. Personen oder Gruppen zuweisen.

### ADFS

1. ADFS-Verwaltung › Vertrauensstellungen der vertrauenden Seite › Hinzufügen › „Daten über die vertrauende Seite importieren“ mit der SP-Metadaten-URL des Portals (oder Datei). Alternativ manuell: SAML 2.0 WebSSO, URL = ACS-URL, Bezeichner = Entity-ID.
2. Anspruchsausstellungsrichtlinie: „LDAP-Attribute als Ansprüche senden“: `E-Mail-Addresses` → E-Mail-Adresse, `Display-Name` → Name, `department` → `department` (ausgehender Typ frei eintragen), `Token-Groups – Unqualified Names` → Gruppe. Zusätzlich eine Regel „Eingehenden Anspruch transformieren“ E-Mail-Adresse → Namens-ID (Format E-Mail), wenn die NameID die Adresse sein soll.
3. Im Portal „Vorgaben: ADFS“ wählen. Die Metadaten-URL des ADFS ist `https://<adfs-host>/FederationMetadata/2007-06/FederationMetadata.xml`.
4. ADFS signiert standardmäßig die Assertion mit SHA-256. Beim automatischen Zertifikatswechsel (AutoCertificateRollover) das neue Zertifikat rechtzeitig als zweites Zertifikat eintragen; „Verbindung prüfen“ weist darauf hin.

## Grenzen (bewusst nicht gebaut)

- **Keine signierten AuthnRequests und keine verschlüsselten Assertions.** Dafür bräuchte jeder Arbeitsbereich ein eigenes SP-Zertifikat; Node.js kann ohne weitere Bibliothek keine X.509-Zertifikate erzeugen. Entra ID, Okta und ADFS verlangen beides nicht. Transportverschlüsselung über HTTPS.
- **Kein Single Logout (SLO).** Abmelden beendet nur die Sitzung im Portal.
- **Kein automatisches Nachladen der Zertifikate** aus der Metadaten-URL bei der Anmeldung. Der Wechsel läuft über das zweite Zertifikatsfeld; „Verbindung prüfen“ warnt 30 Tage vor Ablauf und meldet neue Zertifikate in den Metadaten.
- **Nur HTTP-Redirect für den AuthnRequest und HTTP-POST für die Antwort** (kein Artifact-Binding).
- **Browserbindung ohne HTTPS:** Die ACS erhält einen Cross-Site-POST; das Cookie `ip_saml` kommt dort nur mit `SameSite=None; Secure` an. Mit `COOKIE_SECURE=true` (Produktion) ist die Bindung Pflicht. Ohne HTTPS (lokale Entwicklung) ist das Cookie `Lax` und wird nur geprüft, wenn es mitkommt.
- **IdP-initiierte Anmeldung** (Standard aus) hat keine Bindung an eine Anfrage; Schutz dann nur über Signatur, Zeitfenster und die einmalige Assertion-ID. Ziel ist immer die Startseite (RelayState wird ignoriert, kein Open Redirect).
- Bei mehr als einem Wechsel des Protokolls (OIDC ↔ SAML) wird das Konto über die E-Mail-Adresse neu verknüpft, weil OIDC-`sub` und SAML-NameID verschieden sind.
- Die Migration ersetzt die Prüfung `sessions_auth_method_check`. Wenn weitere Anmeldearten dazukommen, muss die Liste dort ergänzt werden.

## Tests

`server/test/saml.test.ts` (34 Tests) mit einem Test-Anbieter im Prozess (`server/test/fake-saml-idp.ts`, signiert mit xml-crypto). Schlüssel und Zertifikate unter `server/test/fixtures/saml/` sind selbstsigniert und nur für Tests. Abgedeckt: Einstellungen und Rechte, SP-Metadaten, Metadaten-Import (XML, URL mit SSRF-Schutz, XXE abgelehnt), Zertifikatsprüfung (Ablauf in 30 Tagen), AuthnRequest, Anmeldung mit Just-in-time-Anlage, Name, Abteilung und Rollen aus Gruppen (Entra- und Okta-Attributnamen), Verknüpfung per Adresse, signierte Antwort statt Assertion, zweites Zertifikat, falsche Audience, abgelaufene und noch nicht gültige Assertion, unsigniert, fremder Schlüssel, falscher Recipient/Destination/Issuer, manipulierte Assertion, Kommentar-Injektion, XSW (zwei Assertions, verschachtelt), DTD, Replay der Antwort und der InResponseTo, fremder Browser, IdP-initiiert aus/an mit Replay-Schutz, nicht erlaubte Domain, inaktives Konto, Just-in-time aus, ACS eines anderen Mandanten, Mandantentrennung mit zwei Mandanten, kein Zugriff der App-Rolle auf die neuen Tabellen, lokale Konten abschalten.
