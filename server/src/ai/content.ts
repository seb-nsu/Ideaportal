import { z } from 'zod';
import { refText } from '../i18n/index.js';

// Labelled AI content (R2-11): every statement is a fact (only with a source from the list
// the gateway handed to the model), an assumption, or an estimate with a confidence.
// Sources are never invented by the model: it can only point to numbered sources that a
// tool returned, so every link shown to people really exists.

export const confidence = z.enum(['low', 'medium', 'high']);

export const claimSchema = z.object({
  text: z.string().min(1).max(2000),
  kind: z.enum(['fact', 'assumption', 'estimate']),
  sources: z.array(z.number().int()),
  confidence: confidence.nullable(),
});
export type ModelClaim = z.infer<typeof claimSchema>;

export const sectionSchema = z.object({
  heading: z.string().min(1).max(200),
  claims: z.array(claimSchema).max(30),
});
export type ModelSection = z.infer<typeof sectionSchema>;

export interface Source {
  id: number;
  title: string;
  url: string;
  snippet: string;
  origin: 'web' | 'internal' | 'patent';
  retrievedAt: string;
  /** Source check with page fetch (R2-46): page reachable and search snippet found in the page text. */
  check?: SourceCheck;
  /** Excerpt of the fetched page for the prompt (fenced as untrusted); never stored. */
  excerpt?: string;
}

export interface SourceCheck {
  reachable: boolean;
  status: number | null;
  quoteFound: boolean | null;
  checkedAt: string;
}

export interface Claim {
  id: string;
  text: string;
  kind: 'fact' | 'assumption' | 'estimate';
  sources: number[];
  confidence: 'low' | 'medium' | 'high' | null;
  /** Set when the gateway changed the label, e.g. a number without a source. */
  note?: string;
  /** Source check (R2-46): the statement was found in the text of a cited page, or not. */
  check?: 'confirmed' | 'not_found';
}

export interface Section {
  heading: string;
  claims: Claim[];
}

const NUMBER = /\d/;

// Phrases that judge people; the AI must never evaluate persons (guardrail 5).
const PERSON_JUDGEMENT = /(^|[^\p{L}])(unfähig\p{L}*|inkompetent\p{L}*|faul|faule[nrs]?|minderleister\p{L}*|leistungsschwach\p{L}*|nichtsnutz\p{L}*)(?![\p{L}])/iu;

// Typical prompt-injection phrasing in idea texts, comments and web pages (R2-13). The list is
// the second line of defence: untrusted input is also fenced structurally (fenceUntrusted), and
// the system text says that fenced content is data, never instructions.
const INJECTION = [
  /ignorier\w*\s+(alle\s+|die\s+|deine\s+)?(vorherigen|bisherigen|obigen|früheren|oberen)?\s*(anweisungen|instruktionen|regeln|vorgaben)/iu,
  /ignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/iu,
  /(vergiss|vergesst|missachte)\s+(alle\s+|die\s+|deine\s+)?(vorherigen\s+|bisherigen\s+)?(anweisungen|regeln|vorgaben)/iu,
  /(forget|disregard)\s+(all\s+|any\s+|the\s+|your\s+)?(previous\s+|prior\s+|above\s+)?(instructions|rules|guidelines)/iu,
  /system\s*-?\s*prompt/iu,
  /(gib|zeige|nenne|schreibe)\s+.{0,40}(zugangsdaten|passw(o|ö)rter|api-?schlüssel|geheimnisse)/iu,
  /(reveal|print|show|output)\s+.{0,40}(credentials|passwords?|api\s*keys?|secrets|instructions)/iu,
  /(setze|ändere|stelle)\s+(die\s+)?spur\s+auf/iu,
  /(set|change)\s+(the\s+)?lane\s+to/iu,
  /(bewerte|beurteile)\s+(die|den)\s+(ideengeber\w*|autor\w*|einreicher\w*|person\w*)/iu,
  /du\s+bist\s+(jetzt|ab\s+sofort|nun)\s+/iu,
  /you\s+are\s+now\s+/iu,
  /(neue|geänderte)\s+anweisung(en)?\s*:/iu,
  /new\s+instructions?\s*:/iu,
  /^(assistant|assistent|system)\s*:\s*(ignor|vergiss|forget|du\s|you\s|neue|new|antworte|answer|setze|set\s|gib|give)/iu,
  /<\/?\s*(system|instructions?|untrusted(_input)?)\b[^>]*>/iu,
  /an\s+die\s+ki\s*:|to\s+the\s+(ai|model|assistant)\s*:/iu,
];

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sentences of an untrusted text that look like instructions to the AI. */
export function findInjections(text: string): string[] {
  return splitSentences(text).filter((s) => INJECTION.some((re) => re.test(s)));
}

/** Removes sentences that look like instructions; used before echoing untrusted text. */
export function stripInjections(text: string): string {
  const flagged = new Set(findInjections(text));
  if (!flagged.size) return text;
  return splitSentences(text).filter((s) => !flagged.has(s)).join(' ');
}

export function judgesPersons(text: string): boolean {
  return PERSON_JUDGEMENT.test(text);
}

// Contact data in AI output (data minimisation): e-mail addresses and phone numbers that the
// submitter typed are not repeated in analyses and drafts. Contact data from the workspace
// settings (e.g. the address of a target channel) stays untouched.
const EMAIL = /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/gu;
const PHONE = /(?:\+|00)\d{1,3}[\s/-]?(?:\(0\)\s?)?\d{2,5}(?:[\s/-]?\d{2,8}){1,3}|(?<![\p{L}0-9])0\d{2,5}[\s/-]\d{3,8}(?:[\s-]\d{1,6})?(?![\p{L}0-9])/gu;
export const MASK = '[…]';

/** E-mail addresses and phone numbers in a text. */
export function contactData(text: string): string[] {
  return [...new Set([...(text.match(EMAIL) ?? []), ...(text.match(PHONE) ?? [])].map((x) => x.trim()).filter((x) => x.length >= 6))];
}

let contactContext: string[] = [];

/** Contact data of the untrusted input; finalize sets it before the output is cleaned. */
export function setContactContext(untrusted: string): void {
  contactContext = contactData(untrusted).sort((a, b) => b.length - a.length);
}

/** Replaces the given contact data (default: the current context) by a neutral placeholder. */
export function maskContactData(text: string, contacts: string[] = contactContext): string {
  let out = text;
  for (const c of contacts) out = out.split(c).join(MASK);
  return out;
}

function hasContactData(text: string, contacts: string[] = contactContext): boolean {
  return contacts.some((c) => text.includes(c));
}

// ---------------------------------------------------------------- structural isolation (R2-13)

/** Tag of the data blocks around untrusted input (idea texts, comments, search results, documents). */
export const UNTRUSTED_TAG = 'untrusted_input';

/**
 * Neutralises anything in untrusted text that could close or open a data block or pose as a
 * system or instruction tag: the angle bracket is replaced by its HTML entity, so the model
 * still reads the text, but no tag can end the block early.
 */
export function escapeUntrusted(text: string): string {
  return text.replace(/<(\/?)\s*(untrusted(?:_input)?|system|instructions?|assistant|user|human)\b/giu, (_all, slash: string, tag: string) => `&lt;${slash}${tag}`);
}

/** Short, stable id of a data block: name plus a hash of the content (no randomness, so prompt versions stay stable). */
function blockId(name: string, text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${name.replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || 'data'}-${(h >>> 0).toString(36)}`;
}

/** Wraps untrusted input in a delimited data block; the content can never close the block. */
export function fenceUntrusted(name: string, text: string): string {
  const body = escapeUntrusted(text);
  return `<${UNTRUSTED_TAG} id="${blockId(name, body)}">\n${body}\n</${UNTRUSTED_TAG}>`;
}

/** Words that only occur in the injected sentences, not in the rest of the untrusted text. */
function distinctiveWords(injections: string[], context: string): string[] {
  const rest = context.toLowerCase();
  const words = new Set(injections.flatMap((i) => i.toLowerCase().match(/\p{L}{5,}/gu) ?? []));
  return [...words].filter((w) => !rest.includes(w));
}

let injectionContext = '';

function overlapsInjection(text: string, injections: string[]): boolean {
  if (INJECTION.some((re) => re.test(text))) return true;
  if (!injections.length) return false;
  const t = text.toLowerCase();
  const hits = distinctiveWords(injections, injectionContext).filter((w) => t.includes(w));
  return hits.some((w) => w.length >= 8) || hits.length >= 2;
}

/** The untrusted text without its injected sentences; distinctive words are measured against it. */
export function setInjectionContext(untrusted: string, injections: string[]): void {
  const flagged = new Set(injections);
  injectionContext = splitSentences(untrusted).filter((s) => !flagged.has(s)).join(' ');
}

export interface NormalizeResult<T> {
  value: T;
  warnings: string[];
}

/**
 * Applies the labelling rules to sections from a model: drops unknown source references,
 * downgrades facts without a source, marks numbers without a source as estimates, removes
 * statements that judge people or repeat injected instructions.
 */
export function normalizeSections(sections: ModelSection[], sources: Source[], injections: string[], prefix = 's'): NormalizeResult<Section[]> {
  const warnings: string[] = [];
  const known = new Set(sources.map((s) => s.id));
  let n = 0;
  const out: Section[] = [];
  for (const sec of sections) {
    const claims: Claim[] = [];
    for (const c of sec.claims) {
      if (judgesPersons(c.text)) {
        warnings.push(refText('aigw.warn.person'));
        continue;
      }
      if (overlapsInjection(c.text, injections)) {
        warnings.push(refText('aigw.warn.injectedStatement'));
        continue;
      }
      const refs = c.sources.filter((id) => known.has(id));
      if (refs.length < c.sources.length) warnings.push(refText('aigw.warn.unknownSources'));
      if (hasContactData(c.text)) warnings.push(refText('aigw.warn.contactData'));
      const claim: Claim = { id: `${prefix}${++n}`, text: maskContactData(c.text.trim()), kind: c.kind, sources: refs, confidence: c.confidence };
      if (claim.kind === 'fact' && refs.length === 0) {
        claim.kind = NUMBER.test(claim.text) ? 'estimate' : 'assumption';
        claim.note = refText('aigw.note.noSource');
      }
      if (claim.kind === 'estimate' && !claim.confidence) claim.confidence = 'low';
      if (claim.kind === 'assumption' && NUMBER.test(claim.text) && refs.length === 0) {
        claim.kind = 'estimate';
        claim.confidence ??= 'low';
      }
      claims.push(claim);
    }
    out.push({ heading: sec.heading.trim(), claims });
  }
  return { value: out, warnings: [...new Set(warnings)] };
}

/** Plain strings in agent output (e.g. a draft text) get the same people and injection checks. */
export function cleanText(text: string, injections: string[], warnings: string[]): string {
  if (hasContactData(text)) {
    warnings.push(refText('aigw.warn.contactData'));
    text = maskContactData(text);
  }
  const kept = splitSentences(text).filter((s) => {
    if (judgesPersons(s)) {
      warnings.push(refText('aigw.warn.person'));
      return false;
    }
    if (overlapsInjection(s, injections)) {
      warnings.push(refText('aigw.warn.injectedStatement'));
      return false;
    }
    return true;
  });
  return kept.length === splitSentences(text).length ? text : kept.join(' ');
}

/** Flat list of the claim texts, e.g. for comparing versions (R2-32). */
export function claimTexts(sections: Section[]): string[] {
  return sections.flatMap((s) => s.claims.map((c) => c.text));
}

export interface ChangeSet {
  added: string[];
  removed: string[];
}

export function diffClaims(previous: Section[] | undefined, next: Section[]): ChangeSet {
  const before = new Set(claimTexts(previous ?? []));
  const after = new Set(claimTexts(next));
  return {
    added: [...after].filter((t) => !before.has(t)),
    removed: [...before].filter((t) => !after.has(t)),
  };
}
