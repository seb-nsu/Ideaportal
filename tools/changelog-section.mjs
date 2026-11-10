#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version (release notes of the GitHub release).
// Matches headings like "## 0.4.0 – 13.10.2026", "## [0.4.0]" or "## v0.4.0".
// Usage: node tools/changelog-section.mjs <version> [CHANGELOG.md]   exit 1 if the section is missing.
import { readFileSync } from 'node:fs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const file = process.argv[3] ?? 'CHANGELOG.md';
if (!/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(version)) {
  console.error('usage: node tools/changelog-section.mjs <version> [file]');
  process.exit(2);
}

const escaped = version.replace(/[.+]/g, '\\$&');
const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`);
const lines = readFileSync(file, 'utf8').split('\n');
const start = lines.findIndex((l) => heading.test(l));
if (start < 0) {
  console.error(`no section for ${version} in ${file}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
if (end < 0) end = lines.length;
console.log(
  lines
    .slice(start + 1, end)
    .join('\n')
    .trim(),
);
