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
 *
 * The native panel has a second first-run race, of the same class as the
 * paywall bubble's: it loads its own history with a wholesale
 * `setMessages(...)`, so a setup question drawn before that history landed was
 * wiped by the empty transcript, and the first-run screen sat on Penny's
 * typing dots with no greeting — 4 of 12 iOS e2e flakes, failing on
 * `onboarding-headline`. The last block holds the question effect to waiting
 * for `historyLoading`, in its gate AND its deps (a gate without the dep never
 * re-runs once the history lands). Mutation-checked by removing each.
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

/** The effect that appends the setup question bubble: its early-return gate, and its deps. */
function questionEffect(src: string): { gate: string; deps: string } {
  const at = src.indexOf('const addQuestionBubble');
  expect(at, 'addQuestionBubble is gone — update this guard to find the question effect').toBeGreaterThan(-1);
  const start = src.lastIndexOf('useEffect(', at);
  const gate = src.slice(start, src.indexOf('return;', start));
  const deps = /\}, \[([^\]]*)\]\);/.exec(src.slice(at));
  expect(deps, 'the question effect has no deps array').not.toBeNull();
  return { gate, deps: deps![1] };
}

describe('mobile/components/ChatPanel.tsx — setup question vs. history', () => {
  const src = code('mobile/components/ChatPanel.tsx');

  it('loads history with a wholesale replace (the reason the gate below exists)', () => {
    // If this ever becomes a merge, the gate is belt-and-braces rather than
    // load-bearing — revisit this block rather than deleting it.
    expect(src).toMatch(/setMessages\(data\.messages\)/);
  });

  it('draws no setup question until the history has loaded', () => {
    const { gate, deps } = questionEffect(src);
    expect(gate, 'the question effect draws before history lands').toMatch(/\|\|\s*historyLoading\s*\|\|/);
    expect(deps.split(',').map((d) => d.trim()), 'historyLoading is not a dep, so the effect never re-runs when history lands').toContain('historyLoading');
  });
});
