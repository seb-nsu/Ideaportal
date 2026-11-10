# Text templates (English)

Stand 13.10.2026 · Release 3 (R3-22) · English version of [`textvorlagen.md`](textvorlagen.md)

The IDs are the same as in the German templates and in `benachrichtigungsmatrix.md`. The wording that the portal actually sends lives in the text catalogue: `server/src/i18n/en/*.ts` (mails, notifications, server messages, fixed AI texts) and `web/src/i18n/en/*.ts` (interface). This page is the editorial reference; when the two differ, the catalogue wins.

**Principles:** We use “you” and a friendly, direct tone. Short sentences. Every response thanks, names the decision, gives the reason and says what happens next. Never judge the person, only the idea. Placeholders in `{curly braces}`. Dates appear in the reader's format (English: `20/10/2026`, German: `20.10.2026`).

**Which language does a reader get?**

- Mails and notifications: the language of the recipient (Mein Konto › Sprache, `users.locale`).
- Pages without an account (landing page, login, sign-up, join link): the language of the browser, or the DE/EN switch on the page (kept in the browser).
- Gate 1 texts, FAQ, topics, privacy notice: tenant texts in the language of the workspace. A new workspace gets them in the language of the person who creates it; existing texts are never translated automatically.
- AI: answers in a dialogue (coach, reply drafts, discussion summaries, image description, challenge proposals) come in the language of the person asking; analyses stored at an idea come in the workspace language (Settings › Process › Workspace language).

## Gate 1: lane

### `G1-SCHNELL` – Fast lane

> Thank you for your idea! It is small enough to be implemented directly. The department takes over the implementation, and you will be kept informed about the progress.
>
> Responsible: {owner} · Target date: {target_date}
> {reason}

### `G1-AUSARB` – Elaborate

> Thank you for your idea! It has potential and will now be elaborated. Afterwards, the decision on implementation is taken at Gate 2.
>
> Your mentor: {mentor}. The elaboration takes at most {timebox} weeks. You can work on the dossier too.

### `G1-WEITER` – Forward

> Thank you for your request! It will be handled elsewhere. Below you can see where it was forwarded to and who your contact person is.
>
> Responsible: {channel} · Contact: {contact} · {link}
> {reason}

### `G1-ABLEHN` – Reject

> Thank you for your idea! We will not implement it. You can find the reason below. We are happy to explain the decision in a conversation as well.
>
> Reason: {reason}
> Contact: {triage_person}. If something changes, you can resubmit the idea at any time.

**Building blocks for reasons when rejecting** (choice in the form, can be extended):

| Block | Text |
| --- | --- |
| Already exists | “A similar solution already exists: {reference}. Would you like to join in there?” |
| No fit | “The idea does not currently fit our topic areas and goals for {year}.” |
| Effort too high | “At the moment the effort is not in a good relation to the expected benefit.” |
| Legal/regulatory | “Legal requirements do not allow the implementation in this form. {office} has checked this.” |
| Too vague | “We are missing a concrete problem to start from. Feel free to describe an example from your daily work.” |

## Gate 2: decision

| ID | Outcome | Text |
| --- | --- | --- |
| `G2-UMSETZEN` | Implement | “Good news: your idea will be implemented. Owner is {owner}, target date {target_date}. Reason: {reason}” |
| `G2-ERPROBEN` | Test | “Your idea will first be tested in an experiment: {hypothesis}. Then we decide again. Owner: {owner}.” |
| `G2-INTEGRIEREN` | Integrate | “Your idea becomes part of the ongoing project {project}. Contact: {owner}.” |
| `G2-PARKEN` | Park | “We are parking your idea until {date}. Then it automatically comes back to the table. Reason: {reason}” |
| `G2-ABLEHN` | Reject | “After the elaboration we will not implement your idea. Reason: {reason}. Thank you for your work on the dossier – {mentor} is happy to explain the decision in person.” |

## Gate 3 and recognition

| ID | Text |
| --- | --- |
| `N-UMGESETZT` | “Your idea {title} has been implemented! Recorded benefit: {benefit}. Thank you for bringing it in.” |
| `N-WIRKUNG` | “The impact review for {title} is due. Please compare plan and actual by {date}.” |
| `N-ERFOLG` | “We would like to show your idea as a success story. Please check the draft and approve it – or tell us if you do not want to be named.” |

## Tasks and reminders

| ID | Subject | Text |
| --- | --- | --- |
| `N-NEU` | New idea {no} {title} | A new idea is waiting for triage: {no} {title}. |
| `N-DELEGIERT` | Idea submitted on your behalf: … | {person} submitted the idea on your behalf. Please confirm your authorship in the idea. |
| `N-RUECKFRAGE` | Question about your idea … | The triage team has a question: {question} The deadline is paused until you answer. |
| `N-ANTWORT` | Answer to the question about … | {answer} |
| `N-UEBERGABE` | Handover for implementation: … | The idea was handed over to you for direct implementation (target date {date}). Please confirm that you take it over. |
| `N-OWNER` | You own the implementation … | Decision at Gate 2: {outcome}. Please keep progress and actual benefit up to date until {date}. |
| `N-START` | Implementation started: … | {person} has taken over the implementation of your idea. |
| `N-GESCHLOSSEN` | Idea closed: … | We have not received an answer to the question for 15 working days and have closed the idea. You can resubmit it at any time. |
| `N-WIEDERVORLAGE` | Resubmission: … | The parked idea is due for resubmission and is waiting for a decision at Gate 2. |
| `N-ZUSAMMEN-Q` / `-Z` | Idea merged: … | Your idea was merged with {target}. You are a co-author there; comments and support have moved along. |
| `N-COAUTOR` | You are a co-author of … | {person} added you as a co-author. You have the same rights as the submitter. |
| `N-KOMMENTAR` | New comment on … | {person}: {comment} |
| `N-UNTERSTUETZT` | New support for … | {person} supports your idea. |
| `E-ERINNERUNG` | Reminder: deadline for … | The deadline ends in {n} working day(s) on {date}. |
| `E-ESKALATION` | Deadline exceeded: … | The deadline was exceeded {n} working day(s) ago (due {date}). Please take care of a decision. |
| `E-VERZUG` | Implementation overdue: … | The target date {date} has passed. Please update progress and target date or close the implementation with the actual benefit. |
| `E-TIMEBOX` | Elaboration ends soon: … | The timebox for {title} ends on {date}. Is the dossier ready for Gate 2? |
| `K-EINLADUNG` | Invitation to the idea portal | {person} invites you to the workspace {name}. Set your password here: {link} |
| `K-RESET` | Reset password | Use this link to set a new password. It is valid for 24 hours: {link} |

## AI labels (R2-11)

| ID | Where | Text / display |
| --- | --- | --- |
| `KI-BADGE` | above every AI content | “AI draft · not reviewed” or “AI draft · reviewed by {person} on {date}” |
| `KI-BELEG` | per statement | “Source” + source (title, link) + “retrieved on {date}” |
| `KI-ANNAHME` | per statement | “Assumption” – please check |
| `KI-SCHAETZUNG` | per statement | “Estimate · confidence {low/medium/high}”; numbers without a source are downgraded to this automatically |
| `KI-VORSCHLAG` | triage, committee | “Suggestion by the AI – you make the decision.” |
| `KI-LOKAL` | confidential idea | “This analysis only ran on internal systems. There was no web search.” |
| `KI-PATENT` | patent research | “Note, no approval. Patent experts check IP rights.” |
| `KI-AUS` | AI switched off / budget reached | “There is no AI analysis for this idea ({reason}).” |
| `KI-FERTIG-KURZ` | notification | “The short analysis for {title} is ready.” |
| `KI-FERTIG-VOLL` | notification | “The draft dossier for {title} is ready. Please check the marked statements.” |
| `KI-BUDGET` | admin | “{percent} % of the AI budget for {month} has been used.” |
| `KI-QUALITAET` | admin | “The agent {agent} did not pass the test set ({value} < {min}). It stays switched off.” |
| `KI-INJECTION` | admin | “Possible hidden instructions to the AI were found in {count} texts. The AI did not follow them.” |
| `N-PATE` / `N-PATE-IG` | mentor / submitter | “You are the mentor for {title}. Timebox until {date}.” / “{mentor} supports your idea until Gate 2.” |
| `N-PATE-LAST` | triage | “{mentor} already supports {n} ideas. Assign anyway?” |
| `N-GREMIUM` | committee | “The documents for the meeting on {date} are ready ({n} ideas, about 10 minutes per idea).” |
| `E-EXPERIMENT` | owner | “The experiment for {title} ends on {date}. Please enter the result.” |

## Challenge phases (R2-52)

Subject per phase: “Challenge “{title}”: …”. Wording in the catalogue under `challenges.phase.<phase>.subject|sponsor|participants|jury` (`server/src/i18n/en/challenges.ts`).

| ID | Recipient | Core of the message |
| --- | --- | --- |
| `CH-SAMMELN` | sponsor | “Your challenge now accepts ideas, until {date}.” |
| `CH-BEWERTEN` | sponsor, submitters | “Collecting has ended. Until {date} everyone rates the ideas.” |
| `CH-AUSARBEITEN` | sponsor, submitters | “Rating has ended. Until {date} the ideas are elaborated.” |
| `CH-JURY` | sponsor, jury, submitters | Jury: “Please rate the ideas of the challenge by {date}.” |
| `CH-ERGEBNIS` | sponsor, submitters | Sponsor: “Publish the ranking and a summary now.” |

## Default texts of a new English workspace

Topic areas: Processes and efficiency · Products and services · Customer experience · Sustainability · Workplace. Gate 1 texts as above (`G1-*`), FAQ and privacy notice in `server/src/i18n/en/defaults.ts`. The scorecard keeps its criteria and weights; labels, questions and anchors are translated. The boundary check keeps the German keywords and adds English ones (for example “harassment”, “outage”, “complaint”, “near miss”).
