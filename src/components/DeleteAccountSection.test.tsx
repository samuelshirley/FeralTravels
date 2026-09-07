/**
 * The delete-account confirm makes the phrase stand out, and the disarmed
 * button looks inert.
 *
 * Two things went wrong on the same dialog (2026-09-07): the phrase to type
 * was rendered at body weight, so it read as part of the sentence and people
 * typed "delete"; and the disarmed Delete button was a danger tint with danger
 * text, so a mismatch in the box looked like a button ignoring the click. Both
 * are asserted through the rendered DOM. The native dialog is the same design
 * and is held to it by `src/lib/deleteAccountEmphasisGuard.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import DeleteAccountSection from './DeleteAccountSection';
import { DELETE_CONFIRM_PHRASE } from '@/lib/accountDeletion';

afterEach(() => cleanup());

function openDialog() {
  render(<DeleteAccountSection />);
  fireEvent.click(screen.getByTestId('delete-account-open'));
  return {
    phrase: screen.getByTestId('delete-account-phrase'),
    input: screen.getByTestId('delete-account-confirm-input') as HTMLInputElement,
    button: screen.getByTestId('delete-account-confirm-button') as HTMLButtonElement,
  };
}

describe('DeleteAccountSection (web) — the confirm dialog', () => {
  it('sets the phrase apart from the sentence: semibold, the armed button label weight', () => {
    const { phrase, button } = openDialog();
    expect(phrase).toHaveTextContent(DELETE_CONFIRM_PHRASE);
    // 600, explicitly — a bare <strong> is the browser's 700 and the button
    // is 600; the phrase and the label that acts on it share one face.
    expect(phrase.style.fontWeight).toBe('600');
    expect(button.style.fontWeight).toBe('600');
  });

  it('disarmed: disabled, and carrying NO danger colour', () => {
    const { button } = openDialog();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-armed', 'false');
    expect(button.style.background).toBe('transparent');
    expect(button.style.color).toBe('var(--tp-subtle)');
    expect(button.style.border).toContain('var(--tp-border)');
    expect(button.style.border).not.toContain('danger');
    expect(button.style.cursor).toBe('not-allowed');
  });

  it('a near miss ("delete") stays disarmed', () => {
    const { input, button } = openDialog();
    fireEvent.change(input, { target: { value: 'delete' } });
    expect(button).toBeDisabled();
    expect(button.style.background).toBe('transparent');
  });

  it('the exact phrase arms it: the solid danger fill comes back', () => {
    const { input, button } = openDialog();
    fireEvent.change(input, { target: { value: DELETE_CONFIRM_PHRASE } });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('data-armed', 'true');
    expect(button.style.background).toBe('var(--tp-danger)');
    expect(button.style.color).toBe('var(--tp-bg)');
    expect(button.style.border).toContain('var(--tp-danger-border)');
    expect(button.style.cursor).toBe('pointer');
  });
});
