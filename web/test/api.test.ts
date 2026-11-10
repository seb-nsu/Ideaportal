import { describe, expect, it } from 'vitest';
import { ApiError, api } from '../src/api';
import { setLocale, t } from '../src/i18n';
import { mockFetch } from './setup';

// API client: one place for headers, JSON and error handling (R1-44 CSRF header, R3-22 language).

describe('api client', () => {
  it('sends GET requests with the CSRF header and the interface language, and parses JSON', async () => {
    const calls = mockFetch({ '/api/me': { body: { user: { id: 'u1' } } } });
    setLocale('en');
    const me = await api.get<{ user: { id: string } }>('/api/me');
    expect(me.user.id).toBe('u1');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(calls[0].init.headers).toMatchObject({ 'x-requested-with': 'fetch', 'accept-language': 'en' });
    expect(calls[0].init.body).toBeUndefined();
  });

  it('sends JSON bodies with content-type instead of the CSRF header', async () => {
    const calls = mockFetch({ '/api/ideas': { status: 201, body: { id: 'i1' } } });
    const created = await api.post<{ id: string }>('/api/ideas', { title: 'Test' });
    expect(created).toEqual({ id: 'i1' });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(calls[0].init.headers).not.toHaveProperty('x-requested-with');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: 'Test' });
  });

  it('uses the right method for patch, put and delete, and accepts empty answers', async () => {
    const calls = mockFetch({ '/api/x': { status: 204 } });
    expect(await api.patch('/api/x', { a: 1 })).toBeNull();
    expect(await api.put('/api/x', { a: 1 })).toBeNull();
    expect(await api.del('/api/x')).toBeNull();
    expect(calls.map((c) => c.init.method)).toEqual(['PATCH', 'PUT', 'DELETE']);
  });

  it('turns error answers into ApiError with status, message, code and details', async () => {
    mockFetch({ '/api/ideas/1': { status: 409, body: { error: 'Schon entschieden', code: 'CONFLICT', details: { field: 'status' } } } });
    const err = await api.get('/api/ideas/1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 409, message: 'Schon entschieden', code: 'CONFLICT', details: { field: 'status' } });
  });

  it('uses the catalogue text when the server sends no message', async () => {
    mockFetch({ '/api/broken': { status: 500 } });
    const err = (await api.get('/api/broken').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(500);
    expect(err.message).toBe(t('components.unknownError'));
    expect(err.code).toBeUndefined();
  });
});
