import { z } from 'zod';
import { m, tr, type Locale, type MessageKey, type Vars } from '../i18n/index.js';
import { splitSentences, stripInjections } from './content.js';
import { SYSTEM, fence, ideaBlock, type IdeaFacts } from './agents.js';
import type { AgentCall } from './gateway.js';

// Implementation package (R3-18): project brief and user stories from an approved idea. The
// agent only drafts; people edit the package and decide what is handed over to the connectors.

export const BRIEF_FIELDS = ['goal', 'scope', 'outOfScope', 'benefit', 'effort', 'risks', 'milestones', 'openQuestions'] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];

const text = (max: number) => z.string().max(max);
export const briefSchema = z.object(Object.fromEntries(BRIEF_FIELDS.map((f) => [f, text(4000)])) as Record<BriefField, z.ZodString>);
export const storySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(3000),
  acceptance: z.array(z.string().trim().min(1).max(300)).max(8),
});
export const packageSchema = z.object({
  brief: briefSchema,
  stories: z.array(storySchema).min(1).max(15),
});
export type ImplementationPackage = z.infer<typeof packageSchema>;

export interface PackageFacts {
  /** Dossier sections (summary, benefit, effort, risks, affected, path). */
  dossier: Record<string, string>;
  targetDate: string | null;
  channel: string | null;
}

const T = (l: Locale, key: MessageKey, vars?: Vars) => tr(l, m(key, vars));
const safe = (s: string) => stripInjections(s ?? '').trim();
const first = (s: string, n: number) => splitSentences(s).slice(0, n).join(' ');

export function packageCall(idea: IdeaFacts, facts: PackageFacts): AgentCall<ImplementationPackage> {
  return {
    agent: 'implementation_package',
    ideaId: idea.id,
    // Confidential ideas only go to a model with own hosting (gateway rule).
    sensitive: idea.confidential,
    system: SYSTEM,
    maxTokens: 6000,
    tools: [],
    schema: packageSchema,
    prompt: `Erstelle aus der freigegebenen Idee den Entwurf eines Umsetzungspakets. "brief" ist der Projektsteckbrief mit den Feldern goal (Ziel), scope (Umfang), outOfScope (nicht im Umfang), benefit (Nutzen), effort (Aufwand), risks (Risiken), milestones (Meilensteine bis zum Zieltermin), openQuestions (offene Fragen). "stories" sind 3 bis 10 User Stories im Format "Als … möchte ich …, damit …" mit Titel und höchstens 5 prüfbaren Akzeptanzkriterien.
Übernimm Zahlen nur aus Steckbrief und Idee und kennzeichne sie als Schätzung, wenn sie keine Quelle haben. Fehlt etwas, schreibe eine offene Frage statt einer Annahme. Nenne keine Personen.

${ideaBlock(idea)}

Steckbrief und Umsetzung:
${fence('steckbrief', JSON.stringify(facts).slice(0, 30_000))}`,
    builtin: (l) => {
      const d = Object.fromEntries(Object.entries(facts.dossier).map(([k, v]) => [k, safe(v)]));
      const title = safe(idea.title);
      const solution = safe(idea.solution);
      const benefit = safe(idea.benefit);
      const path = d.path || solution;
      const why = first(d.benefit || benefit, 1) || T(l, 'conn.pkg.whyOpen');
      const who = first(d.affected ?? '', 1) || T(l, 'conn.pkg.whoDefault');
      const steps = splitSentences(path).filter((s) => s.length >= 8).slice(0, 5);
      const stories = steps.map((s) => ({
        title: s.replace(/[.!?]$/, '').slice(0, 120),
        description: T(l, 'conn.pkg.storyText', { who, what: s.replace(/[.!?]$/, ''), why: why.replace(/[.!?]$/, '') }).slice(0, 3000),
        acceptance: [T(l, 'conn.pkg.acc.result'), T(l, 'conn.pkg.acc.owner')],
      }));
      stories.push({
        title: T(l, 'conn.pkg.measure.title'),
        description: T(l, 'conn.pkg.measure.text', { why: why.replace(/[.!?]$/, '') }).slice(0, 3000),
        acceptance: [T(l, 'conn.pkg.acc.baseline'), T(l, 'conn.pkg.acc.gate3')],
      });
      return {
        brief: {
          goal: (d.summary || `${title}: ${first(solution, 2)}`).slice(0, 4000),
          scope: path.slice(0, 4000),
          outOfScope: T(l, 'conn.pkg.outOfScopeOpen'),
          benefit: (d.benefit || benefit).slice(0, 4000),
          effort: (d.effort || T(l, 'conn.pkg.effortOpen')).slice(0, 4000),
          risks: (d.risks || T(l, 'conn.pkg.risksOpen')).slice(0, 4000),
          milestones: facts.targetDate ? T(l, 'conn.pkg.milestones', { date: facts.targetDate }) : T(l, 'conn.pkg.milestonesOpen'),
          openQuestions: T(l, 'conn.pkg.openQuestions'),
        },
        stories,
      };
    },
  };
}
