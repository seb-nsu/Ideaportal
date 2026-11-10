# Service level and support

[Deutsch](sla-und-support.md) | English

Customer version of the commitments for SaaS operation. Basis (in German): SLA proposal in [`../release-0/business/vertragsgrundlagen.md`](../release-0/business/vertragsgrundlagen.md) (section 4) and incident process in the [operations handbook](../release-0/technik/betriebshandbuch.md) (section 5). **Status: proposal, to be confirmed by the product owner before a contract is signed.** No legal advice; the signed contract is binding. The German version is the reference.

## 1 Commitments per package

| Feature | Team | Business | Enterprise |
| --- | --- | --- | --- |
| Availability per calendar month | 99.0 % | 99.5 % | 99.5 %, optionally 99.9 % |
| Maintenance window | announced, outside 7 am–7 pm | as Team | agreed with the customer |
| Support channel | Email | Email | Email and phone |
| First response | 2 working days | 1 working day | critical 4 h, otherwise 1 working day |
| Recovery (RPO / RTO) | 24 h / 1 working day | 24 h / 8 h | 4 h / 4 h (technically still to be confirmed) |
| Service credit if missed | – | 5 % per started 0.5 % | 10 % per started 0.5 % |
| Status page `/status` | yes | yes | yes |

Working days: Monday to Friday excluding nationwide public holidays in Germany, 8 am–6 pm CET/CEST.

## 2 Measurement

The application is available when it answers and reaches its database. The app measures every 5 minutes; missing measurements count as unavailable. Announced maintenance does not count. The status page shows the availability of the last 90 days and of the current month and is the basis for service credits. Before the market launch, an external monitoring service complements the measurement.

**Excluded:** AI functions as far as they depend on third-party providers. The idea flow (submitting, deadlines, decisions) never waits for the AI; if an AI provider fails, the built-in provider continues with a notice.

## 3 Incident classes

| Level | Example | Response | Information to customers |
| --- | --- | --- | --- |
| P1 critical | Portal not reachable, suspected data leak between workspaces | immediately | Status page and admins within 1 h |
| P2 high | Deadlines or mails do not run | 4 h | Status page |
| P3 medium | AI provider fails (fallback takes over) | next working day | Notice in the app |
| P4 low | Display error | next version | – |

Every P1 and P2 incident is followed by a report with cause and measures within 5 working days.

**Personal data breach:** the controller is informed without undue delay, target 24 hours (DPA). The notification to the supervisory authority (Art. 33 GDPR, 72 hours) is made by the controller.

## 4 Backup

- Daily backup of the database, encrypted at the hosting provider; retention according to the hosting provider's plan (at least 7 days).
- Restoring is rehearsed monthly; log in the [operations handbook](../release-0/technik/betriebshandbuch.md), section 3 (German).
- Customers can take a full export of their workspace at any time (Settings › Data).

## 5 Support access

The operator sees no content of a workspace as long as its admin grants no **time-limited support access**. Every access is recorded in the workspace's log with the name of the person at the operator.

## 6 Contact

Support address and phone number are in the contract and in the legal texts of the portal (`OPERATOR_EMAIL`). Please report security vulnerabilities according to [`../../SECURITY.md`](../../SECURITY.md).
