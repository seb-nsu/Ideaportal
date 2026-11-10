import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../src/i18n';
import { Login } from '../src/pages/Login';
import { mockFetch } from './setup';

// Login page with a mocked API: sign-in, server errors, workspace choice and password reset.

function renderLogin(path = '/login', onLoggedIn = vi.fn(async () => undefined)) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<Login onLoggedIn={onLoggedIn} />} />
        <Route path="/" element={<p>start page</p>} />
        <Route path="/ideen" element={<p>ideas page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return onLoggedIn;
}

function fillAndSubmit(email = 'mia@example.org', password = 'geheim-123456') {
  fireEvent.change(screen.getByLabelText(t('login.email')), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(t('login.password')), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: t('login.submit') }));
}

describe('Login page', () => {
  it('renders an accessible form in the current language', () => {
    renderLogin();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('login.title'));
    expect((screen.getByLabelText(t('login.email')) as HTMLInputElement).type).toBe('email');
    expect((screen.getByLabelText(t('login.password')) as HTMLInputElement).autocomplete).toBe('current-password');
    // Password reset needs an address first.
    expect((screen.getByRole('button', { name: t('login.forgotPassword') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('signs in, calls onLoggedIn and follows the "weiter" parameter', async () => {
    const calls = mockFetch({ '/api/auth/login': { body: { ok: true } }, '/api/auth/sso': { body: { available: false } } });
    const onLoggedIn = renderLogin('/login?mandant=acme&weiter=/ideen');
    fillAndSubmit();
    expect(await screen.findByText('ideas page')).toBeTruthy();
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    const login = calls.find((c) => c.url === '/api/auth/login')!;
    expect(JSON.parse(String(login.init.body))).toEqual({ tenant: 'acme', email: 'mia@example.org', password: 'geheim-123456' });
  });

  it('shows the server message on wrong credentials and stays on the page', async () => {
    mockFetch({
      '/api/auth/login': { status: 401, body: { error: 'E-Mail oder Passwort falsch.', code: 'INVALID_CREDENTIALS' } },
      '/api/auth/sso': { body: { available: false } },
    });
    const onLoggedIn = renderLogin();
    fillAndSubmit();
    expect((await screen.findByRole('alert')).textContent).toBe('E-Mail oder Passwort falsch.');
    expect(onLoggedIn).not.toHaveBeenCalled();
    expect(screen.queryByText('start page')).toBeNull();
  });

  it('lets people with accounts in several workspaces choose one', async () => {
    const calls = mockFetch({
      '/api/auth/sso': { body: { available: false } },
      '/api/auth/login': (init) => {
        const body = JSON.parse(String(init.body)) as { tenant?: string };
        return body.tenant
          ? { body: { ok: true } }
          : {
              body: {
                chooseWorkspace: [
                  { slug: 'nord', name: 'Werk Nord' },
                  { slug: 'sued', name: 'Werk Süd' },
                ],
              },
            };
      },
    });
    const onLoggedIn = renderLogin();
    fillAndSubmit();
    fireEvent.click(await screen.findByRole('button', { name: 'Werk Süd' }));
    expect(await screen.findByText('start page')).toBeTruthy();
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    const logins = calls.filter((c) => c.url === '/api/auth/login').map((c) => JSON.parse(String(c.init.body)).tenant);
    expect(logins).toEqual([undefined, 'sued']);
  });

  it('requests a password reset and confirms without revealing whether the address exists', async () => {
    const calls = mockFetch({ '/api/auth/reset-request': { body: { ok: true } }, '/api/auth/sso': { body: { available: false } } });
    renderLogin();
    fireEvent.change(screen.getByLabelText(t('login.email')), { target: { value: 'wer@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: t('login.forgotPassword') }));
    expect((await screen.findByRole('status')).textContent).toBe(t('login.resetSent'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/reset-request')).toBe(true));
  });

  it('shows the company login button when the workspace has one', async () => {
    mockFetch({ '/api/auth/sso': { body: { available: true, tenant: 'acme', name: 'Acme', localLogin: false } } });
    renderLogin('/login?mandant=acme');
    const button = await screen.findByRole('link', { name: t('identity.login.button') });
    expect(button.getAttribute('href')).toBe('/api/auth/oidc/start?tenant=acme');
    // Company login only: no password form.
    expect(screen.queryByLabelText(t('login.password'))).toBeNull();
  });
});
