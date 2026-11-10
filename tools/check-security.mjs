#!/usr/bin/env node
// Lightweight static security check (R3-09), no dependencies. Fails on patterns that must not
// appear in server or web code; lists dynamic SQL for the manual review of the pentest
// preparation (docs/sicherheit/pentest-vorbereitung.md). A line may opt out with "security-ok"
// and a reason in the same line.
// Usage: node tools/check-security.mjs [--list]   exit 1 on findings.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const list = process.argv.includes('--list');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!['node_modules', 'dist', 'i18n'].includes(name)) out.push(...walk(p));
    } else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const RULES = [
  { id: 'eval', re: /\beval\s*\(|new Function\s*\(/, what: 'dynamic code execution' },
  { id: 'html', re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/, what: 'raw HTML injection' },
  { id: 'exec', re: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(/, what: 'shell execution' },
  { id: 'tls', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, what: 'TLS certificate check switched off' },
  { id: 'random', re: /Math\.random\s*\(/, what: 'Math.random (use node:crypto for tokens)', serverOnly: true },
  { id: 'secret', re: /sk-ant-[A-Za-z0-9]|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}/, what: 'secret in code' },
  { id: 'cors', re: /access-control-allow-origin['"]?\s*,\s*['"]\*/i, what: 'CORS wildcard' },
];
// Dynamic SQL: template literals with interpolation passed to query(). Allowed when the
// interpolated parts are fixed fragments or column lists from code; listed for review.
const DYNAMIC_SQL = /\.query(?:<[^>]*>)?\(\s*`[^`]*\$\{/;

const files = [...walk(path.join(root, 'server/src')), ...walk(path.join(root, 'web/src'))];
const findings = [];
const review = [];
for (const f of files) {
  const rel = path.relative(root, f);
  const server = rel.startsWith('server/');
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (line.includes('security-ok')) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    for (const r of RULES) {
      if (r.serverOnly && !server) continue;
      if (r.re.test(line)) findings.push(`${rel}:${i + 1}  ${r.what}: ${trimmed.slice(0, 100)}`);
    }
    if (server && DYNAMIC_SQL.test(line)) review.push(`${rel}:${i + 1}  ${trimmed.slice(0, 120)}`);
  });
}

if (list || findings.length) for (const x of findings) console.log(x);
if (list) {
  console.log(`\nDynamic SQL for manual review (${review.length}):`);
  for (const x of review) console.log(`  ${x}`);
}
console.log(`Security check: ${findings.length} findings, ${review.length} dynamic SQL lines to review (--list).`);
process.exit(findings.length ? 1 : 0);
