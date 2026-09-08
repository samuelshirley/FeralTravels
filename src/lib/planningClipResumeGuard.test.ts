/**
 * The native planning clip must restart itself when the app comes back.
 *
 * `mobile/` has no test runner (CI's unit job installs no `mobile/node_modules`,
 * and `noMobileImportGuard` forbids `src/` importing from it), so this reads the
 * component as TEXT — the same treatment `deleteAccountEmphasisGuard.test.ts`
 * gives the delete dialog.
 *
 * WHY IT EXISTS. expo-video pauses every non-`staysActiveInBackground` player
 * when the app backgrounds, and its `onAppForegrounded()` is an empty function
 * body — verified in `expo-video@3.0.16/ios/VideoManager.swift`:
 *
 *     func onAppForegrounded() {}
 *
 *     func onAppBackgrounded() {
 *       ...
 *       player.ref.audiovisualBackgroundPlaybackPolicy = .pauses
 *       player.ref.pause()
 *     }
 *
 * So nothing but this component restarts the clip. Without it, backgrounding
 * the app once during a planning turn leaves a frozen frame for the rest of the
 * turn — and since the turn routinely runs 2-4 minutes and the clip is the only
 * thing on screen saying Penny is still working, that reads as a dead app.
 * Reported 2026-09-08 as "the video has died".
 *
 * The web half is covered for real, in jsdom, by
 * `src/components/PennyPlanningLoader.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NATIVE = path.join(
  process.cwd(),
  'mobile/components/chat/PennyPlanningVideo.tsx'
);

function source(): string {
  return readFileSync(NATIVE, 'utf8');
}

/** Strip block + line comments so a rule can't be satisfied by prose about it. */
function code(): string {
  return source()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('native planning clip resumes on foreground', () => {
  it('imports AppState from react-native', () => {
    expect(code()).toMatch(/import\s*\{[^}]*\bAppState\b[^}]*\}\s*from\s*["']react-native["']/);
  });

  it('subscribes to AppState change', () => {
    expect(code()).toMatch(/AppState\.addEventListener\(\s*["']change["']/);
  });

  it('calls play() inside the foreground handler', () => {
    const body = code().split('AppState.addEventListener(')[1] ?? '';
    expect(body).toContain('player.play()');
  });

  it('only resumes for the active state', () => {
    const body = code().split('AppState.addEventListener(')[1] ?? '';
    expect(body).toMatch(/state\s*!==\s*["']active["']/);
  });

  it('leaves the clip paused under Reduce Motion', () => {
    const body = code().split('AppState.addEventListener(')[1] ?? '';
    expect(body).toContain('reducedMotion');
  });

  it('removes the subscription on unmount', () => {
    const body = code().split('AppState.addEventListener(')[1] ?? '';
    expect(body).toMatch(/sub\.remove\(\)/);
  });
});
