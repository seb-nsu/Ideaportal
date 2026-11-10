# Admin handbook

[Deutsch](admin-handbuch.md) | English

For admins of a workspace: setting up and maintaining the portal without technical knowledge. Technical operation (servers, environment variables, backups) is described in [`../betrieb.md`](../betrieb.md) (German). All settings are under **Settings** (only visible to admins); every change is recorded in the audit log. Menu names are given as they appear in the English interface.

## 1 First steps (in this order)

1. Check **Deadlines and rules**: deadlines for Gate 1 and Gate 2 in working days, thresholds, language of the workspace, retention periods.
2. **Topics and calendar**: create topic fields, choose the public holidays of your federal state or region.
3. Create **Areas** if triage or committee are only responsible for part of the ideas (section 3).
4. Invite **People** and assign roles (section 2) or set up **Sign-in** with company login and SCIM (section 4).
5. Set up **AI**: providers, models, cost limits; wait for the quality check (section 5).
6. Adapt **Texts** and **Target channels**: Gate 1 answers, FAQ, privacy notice, forwarding targets.
7. Check **Legal**: privacy notice, legal texts, subprocessors.

## 2 People and roles

| Role | May |
| --- | --- |
| Idea submitter | Submit ideas, comment, follow own ideas |
| Mentor | Accompany an idea during elaboration |
| Triage | Decide Gate 1 (choose the lane), ask questions, forward |
| Committee | Decide Gate 2, prepare meetings |
| Department head | Portfolio and dashboard of an area, Gate 3 |
| Implementer | Document the implementation, enter the actual benefit |
| Controlling | Confirm or correct the actual benefit |
| Works council (read-only) | AI evidence and co-determination overview, no idea texts |
| External | Only own and shared ideas (customers, partners) |
| People administration (`user_admin`) | Invite and deactivate people, assign roles (except admin); no settings |
| Admin | All settings |

- **Invite:** Settings › People › email and roles, or share the invitation link.
- **Deactivate:** ends all sessions of the person immediately. After the configured period, the account is anonymised.
- Nobody can remove their **own admin role**; so there is always at least one admin.
- **Access and anonymisation** (GDPR): Settings › People › choose a person.
- **Many people at once:** import from CSV or Excel with a preview (up to 2,000 rows) and bulk actions in the list (deactivate, activate, add or remove a role). Both are recorded in the audit log.

## 3 Areas

Triage, committee and department head can be restricted to areas. An idea belongs to an area via its topic field and organisational unit. Whoever has a role only for area A sees and decides only ideas from A. Instructions: [`../betrieb.md`](../betrieb.md), section “Rollen je Bereich einrichten” (setting up roles per area, German).

## 4 Sign-in

- **Own accounts** with password and optional two-factor sign-in (TOTP). Under Deadlines and rules, two-factor sign-in can be made mandatory for admins.
- **Company login via OIDC** and **SCIM** for Microsoft Entra ID, Okta and others: step by step in [`../betrieb.md`](../betrieb.md), section “Einrichtung für die Kunden-IT” (setup for the customer's IT, German).
- **Company login via SAML 2.0** (Entra ID, Okta, ADFS): [`saml.en.md`](saml.en.md).
- **Settings › Security:** minimum password length and sign-out after inactivity.
- **Switch off local accounts** only once an admin has signed in with the company login; the portal checks this.
- With company login, the company enforces multi-factor sign-in in its identity service.

## 5 AI

- Without any setup, a built-in, rule-based provider works; nothing leaves the server.
- Under **Settings › AI**, set providers, the model per task, cost limits per idea and month, and the web search.
- **Confidential ideas** only go to models with hosting “own infrastructure”.
- A building block only goes live when it passes the **quality check** with the test set. An exception needs a reason and is recorded in the audit log.
- **AI › Quality** shows the check status, feedback from users and alarms, aggregated and only from 5 people upwards.
- Under **AI › Quality**, check reports per run can be downloaded as JSON or Markdown, with a comparison to the previous run. Optionally, a judge model additionally assesses the results.
- The page **“AI in the portal”** (link in the footer) shows all users which AI runs for what, where data goes and when it was last checked.
- The AI never decides and never rejects; it does not assess people.

## 6 Audit log and evidence

- **Settings › Audit log** shows all security-relevant actions (sign-ins and failed attempts, roles, settings, exports, deletions, AI exceptions) with filters by period, person and action, and exports them as CSV or JSONL.
- **Check chain** shows whether the log has been unchanged since the workspace was created.
- **SIEM:** under Audit log, a target (https webhook) can be entered; new entries are sent there with a signature.
- **AI evidence** shows every AI action with model, cost and sources; the works council sees it read-only.

## 7 Data

- **Export** of the whole workspace under Settings › Data: the portal creates a ZIP in the background with one file per table and all attachments and notifies the admin. The download is valid for 7 days.
- **Retention periods** under Deadlines and rules; the nightly run deletes completed ideas and anonymises deactivated accounts.
- **Delete the workspace** under Settings › Data: only after signing in again (password and second factor, or a fresh company login). After that, a 30-day grace period applies in which only admins can sign in and cancel the deletion. A deletion certificate without content stays with the operator.

## 8 Integrations

- **API tokens and webhooks:** Settings › Integrations; description of the API under `/api/docs`.
- **Jira, ServiceNow, Azure DevOps:** [`../konnektoren/`](../konnektoren/README.md) (German).
- **Slack and Teams:** [`../betrieb.md`](../betrieb.md), section “Slack und Microsoft Teams” (German).

## 9 Support

- The admin grants **support access** for a limited time under Settings › Support access. Every access by the operator is recorded in the workspace's audit log.
- Incidents and maintenance are shown on the status page `/status`. Commitments on availability and response times: [`sla-und-support.en.md`](sla-und-support.en.md).
