/**
 * The type-to-confirm contract for account deletion, shared by every surface.
 *
 * This module is mirrored into mobile/shared by `npm run sync-shared`, so the
 * web confirm box, the native confirm box and the server all compare against
 * one definition. If they ever disagreed, the failure is silent and nasty: a
 * user types what the UI asked for and the server refuses, or worse, a client
 * accepts a phrase the server never required.
 *
 * DOM-free and dependency-free on purpose — that is the price of admission to
 * the mirror.
 */

/** The exact words the user has to type before the delete button arms. */
export const DELETE_CONFIRM_PHRASE = 'delete account';

/**
 * Trimmed and case-insensitive. The gesture exists to force a deliberate pause
 * and make an accidental tap impossible, not to test anyone's shift key — a
 * phone keyboard that autocapitalises the first letter should not be a wall.
 */
export function isDeleteConfirmationValid(input: string | null | undefined): boolean {
  if (!input) return false;
  return input.trim().toLowerCase() === DELETE_CONFIRM_PHRASE;
}
