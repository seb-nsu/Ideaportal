import type { Settings } from './settings.js';

// Boundary check (R1-18): detects concerns that do not belong in the idea portal
// (reports under the whistleblower protection act, incidents, complaints, safety).
// Runs locally; the text is never sent to an external service.

export interface BoundaryMatch {
  category: string;
  label: string;
  keywords: string[];
  channel: { name: string; contact: string; url: string } | null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkBoundary(text: string, settings: Settings): BoundaryMatch[] {
  const haystack = text.toLowerCase();
  const matches: BoundaryMatch[] = [];
  for (const rule of settings.boundaryRules) {
    const found = rule.keywords.filter((kw) =>
      new RegExp(`(^|[^\\p{L}])${escapeRegex(kw.toLowerCase())}`, 'u').test(haystack),
    );
    if (found.length === 0) continue;
    const channel = settings.targetChannels.find((c) => c.kind === rule.channelKind);
    matches.push({
      category: rule.category,
      label: rule.label,
      keywords: found,
      channel: channel ? { name: channel.name, contact: channel.contact, url: channel.url } : null,
    });
  }
  return matches;
}
