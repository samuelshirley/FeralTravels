/**
 * Both ChatPanels show the START HERE empty state only when setup is KNOWN to
 * be off.
 *
 * The gate was `messages.length === 0 && !onboardingUiActive`. That boolean
 * was false while setup was off AND while setup's snapshot was still loading,
 * so every first-run trip painted START HERE and then swapped it for the
 * onboarding card — shipped to TestFlight build 8. The repro sat in the suite
 * as an `it.fails`, which is green while the bug is present, so CI said
 * nothing the whole time.
 *
 * `ChatPanel.onboardingFlash.test.tsx` renders the web panel and catches it
 * at runtime. `mobile/` has no unit test runner, so for the native panel this
 * file is the only thing that can fail: it reads both sources and holds them
 * to the shape of the fix — the phase comes from the shared
 * `onboardingPhase()`, `onboardingUiActive` is `phase === 'active'` and
 * nothing looser, and the empty state is gated on the POSITIVE
 * `onboardingPhase === 'off'`.
 *
 * Mutation-checked on each panel: restoring `!onboardingUiActive` as the
 * empty-state gate, or deriving `onboardingUiActive` from the snapshot again,
 * turns this red naming that file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const PANELS = ['src/components/ChatPanel.tsx', 'mobile/components/ChatPanel.tsx'];

/** Source with comments removed, so a comment that names the old gate is not a match. */
function code(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The JSX condition that opens the block containing the START HERE kicker. */
function starterGate(src: string): string {
  const at = src.indexOf('START HERE');
  expect(at, 'START HERE is gone — update this guard to find the empty state').toBeGreaterThan(-1);
  const open = src.lastIndexOf('{messages.length === 0', at);
  expect(open, 'the empty state is no longer gated on an empty transcript').toBeGreaterThan(-1);
  return src.slice(open, src.indexOf('(', open));
}

describe.each(PANELS)('%s', (rel) => {
  const src = code(rel);

  it('derives the phase from the shared onboardingPhase()', () => {
    expect(src).toMatch(/import \{ onboardingPhase as deriveOnboardingPhase \} from ["']@\/(shared\/)?lib\/onboardingPhase["']/);
    expect(src).toMatch(/const onboardingPhase = deriveOnboardingPhase\(/);
  });

  it('defines onboardingUiActive as the active phase and nothing else', () => {
    expect(src).toMatch(/const onboardingUiActive = onboardingPhase === ["']active["'];/);
  });

  it('gates START HERE on the known-off phase, not on a negated boolean', () => {
    const gate = starterGate(src);
    expect(gate).toMatch(/onboardingPhase === ["']off["']/);
    expect(gate).not.toMatch(/!\s*onboardingUiActive/);
  });
});
