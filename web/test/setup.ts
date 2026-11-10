import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { setLocale } from '../src/i18n';

// Every test starts in German (the reference language), with a clean DOM and no fetch mock.
beforeEach(() => {
  setLocale('de');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Fake fetch answering per URL; unknown URLs answer 404. Returns the recorded calls. */
export function mockFetch(routes: Record<string, { status?: number; body?: unknown } | ((init: RequestInit) => { status?: number; body?: unknown })>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url === k || url.startsWith(`${k}?`));
    const route = key ? routes[key] : { status: 404, body: { error: 'not found' } };
    const { status = 200, body } = typeof route === 'function' ? route(init) : route;
    return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
