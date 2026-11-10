#!/usr/bin/env node
// Text catalogue check (R2-50): visible texts belong in the catalogue, not in the code.
// Web: JSX text and user-facing attributes (aria-label, title, placeholder, alt, label) with
// letters. Server: literal messages passed to error helpers, AI errors and warnings, and notifications.
// A line may opt out with the comment "texts-ok" (e.g. brand names, technical identifiers).
// Usage: node tools/check-texts.mjs [--list] [files...]   exit 1 when texts are found.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const list = args.includes('--list');
const only = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));

function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'i18n' && name !== 'node_modules') out.push(...walk(p, ext));
    } else if (ext.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const LETTERS = /[A-Za-zÄÖÜäöüß]{2,}/;
const webRules = [
  // >Text<  (JSX text between tags, not inside braces)
  { re: />\s*([^<>{}=;()|&]*[A-Za-zÄÖÜäöüß]{2,}[^<>{}=;()|&]*)\s*</g, what: 'JSX text' },
  { re: /\b(?:aria-label|title|placeholder|alt|label|hint|summary)=(["'])([^"']*[A-Za-zÄÖÜäöüß]{2,}[^"']*)\1/g, what: 'attribute' },
  // string literals with German umlauts or typical German words in code
  { re: /(['"`])((?:(?!\1).)*(?:[äöüÄÖÜß]|\b(?:Bitte|nicht|keine|wird|werden|oder|und|der|die|das|mit|für)\b)(?:(?!\1).)*)\1/g, what: 'string' },
];
const serverRules = [
  { re: /\b(?:badRequest|forbidden|notFound|conflict)\(\s*(['"`])((?:(?!\1).)+)\1/g, what: 'error message' },
  { re: /new HttpError\(\s*\d+\s*,\s*(['"`])((?:(?!\1).)+)\1/g, what: 'error message' },
  // AI gateway (server/src/ai/): errors of models and search, warnings at AI results.
  { re: /new (?:AiError|ProviderError)\(\s*(['"`])((?:(?!\1).)+)\1/g, what: 'error message' },
  { re: /\bwarnings(?:\.push\(|: \[)\s*(['"`])((?:(?!\1).)*[A-Za-zÄÖÜäöüß]{3,}(?:(?!\1).)*)\1/g, what: 'warning' },
  { re: /\bnotify(?:User|Roles|Authors)\([^)]*?(['"`])((?:(?!\1).)*[A-Za-zÄÖÜäöüß]{3,}(?:(?!\1).)*)\1/g, what: 'notification' },
];

const files = [
  ...walk(path.join(root, 'web/src'), ['.tsx', '.ts']).map((f) => ({ f, rules: webRules })),
  ...walk(path.join(root, 'server/src'), ['.ts']).filter((f) => !f.includes(`${path.sep}db${path.sep}`)).map((f) => ({ f, rules: serverRules })),
].filter((x) => !only.length || only.includes(x.f));

let total = 0;
const perFile = [];
for (const { f, rules } of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  let n = 0;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (line.includes('texts-ok') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('import ')) return;
    // TypeScript generics (api.post<T>(…), Promise<void>) are not JSX text.
    const code = line
      .replace(/\b(?:Promise|Record|Array|Partial|Set|Map)<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, 'G')
      .replace(/\b[A-Za-z_$][\w$.]*<(?!\/)[^<>]*(?:<[^<>]*>[^<>]*)*>(?=\s*\()/g, 'G');
    for (const r of rules) {
      for (const match of code.matchAll(r.re)) {
        const text = (match[2] ?? match[1] ?? '').trim();
        if (!LETTERS.test(text) || /^[a-z0-9_.-]+$/i.test(text) && !/[äöüß]/i.test(text) && (r.what === 'string' || r.what === 'notification' || r.what === 'warning')) continue; // ids, roles, catalogue keys
        n++;
        if (list) console.log(`${path.relative(root, f)}:${i + 1}  ${r.what}: ${text.slice(0, 80)}`);
      }
    }
  });
  if (n) perFile.push([path.relative(root, f), n]);
  total += n;
}
// Every German key has an English text and vice versa (R3-22).
if (!only.length) {
  for (const side of ['web/src/i18n', 'server/src/i18n']) {
    const keys = (dir) => {
      const out = new Set();
      for (const name of readdirSync(path.join(root, side, dir))) {
        if (name === 'index.ts') continue;
        for (const m of readFileSync(path.join(root, side, dir, name), 'utf8').matchAll(/^\s*'([\w.-]+)':/gm)) out.add(m[1]);
      }
      return out;
    };
    const de = keys('de');
    const en = keys('en');
    const missing = [...de].filter((k) => !en.has(k));
    const extra = [...en].filter((k) => !de.has(k));
    if (missing.length || extra.length) {
      total += missing.length + extra.length;
      perFile.push([`${side}/en (missing ${missing.length}, unknown ${extra.length})`, missing.length + extra.length]);
      if (list) for (const k of [...missing, ...extra]) console.log(`${side}  ${missing.includes(k) ? 'no English text' : 'not in German catalogue'}: ${k}`);
    }
  }
}
for (const [f, n] of perFile.sort((a, b) => b[1] - a[1])) if (!list) console.log(`${String(n).padStart(4)}  ${f}`);
console.log(`${total} text(s) outside the catalogue`);
process.exit(total ? 1 : 0);
