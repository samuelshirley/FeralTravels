/**
 * "Penny is working" and "which trip CHAT goes back to" may not be screen state.
 *
 * This is a GUARD, not a detector. The component and store tests prove today's
 * code is right; this exists so the class of bug cannot come back, on either
 * platform, without a diff that says so.
 *
 * ── What the class is ─────────────────────────────────────────────────────
 *
 * Both bugs were the same shape: an answer the user needed was kept in the
 * component that happened to be mounted when it was learned, and the component
 * was unmounted before it was needed.
 *
 *  - `thinking` was `useState` in both trip workspaces and `loading` was
 *    `useState` in both chat panels. Both start `false`, so a fresh mount
 *    rendered READY over a live turn. Measured on a simulator, 2026-09-11:
 *    `penny_turns.status = running` at 12:51:48 and 12:52:11, with the live
 *    view hierarchy at 12:52:10 containing a text node reading `READY` and no
 *    `THINKING` node at all.
 *  - The bottom nav is mounted on Settings and on the trips index, where the
 *    trip workspace is not, so it had no way to know which trip the user had
 *    open and sent all three trip tabs to `/trips`.
 *
 * ── Why source text ───────────────────────────────────────────────────────
 *
 * `mobile/` has no test runner and CI's unit job installs no
 * `mobile/node_modules`, so the native half of every rule here can only be
 * checked by reading the file — the same arrangement as
 * `deleteAccountEmphasisGuard`, `goHereLinksGuard` and `planningClipResumeGuard`.
 * The web half is checked twice over, here and by rendering.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const WEB_CHAT = 'src/components/ChatPanel.tsx';
const NATIVE_CHAT = 'mobile/components/ChatPanel.tsx';
const WEB_WORKSPACE = 'src/app/trips/[tripId]/TripWorkspace.tsx';
const NATIVE_WORKSPACE = 'mobile/app/trips/[tripId].tsx';
const WEB_NAV = 'src/components/BottomNav.tsx';
const NATIVE_NAV = 'mobile/components/BottomNav.tsx';

/** Strip comments, so a rule can never be satisfied by prose describing it. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the in-flight indicator is not screen state', () => {
  for (const file of [WEB_WORKSPACE, NATIVE_WORKSPACE]) {
    it(`${file} reads it from the store instead of useState`, () => {
      const src = code(file);
      expect(src).toContain('usePennyRunning(tripId)');
      // The exact shape that was wrong. A setter for it is the tell.
      expect(src).not.toMatch(/setThinking/);
      expect(src).not.toMatch(/useState[^\n]*\bthinking\b/i);
    });
  }

  for (const file of [WEB_CHAT, NATIVE_CHAT]) {
    it(`${file} folds the store into the THINKING/READY derivation`, () => {
      const src = code(file);
      expect(src).toContain('usePennyRunning(tripId)');
      // `loading` alone is the bug; the store has to be part of the expression.
      expect(src).toMatch(/replanWaiting\s*=\s*\(loading\s*\|\|\s*runInFlight\)/);
    });

    it(`${file} tells the store when a turn starts and ends`, () => {
      const src = code(file);
      expect(src).toContain('beginPennyRun(tripId, idempotencyKey)');
      expect(src).toContain('endPennyRun(tripId, idempotencyKey)');
    });

    /**
     * The store is per-process, so it answers nothing after a restart and
     * nothing about a turn another client sent. Asking on mount is what makes
     * the indicator true rather than merely usually-true.
     */
    it(`${file} asks the server on mount whether a turn is already running`, () => {
      const src = code(file);
      expect(src).toContain('reconcilePennyRun(tripId, turn)');
      expect(src).toContain('isTurnInFlight(turn.status)');
    });

    /**
     * And that the reload it does on the way out cannot delete a send made
     * while it was waiting. `setMessages` replaces the array; an optimistic row
     * exists only in client state. The rule is `canReplaceTranscript`, unit
     * tested in pennyRunStore.test.ts — this pins the wiring, which is the half
     * a pure test cannot see.
     */
    it(`${file} never replaces the transcript over a live send`, () => {
      const src = code(file);
      expect(src).toContain('canReplaceTranscript(prev)');
      // The unguarded form, which is what a careless edit reverts to.
      expect(src).not.toMatch(/setMessages\(fresh\.messages\)/);
    });
  }
});

describe('the bottom nav returns to the trip that was open', () => {
  for (const file of [WEB_NAV, NATIVE_NAV]) {
    it(`${file} routes the trip tabs through tripTabDestination`, () => {
      expect(code(file)).toContain('tripTabDestination');
    });

    /**
     * The literal that was the bug. `tripTabDestination` still returns '/trips'
     * as its fallback — that is the one place it belongs, and it is unit-tested
     * in lastOpenTrip.test.ts.
     */
    it(`${file} does not send a trip tab to the index by hand`, () => {
      const src = code(file);
      expect(src).not.toContain("const tripsHref");
      expect(src).not.toMatch(/router\.push\(\s*["']\/trips["']\s*\)/);
    });
  }

  for (const file of [WEB_WORKSPACE, NATIVE_WORKSPACE]) {
    it(`${file} records which trip it is, for the nav to read later`, () => {
      expect(code(file)).toContain('rememberLastOpenTrip(tripId)');
    });
  }
});

describe('signing out empties both stores', () => {
  /**
   * Module state outlives every screen, which is the point of it and the reason
   * it has to be cleared here: the next account on this device would otherwise
   * inherit a trip id it cannot load, so CHAT would land on an error.
   *
   * The web needs no equivalent — `signOut()` from next-auth is a full document
   * navigation, which destroys the module state with the page.
   */
  it('mobile/lib/auth.ts clears them in clearToken', () => {
    const src = code('mobile/lib/auth.ts');
    expect(src).toContain('resetPennyRuns()');
    expect(src).toContain('forgetLastOpenTrip()');
  });
});
