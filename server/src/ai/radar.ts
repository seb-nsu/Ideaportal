import { z } from 'zod';
import { m, tr, type Locale, type MessageKey, type Vars } from '../i18n/index.js';
import { SYSTEM, fence, sourceBlock } from './agents.js';
import { splitSentences, stripInjections, type Source } from './content.js';
import type { AgentCall } from './gateway.js';
import { keywords } from './search.js';

// Agents of AP-27 "Erkennen": weekly trend hints per topic field (R4-02), assignment of signals
// from the web search and from own ideas to the trends of the radar (R4-11) and clusters of
// recurring problems from tickets and feedback (R4-01). They only suggest and count; people
// adopt trends, confirm links and turn clusters into problems or challenges.

const T = (l: Locale, key: MessageKey, vars?: Vars) => tr(l, m(key, vars));
const safe = (s: string) => stripInjections(s ?? '').replace(/\s+/g, ' ').trim();
const firstSentence = (s: string) => splitSentences(safe(s))[0] ?? '';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- weekly trend hints (R4-02)

export const digestSchema = z.object({
  summary: z.string().max(2000),
  points: z.array(z.object({ text: z.string().max(600), sources: z.array(z.number().int()).max(10) })).max(10),
  candidates: z.array(z.object({ title: z.string().max(140), description: z.string().max(600), sources: z.array(z.number().int()).max(10) })).max(5),
});
export type DigestOutput = z.infer<typeof digestSchema>;

/** Terms that appear in at least `min` of the texts, most frequent first. */
function sharedTerms(texts: string[], min: number, max: number, exclude: Set<string>): { term: string; idx: number[] }[] {
  const where = new Map<string, number[]>();
  texts.forEach((text, i) => {
    for (const k of new Set(keywords(text, 10))) {
      if (exclude.has(k)) continue;
      where.set(k, [...(where.get(k) ?? []), i]);
    }
  });
  return [...where.entries()]
    .filter(([, idx]) => idx.length >= min)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([term, idx]) => ({ term, idx }));
}

export function trendDigestCall(topic: string, sources: Source[]): AgentCall<DigestOutput> {
  return {
    agent: 'trend_digest',
    ideaId: null,
    // Only the name of the topic field and web hits; no idea content.
    sensitive: false,
    system: SYSTEM,
    maxTokens: 2500,
    tools: ['web_search'],
    sources,
    schema: digestSchema,
    logInput: { topic, sources: sources.length },
    prompt: `Fasse die Treffer der Websuche zu Markt- und Technologietrends im Themenfeld „${topic}“ als Wochenhinweis für die Sponsorin oder den Sponsor des Themenfelds zusammen.
- "summary": zwei bis drei Sätze, was diese Woche auffällt.
- "points": bis zu 6 Hinweise, jeder mit den Nummern der Quellen in "sources". Ohne Quelle kein Hinweis. Erfinde keine Zahlen.
- "candidates": bis zu 3 Trends, die ins Trendradar passen könnten (Titel, ein Satz Beschreibung, Quellen). Die Innovationsleitung entscheidet, ob sie übernommen werden.
Nenne keine Personen und bewerte keine Personen. Ist die Quellenliste leer, schreibe das in "summary" und lass die Listen leer.

${sourceBlock(sources)}`,
    builtin: (l) => {
      const usable = sources.filter((s) => safe(s.title) || safe(s.snippet));
      const points = usable.slice(0, 6).map((s) => {
        const sentence = firstSentence(s.snippet);
        return { text: `${safe(s.title).slice(0, 200)}${sentence ? `: ${sentence}` : ''}`.slice(0, 600), sources: [s.id] };
      });
      const topicWords = new Set(keywords(topic, 6));
      const texts = usable.map((s) => `${s.title} ${s.snippet}`);
      const shared = sharedTerms(texts, Math.min(2, Math.max(1, usable.length)), 3, topicWords);
      const candidates = shared.map(({ term, idx }) => ({
        title: cap(term).slice(0, 140),
        description: T(l, 'radar.digest.candidate', { topic, n: idx.length }).slice(0, 600),
        sources: idx.map((i) => usable[i].id).slice(0, 10),
      }));
      return {
        summary: usable.length ? T(l, 'radar.digest.summary', { topic, n: usable.length }) : T(l, 'radar.digest.empty', { topic }),
        points,
        candidates,
      };
    },
  };
}

// ---------------------------------------------------------------- signals to trends (R4-11)

export interface RadarTrend {
  id: string;
  title: string;
  description: string;
  topic: string;
}

export interface RadarSignal {
  /** "idea:<uuid>" or "web:<digest id>:<source id>" */
  ref: string;
  title: string;
  text: string;
}

export const assignSchema = z.object({
  assignments: z.array(z.object({ signal: z.string().max(120), trend: z.string().max(60), reason: z.string().max(300) })).max(60),
});
export type AssignOutput = z.infer<typeof assignSchema>;

/** Word stems for a rough match ("Wärmepumpen" and "Wärmepumpe"). */
const stem = (w: string) => w.slice(0, Math.max(5, w.length - 2));

export function trendAssignCall(trends: RadarTrend[], signals: RadarSignal[]): AgentCall<AssignOutput> {
  return {
    agent: 'trend_assign',
    ideaId: null,
    // Confidential ideas never become signals; the caller leaves them out.
    sensitive: false,
    system: SYSTEM,
    maxTokens: 3000,
    tools: ['internal_search'],
    schema: assignSchema,
    logInput: { trends: trends.length, signals: signals.length },
    prompt: `Ordne Signale den Trends des Trendradars zu. Ein Signal ist ein Treffer aus der Websuche oder eine eigene Idee. Ordne nur zu, wenn das Signal den Trend inhaltlich betrifft; im Zweifel gar nicht. Jede Zuordnung ist ein Vorschlag, den ein Mensch bestätigt.
Gib für jede Zuordnung die Signal-Kennung ("signal"), die Trend-Kennung ("trend") und einen kurzen sachlichen Grund an. Bewerte keine Personen.

Trends:
${fence('trends', trends.map((t) => `${t.id} | ${t.topic} | ${t.title}: ${t.description}`).join('\n'))}

Signale:
${fence('signale', signals.map((s) => `${s.ref} | ${s.title}: ${s.text.slice(0, 400)}`).join('\n'))}`,
    builtin: (l) => {
      const trendTerms = trends.map((t) => new Map(keywords(`${t.title} ${t.title} ${t.description}`, 8).map((k) => [stem(k), k])));
      const assignments: AssignOutput['assignments'] = [];
      for (const s of signals) {
        const terms = new Set(keywords(`${s.title} ${safe(s.text)}`, 12).map(stem));
        let best: { i: number; shared: string[] } | null = null;
        trendTerms.forEach((tt, i) => {
          const shared = [...tt.entries()].filter(([st]) => terms.has(st)).map(([, w]) => w);
          if (shared.length && (!best || shared.length > best.shared.length)) best = { i, shared };
        });
        const hit = best as { i: number; shared: string[] } | null;
        if (hit) assignments.push({ signal: s.ref, trend: trends[hit.i].id, reason: T(l, 'radar.assign.reason', { terms: hit.shared.slice(0, 3).join(', ') }) });
      }
      return { assignments: assignments.slice(0, 60) };
    },
  };
}

// ---------------------------------------------------------------- problem clusters (R4-01)

export interface ProblemItem {
  /** Number of the item in this run ("1", "2" …); no ticket key goes to the model. */
  ref: string;
  /** Title and description, already without person fields, names and e-mail addresses. */
  text: string;
}

export const clusterSchema = z.object({
  clusters: z.array(z.object({ label: z.string().max(120), summary: z.string().max(600), items: z.array(z.string().max(12)).max(1000) })).max(20),
});
export type ClusterOutput = z.infer<typeof clusterSchema>;

export function problemClustersCall(items: ProblemItem[], minSize: number): AgentCall<ClusterOutput> {
  return {
    agent: 'problem_clusters',
    ideaId: null,
    // Tickets and feedback can carry anything, also hints that belong to a reporting channel:
    // only a model with own hosting (or the builtin rules) sees them.
    sensitive: true,
    system: SYSTEM,
    maxTokens: 4000,
    tools: [],
    schema: clusterSchema,
    logInput: { items: items.length, minSize },
    prompt: `Fasse die nummerierten Tickets und Rückmeldungen zu wiederkehrenden Problemen zusammen. Ein Cluster braucht mindestens ${minSize} Einträge.
- "label": kurzer Name des Problems, "summary": ein bis zwei Sätze, worum es geht, "items": die Nummern der Einträge.
- Ein Eintrag gehört zu höchstens einem Cluster. Einträge ohne passenden Cluster lässt du weg.
- Gruppiere nie nach Personen, Teams oder Abteilungen und nenne keine Namen. Es geht um Probleme, nicht um Menschen.

${fence('eintraege', items.map((i) => `${i.ref}: ${i.text.slice(0, 600)}`).join('\n'))}`,
    builtin: (l) => {
      const texts = items.map((i) => safe(i.text));
      const sets = texts.map((t) => new Set(keywords(t, 8)));
      const df = new Map<string, number>();
      sets.forEach((s) => s.forEach((k) => df.set(k, (df.get(k) ?? 0) + 1)));
      const order = [...df.entries()].filter(([, n]) => n >= minSize).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const taken = new Set<number>();
      const clusters: ClusterOutput['clusters'] = [];
      for (const [term] of order) {
        const members = sets.map((s, i) => (s.has(term) && !taken.has(i) ? i : -1)).filter((i) => i >= 0);
        if (members.length < minSize) continue;
        // Second term shared by at least half of the members makes the label more telling.
        const co = new Map<string, number>();
        members.forEach((i) => sets[i].forEach((k) => k !== term && co.set(k, (co.get(k) ?? 0) + 1)));
        const second = [...co.entries()].filter(([, n]) => n >= Math.ceil(members.length / 2)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
        members.forEach((i) => taken.add(i));
        const terms = [term, ...(second ? [second] : [])];
        clusters.push({
          label: terms.map(cap).join(' · ').slice(0, 120),
          summary: T(l, 'radar.cluster.summary', { n: members.length, terms: terms.join(', ') }).slice(0, 600),
          items: members.map((i) => items[i].ref),
        });
        if (clusters.length >= 20) break;
      }
      return { clusters };
    },
  };
}
