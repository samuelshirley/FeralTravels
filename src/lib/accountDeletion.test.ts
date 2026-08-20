import { describe, expect, it } from 'vitest';
import { DELETE_CONFIRM_PHRASE, isDeleteConfirmationValid } from './accountDeletion';

describe('isDeleteConfirmationValid', () => {
  it('accepts the exact phrase', () => {
    expect(isDeleteConfirmationValid(DELETE_CONFIRM_PHRASE)).toBe(true);
  });

  it('tolerates casing and surrounding whitespace', () => {
    // A phone keyboard autocapitalises and a paste drags spaces along. Neither
    // is a signal that the user meant something else.
    expect(isDeleteConfirmationValid('Delete Account')).toBe(true);
    expect(isDeleteConfirmationValid('  delete account  ')).toBe(true);
    expect(isDeleteConfirmationValid('DELETE ACCOUNT')).toBe(true);
  });

  it('rejects anything that is not the phrase', () => {
    // The whole point of the gesture is that a near-miss does not arm the
    // button — otherwise it stops being a deliberate act.
    expect(isDeleteConfirmationValid('delete')).toBe(false);
    expect(isDeleteConfirmationValid('delete my account')).toBe(false);
    expect(isDeleteConfirmationValid('deleteaccount')).toBe(false);
    expect(isDeleteConfirmationValid('delete  account')).toBe(false);
    expect(isDeleteConfirmationValid('')).toBe(false);
    expect(isDeleteConfirmationValid(null)).toBe(false);
    expect(isDeleteConfirmationValid(undefined)).toBe(false);
  });
});
