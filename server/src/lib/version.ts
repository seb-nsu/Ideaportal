import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// App version and build commit (docs/enterprise/qualitaet-und-lieferkette.md). The version comes
// from server/package.json (same relative path from src/ and dist/), the commit from GIT_COMMIT,
// which the Docker build sets via --build-arg GIT_COMMIT=<sha>.

const packageJson = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');

let cached: { version: string; commit: string | null } | undefined;

export function buildInfo(): { version: string; commit: string | null } {
  if (!cached) {
    let version = '0.0.0';
    try {
      version = (JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string }).version ?? version;
    } catch {
      // package.json missing (unusual layout): keep the fallback
    }
    const commit = (process.env.GIT_COMMIT ?? '').trim();
    cached = { version, commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : null };
  }
  return cached;
}

/** For tests: forget the cached values. */
export function resetBuildInfo(): void {
  cached = undefined;
}
