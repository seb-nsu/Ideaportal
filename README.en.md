# Idea portal

[Deutsch](README.md) | English

AI-supported idea management for innovation and strategy teams in companies with 250–5,000 employees: every idea gets an answer within a fixed deadline, AI agents prepare the competition and market analysis, business case and decision brief, and the product proves the benefit after implementation. Internal use and SaaS from the same code.

**Status:** Concept version 3 (12 Oct 2026) after the 360-degree review in [`docs/05-review-v3/`](docs/05-review-v3/); approach in five phases in the implementation concept, section 4; order of work in [`docs/arbeitspakete.md`](docs/arbeitspakete.md). Release 1 is built for pilot operation as a capstone product: teams create their workspace themselves, invite colleagues by link and need no company login. Status per story in [`docs/release-1/umsetzungsstand.md`](docs/release-1/umsetzungsstand.md). Release 2 (elaboration, committee, AI analyses with configurable models) is built, status in [`docs/release-2/umsetzungsstand.md`](docs/release-2/umsetzungsstand.md). Since 13 Oct 2026, Release 3 (company login, SCIM, API, Teams and Slack, connectors, packages, external participation, use cases, compliance) and Release 4 (AI quality, recognising, impact and learning) are built as well, as far as possible without paid services and real users; status in [`docs/release-3/umsetzungsstand.md`](docs/release-3/umsetzungsstand.md) and [`docs/release-4/umsetzungsstand.md`](docs/release-4/umsetzungsstand.md), open points for the product owner at the end of [`docs/arbeitspakete.md`](docs/arbeitspakete.md). The suggestion scheme module is not built. The results of Release 0 (UX, process, data protection, business) are in [`docs/release-0/`](docs/release-0/README.md). Operations and AI setup in [`docs/betrieb.md`](docs/betrieb.md). Documents for enterprise customers (security, SLA, upgrades, admin handbook) in [`docs/enterprise/`](docs/enterprise/README.en.md), in German and English.

The concept and project documents in `docs/` are written in German; the documents for customers in `docs/enterprise/` exist in both languages.

## Quick start

With Docker (a database and the app, public demo switched on):

```bash
docker compose up --build
```

Without Docker (Node.js 22 and PostgreSQL 16 locally):

```bash
npm install
export DATABASE_URL=postgres://ideenportal:ideenportal@localhost:5432/ideenportal
npm run seed        # migrations and demo data
npm run dev         # API on :3000, interface on :5173
npm test            # tests; needs an empty database ideenportal_test (TEST_DATABASE_URL)
npm run check:texts # all visible texts in the text catalogue, English complete
npm run check:security # simple security check of the code (runs in CI)
npm run lint        # ESLint for server and interface
npm run format:check # Prettier for new files (changed files only as a warning)
npm run test:coverage -w server # tests with minimum coverage
npm run eval -w server -- --provider builtin # AI test set without a database
```

Then open `http://localhost:3000` (Docker) or `http://localhost:5173`. The start page offers three ways:

- **Create a workspace:** name, email and password are enough. Whoever creates it becomes admin and invites further people by invitation link (Settings > People).
- **Try the demo** (with `DEMO_MODE=true`): choose a role and get started in the demo workspace; the role can be switched at the top. The demo opens in the language of the page: the German demo workspace `demo` or the English demo workspace `demo-en`, each with its own example ideas and analyses.
- **Sign in:** just email and password.

Demo accounts (password `Ideenportal-Demo-2026`):

| English demo (`demo-en`) | German demo (`demo`) | Role |
| --- | --- | --- |
| `staff@demo-en.example` | `mitarbeit@demo.example` | Idea submitter |
| `triage@demo-en.example` | `triage@demo.example` | Triage team |
| `committee@demo-en.example` | `gremium@demo.example` | Committee (Gate 2) |
| `implementation@demo-en.example` | `umsetzung@demo.example` | Implementer |
| `admin@demo-en.example` | `admin@demo.example` | Admin and triage |

The seed script also creates the workspace `beispiel` (same accounts as the German demo with `@beispiel.example`); there, two-factor sign-in is mandatory for admins.

Publishing: `render.yaml` is a template for Render (EU, Frankfurt); further variants and all environment variables in [`docs/betrieb.md`](docs/betrieb.md).

## Languages

The portal runs in German and English (R3-22). German is the reference; if an English text is missing, the German one appears.

- **Per person:** My account › Language (`users.locale`). Interface, error messages, emails and notifications as well as date and number formats (`de-DE`, `en-GB`) follow it.
- **Without an account:** start page, sign-in, registration and invitation link follow the browser language; the DE | EN switch at the top of the start page and below the forms remembers the choice in the browser.
- **Per workspace:** Settings › Process › Language of the workspace (`settings.locale`). A new workspace gets topic fields, Gate 1 texts, FAQ, privacy notice, scorecard, the tone of the AI texts and example content in the language of the person who creates it. Existing texts are never translated automatically.
- **AI:** answers in a dialogue (coach, reply draft, discussion summary, photo, challenge suggestions, voice input) come in the language of the person asking; analyses stored at the idea (short analysis, triage suggestion, full analysis, draft idea profile, Gate 2 brief, success story) in the language of the workspace. The model gets a language rule in the system text for this; the built-in provider delivers its fixed texts from the catalogue (`aiout.*`). Names of the AI building blocks, provider templates, errors of models and web search and the warnings at AI results come from the catalogue (`aigw.*`); warnings and job errors are stored as German reference text and shown in the language of the reader.
- **Translating content (R3-30):** ideas and comments can be translated into one of 15 languages at the push of a button (`TRANSLATION_LANGUAGES` in `server/src/ai/insights.ts`); the original stays visible, the translation is stored per text and target language. This needs an AI model, and confidential ideas only a model on own infrastructure; without a suitable model the interface does not offer translation.
- **Another interface language:** 1. Create the folders `server/src/i18n/<code>/` and `web/src/i18n/<code>/` with the same namespace files as `de/` and an `index.ts` (missing keys fall back to German). 2. Server: add `<code>` to `LOCALES`, `catalogs` and `INTL` in `server/src/i18n/index.ts` and add a language rule to `LANGUAGE_RULE` (`server/src/ai/gateway.ts`) (the compiler asks for it). 3. Interface: `LOCALES`, `LOCALE_INFO` and `catalogs` in `web/src/i18n/index.ts`; the switch takes the language from there. 4. A migration that extends the check `users.locale IN (…)`. 5. Example data in `server/src/db/demo-content.ts` and `demo-results-en.ts` as a model for a demo workspace in the new language. 6. Run `npm run check:texts` and `server/test/multilingual.test.ts`.
- **Maintaining texts:** `server/src/i18n/<de|en>/` and `web/src/i18n/<de|en>/`, the same keys in both languages; `npm run check:texts` finds texts outside the catalogue (also in `server/src/ai/`), `server/test/multilingual.test.ts` finds German leftovers in the English catalogue. Text templates: [`docs/release-0/ux/textvorlagen.md`](docs/release-0/ux/textvorlagen.md) and [`textvorlagen.en.md`](docs/release-0/ux/textvorlagen.en.md).

## Code

```
server/   API (TypeScript, Fastify, PostgreSQL with row-level security), jobs, tests
web/      interface (React, Vite)
e2e/      browser test with accessibility check (Playwright, axe)
docs/adr/ architecture decisions
docs/konnektoren/  setup of Jira, ServiceNow, Azure DevOps
docs/sicherheit/   security concept and pentest preparation
docs/enterprise/   documents for enterprise customers and technology per area (German and English)
```

Configuration only via environment variables, see `.env.example`.

## Contents

```
docs/
  01-konzept-v2/        revised process concept (pptx + text)
  02-produktkonzept/    product concept internal & SaaS (md)
  03-umsetzungskonzept/ implementation concept with backlog (md)
  05-review-v3/         360-degree review V3 (product/technology, market/competition) and incorporation
  diagramme/            diagrams as PNG
  release-0 … release-4/ results of Release 0, implementation status per story from Release 1
  arbeitspakete.md      work packages version 3 with status per package
backlog/
  backlog.csv           146 user stories, import e.g. into Jira
  backlog.json          the same stories for scripts
tools/
  extract_backlog.py    creates backlog/ from the implementation concept
  finanzmodell.py       recalculates the financial model V3
  check-texts.mjs, check-security.mjs  checks for CI
  build_konzeptdeck_v2.js  script that created slide deck v2 (pptxgenjs)
CLAUDE.md               project context for Claude Code
server/, web/           application (see above)
```

## Key figures

| Release | Content | Stories | Story points (must) |
| --- | --- | --- | --- |
| 0 | Foundations: UX, architecture, data protection, contracts | – | – |
| 1 | MVP core flow and platform base | 45 | 177 (165) |
| 2 | Elaboration and AI analysis, pilot readiness | 53 | 251 (170) |
| 3 | Enterprise-ready and market-ready SaaS, use cases, suggestion scheme module | 39 | 248 (158) |
| 4 | Learning system | 9 | 76 (42) |
| **Total** | | **146** | **752 (535)** |

## Continue with Claude Code

1. Clone the repository and start Claude Code in the repo; `CLAUDE.md` provides the context.
2. Regenerate the backlog after changes to the implementation concept: `python3 tools/extract_backlog.py`
3. Next steps: the open points at the end of `docs/arbeitspakete.md` (click test, pilot, reviews) and then the findings from them.
