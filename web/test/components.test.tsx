import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { IdeaListItem } from '../src/api';
import { DeadlineLight, Dialog, ErrorBox, Field, IdeaList, LoadMore, StatusBadge, useAction, useLoad, UserPicker } from '../src/components';
import { t, tn } from '../src/i18n';
import { ApiError } from '../src/api';
import { mockFetch } from './setup';

// Shared building blocks of the interface: errors, status, deadlines, forms, dialogs, data hooks.

describe('ErrorBox', () => {
  it('renders nothing without an error, a string or an error object as alert', () => {
    const { container, rerender } = render(<ErrorBox error={null} />);
    expect(container.innerHTML).toBe('');
    rerender(<ErrorBox error="Kaputt" />);
    expect(screen.getByRole('alert').textContent).toBe('Kaputt');
    rerender(<ErrorBox error={new Error('Objekt')} />);
    expect(screen.getByRole('alert').textContent).toBe('Objekt');
  });
});

describe('StatusBadge and DeadlineLight', () => {
  it('shows the short status label with a tone per status', () => {
    const { rerender } = render(<StatusBadge status="completed" />);
    expect(screen.getByText(t('labels.statusShort.completed' as never)).className).toContain('green');
    rerender(<StatusBadge status="rejected" />);
    expect(screen.getByText(t('labels.statusShort.rejected' as never)).className).toContain('red');
    rerender(<StatusBadge status="unknown_status" />);
    expect(screen.getByText('unknown_status').className).toContain('accent');
  });

  it('shows remaining, overdue and paused deadlines with a text for screen readers', () => {
    const { container, rerender } = render(
      <DeadlineLight deadline={{ phase: 'gate1', dueOn: '2026-10-20', remainingWorkdays: 5, light: 'green', paused: false }} />,
    );
    expect(container.textContent).toContain(tn('components.deadline.remaining', 5, { date: '20.10.2026' }));
    expect(container.querySelector('.sr-only')?.textContent).toContain(t('labels.light.green' as never));
    rerender(<DeadlineLight deadline={{ phase: 'gate1', dueOn: '2026-10-01', remainingWorkdays: -2, light: 'red', paused: false }} />);
    expect(container.textContent).toContain(tn('components.deadline.overdue', 2));
    rerender(<DeadlineLight deadline={{ phase: 'gate1', dueOn: '2026-10-01', remainingWorkdays: 4, light: 'paused', paused: true }} />);
    expect(container.textContent).toContain(t('components.deadline.paused', { n: 4 }));
    rerender(<DeadlineLight deadline={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('IdeaList', () => {
  const idea: IdeaListItem = {
    id: 'i1',
    number: 7,
    title: 'Kantine früher öffnen',
    topic: 'Arbeitsumfeld',
    status: 'submitted',
    ideaType: 'internal',
    confidential: true,
    anonymous: true,
    authorName: null,
    supporters: 3,
    comments: 2,
    submittedAt: null,
    createdAt: '2026-10-01T10:00:00Z',
  };

  it('shows the empty text or the ideas with link, anonymous author and confidential badge', () => {
    const { rerender } = render(
      <MemoryRouter>
        <IdeaList ideas={[]} empty="Keine Ideen" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Keine Ideen')).toBeTruthy();
    rerender(
      <MemoryRouter>
        <IdeaList ideas={[idea]} empty="Keine Ideen" />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/ideen/i1');
    expect(link.textContent).toBe('#7 Kantine früher öffnen');
    expect(screen.getByText(t('components.anonymous'))).toBeTruthy();
    expect(screen.getByText(t('components.confidential'))).toBeTruthy();
    expect(screen.getByLabelText(t('components.supporters', { n: 3 }))).toBeTruthy();
  });
});

describe('Field, LoadMore and Dialog', () => {
  it('links label and input and shows the hint', () => {
    render(
      <Field id="titel" label="Titel" hint="Kurz und klar">
        <input id="titel" />
      </Field>,
    );
    expect(screen.getByLabelText('Titel').tagName).toBe('INPUT');
    expect(screen.getByText('Kurz und klar').id).toBe('titel-hint');
  });

  it('LoadMore renders only with a further page and is disabled while busy', () => {
    const onClick = vi.fn();
    const { container, rerender } = render(<LoadMore hasMore={false} busy={false} onClick={onClick} />);
    expect(container.innerHTML).toBe('');
    rerender(<LoadMore hasMore busy={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: t('components.loadMore') }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<LoadMore hasMore busy onClick={onClick} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Dialog is a labelled modal, focuses the first control and closes with Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Wirklich löschen?" onClose={onClose}>
        <button type="button">Ja</button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Wirklich löschen?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Ja');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('data hooks', () => {
  function Loader({ url }: { url: string }) {
    const { data, error, loading } = useLoad<{ name: string }>(url);
    if (loading) return <p>loading</p>;
    return <p>{error ? `error:${error}` : `data:${data?.name}`}</p>;
  }

  it('useLoad loads data and shows server errors', async () => {
    mockFetch({ '/api/ok': { body: { name: 'Anna' } }, '/api/fail': { status: 403, body: { error: 'Keine Berechtigung' } } });
    const { rerender } = render(<Loader url="/api/ok" />);
    expect(await screen.findByText('data:Anna')).toBeTruthy();
    rerender(<Loader url="/api/fail" />);
    expect(await screen.findByText('error:Keine Berechtigung')).toBeTruthy();
  });

  it('useAction keeps busy and error state and turns unknown errors into ApiError', async () => {
    let action!: ReturnType<typeof useAction>;
    function Probe() {
      action = useAction();
      return (
        <p>
          {action.busy ? 'busy' : 'idle'}|{action.error?.message ?? ''}
        </p>
      );
    }
    render(<Probe />);
    let result: unknown;
    await act(async () => {
      result = await action.run(async () => 42);
    });
    expect(result).toBe(42);
    await act(async () => {
      result = await action.run(async () => {
        throw new ApiError(409, 'Konflikt');
      });
    });
    expect(result).toBeUndefined();
    expect(screen.getByText('idle|Konflikt')).toBeTruthy();
    await act(async () => {
      await action.run(async () => {
        throw new TypeError('network');
      });
    });
    expect(action.error).toBeInstanceOf(ApiError);
    expect(action.error?.message).toBe(t('components.unknownError'));
  });

  it('UserPicker searches people after typing and reports the choice', async () => {
    const calls = mockFetch({ '/api/users': { body: [{ id: 'u2', displayName: 'Max Muster', orgUnit: 'Vertrieb' }] } });
    const onChange = vi.fn();
    render(<UserPicker id="owner" value={null} onChange={onChange} role="implementer" />);
    fireEvent.change(screen.getByPlaceholderText(t('components.searchName')), { target: { value: 'Max' } });
    const option = await screen.findByRole('button', { name: 'Max Muster' }, { timeout: 2000 });
    expect(calls[0].url).toBe('/api/users?q=Max&role=implementer');
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith({ id: 'u2', displayName: 'Max Muster', orgUnit: 'Vertrieb' });
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});
