#!/usr/bin/env node
// Prettier check for the files changed against a base commit (CI, docs/enterprise/qualitaet-und-lieferkette.md).
// The code base predates Prettier; reformatting everything at once would touch every file and
// collide with parallel work. So: files ADDED since the base must be formatted (exit 1),
// files MODIFIED since the base are reported as warnings only. With --strict, modified files
// block as well (switch on once the repository has been formatted in one go).
// Usage: node tools/format-changed.mjs <base-ref> [--strict] [--write]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const write = args.includes('--write');
const base = args.find((a) => !a.startsWith('--')) ?? 'origin/main';
const EXT = /\.(ts|tsx|js|mjs|cjs|json|css|ya?ml)$/;

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8' }).trim();
}

function changed(filter) {
  const out = git('diff', '--name-only', `--diff-filter=${filter}`, `${base}...HEAD`);
  return out ? out.split('\n').filter((f) => EXT.test(f) && existsSync(f)) : [];
}

/** Files Prettier would change (respects .prettierignore). */
function unformatted(files) {
  if (!files.length) return [];
  try {
    execFileSync('npx', ['prettier', '--list-different', '--ignore-unknown', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    return [];
  } catch (err) {
    // Exit code 1 = some files differ; anything else is a real error.
    if (err.status !== 1) throw err;
    return String(err.stdout).split('\n').filter(Boolean);
  }
}

const added = changed('AC');
const modified = changed('MR');
const badAdded = unformatted(added);
const badModified = unformatted(modified);

if (write) {
  // Like the check: new files always, changed files only with --strict (no whole-file reformat of old code).
  const files = strict ? [...badAdded, ...badModified] : badAdded;
  if (files.length) execFileSync('npx', ['prettier', '--write', ...files], { stdio: 'inherit' });
  console.log(`formatted ${files.length} file(s)`);
  process.exit(0);
}

const gha = !!process.env.GITHUB_ACTIONS;
for (const f of badAdded) console.log(gha ? `::error file=${f}::New file is not formatted (npm run format)` : `error   ${f} (new file, not formatted)`);
for (const f of badModified) {
  const level = strict ? 'error' : 'warning';
  console.log(gha ? `::${level} file=${f}::Changed file is not formatted (npm run format)` : `${level.padEnd(7)} ${f} (changed file, not formatted)`);
}
console.log(`format check against ${base}: ${added.length} new, ${modified.length} changed, ${badAdded.length + badModified.length} not formatted`);
process.exit(badAdded.length || (strict && badModified.length) ? 1 : 0);
