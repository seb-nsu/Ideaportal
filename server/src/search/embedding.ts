// Local embedding model for semantic duplicates (R3-28, R1-19).
// The interface lets a real local model (e.g. a multilingual MiniLM/E5 via ONNX) replace the
// built-in one later; see docs/adr/0001-technik-und-mandantenmodell.md. Texts never leave the
// server, so no AI gateway or external service is involved.

export interface EmbeddingModel {
  /** Stored with every vector; a different id marks stored vectors as stale. */
  readonly id: string;
  /** Must match the column type vector(<dim>) in idea_embeddings. */
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIM = 256;

// Frequent German and English function words carry no meaning for duplicates.
const STOPWORDS = new Set(
  ('der die das den dem des ein eine einer einem einen eines und oder aber in im an am auf aus bei mit von vom zu zur zum ' +
    'für fuer über ueber unter nach vor durch ohne um bis als wie wir ihr sie er es ich du man nicht kein keine ist sind war ' +
    'wird werden wurde wurden hat haben kann können koennen soll sollen muss müssen muessen sich so auch noch nur mehr sehr ' +
    'alle jeder jede jedes dass da wenn weil damit dann denn doch schon immer hier dort was wer wo the a an and or of to in ' +
    'on for with by is are be this that it we our')
    .split(' '),
);

const SUFFIXES = ['ungen', 'heiten', 'keiten', 'ung', 'heit', 'keit', 'en', 'er', 'es', 'em', 'e', 'n', 's'];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Very light stemming so that "Wartezeiten" and "Wartezeit" share the word feature. */
function stem(word: string): string {
  for (const s of SUFFIXES) {
    if (word.length - s.length >= 4 && word.endsWith(s)) return word.slice(0, -s.length);
  }
  return word;
}

export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

// FNV-1a, 32 bit.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic hashed-feature embedding: stemmed words plus character trigrams of each word,
 * signed feature hashing into `dim` buckets, sublinear term frequency, L2-normalised.
 * Trigrams make compound words ("Kantinenwartezeit") and typos still overlap.
 */
export function hashedEmbedding(text: string, dim = EMBEDDING_DIM): number[] {
  const counts = new Map<string, number>();
  const add = (f: string, w: number) => counts.set(f, (counts.get(f) ?? 0) + w);
  for (const word of tokens(text)) {
    add(`w:${word}`, 1);
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.35);
  }
  const v = new Array<number>(dim).fill(0);
  for (const [f, c] of counts) {
    const h = hash(f);
    const sign = h & 0x80000000 ? -1 : 1;
    v[h % dim] += sign * (c <= 1 ? c : 1 + Math.log(c));
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

export const hashedNgramModel: EmbeddingModel = {
  id: `hashed-ngram-v1-${EMBEDDING_DIM}`,
  dim: EMBEDDING_DIM,
  embed: async (texts) => texts.map((t) => hashedEmbedding(t)),
};

let current: EmbeddingModel = hashedNgramModel;

/** The model in use. A real local model is registered here at start-up (see ADR 0001). */
export function embeddingModel(): EmbeddingModel {
  return current;
}

/** For tests and for plugging in another local model. */
export function setEmbeddingModel(model: EmbeddingModel): void {
  current = model;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** pgvector text format. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(6)) : 0)).join(',')}]`;
}

/** Text of an idea that the embedding and the trigram fallback compare. */
export function ideaText(i: { title: string; problem: string; solution: string }): string {
  return `${i.title} ${i.title} ${i.problem} ${i.solution}`;
}
