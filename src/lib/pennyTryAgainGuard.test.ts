import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRY_AGAIN_LABEL } from './pennyFallbackRetry';

/**
 * "Try again" on Penny's dead end is rendered from the SERVER'S flag and sent
 * through the NORMAL send path — on both chat panels.
 *
 * Two ways this goes wrong without any behaviour test noticing on the native
 * side (the root vitest project cannot render mobile/, and the Maestro flow
 * runs only on a macOS job):
 *   - a panel matches Penny's sentence instead of reading `fallback_meta`, so
 *     rewording her line silently removes the button, and any reply that
 *     happens to say it grows one;
 *   - a panel posts the resend itself, a second send pipeline that skips the
 *     consent gate, the idempotency key, the queue and the error bubbles.
 * The web panel's behaviour is ChatPanel.tryAgain.test.tsx; this holds both
 * panels to the same wiring, read as TEXT (noMobileImportGuard.test.ts).
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const SENTENCE = /apply that cleanly|rephrase and try again/i;

/** The code with its comments removed — a comment may QUOTE her sentence; code may not match it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The body of `const <name> = async (…) => { … };` at two-space indent. */
function body(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = async`);
  if (start < 0) return '';
  const end = source.indexOf('\n  };\n', start);
  return end < 0 ? '' : source.slice(start, end);
}

const PANELS = [
  {
    name: 'web',
    path: 'src/components/ChatPanel.tsx',
    shared: '@/lib/pennyFallbackRetry',
    button: /data-testid="penny-try-again"[\s\S]{0,120}onClick=\{\(\) => void retryFallback\(fallbackResend\)\}/,
  },
  {
    name: 'native',
    path: 'mobile/components/ChatPanel.tsx',
    shared: '@/shared/lib/pennyFallbackRetry',
    button: /testID="penny-try-again"[\s\S]{0,200}onPress=\{\(\) => void retryFallback\(fallbackResend\)\}/,
  },
] as const;

describe.each(PANELS)('the $name chat panel', (panel) => {
  const src = read(panel.path);

  it('takes the decision from the shared rule', () => {
    expect(src).toMatch(
      new RegExp(`import \\{ fallbackResendFor, TRY_AGAIN_LABEL, type FallbackResend \\} from ["']${panel.shared}["']`),
    );
    expect(src).toMatch(/fallbackResendFor\((messages|visibleMessages)\)/);
  });

  it("never matches Penny's sentence", () => {
    expect(code(src)).not.toMatch(SENTENCE);
  });

  it('carries the live flag onto the bubble, so a live fallback offers it like a reloaded one', () => {
    expect(src).toMatch(/fallback_meta: ev\.fallback \?\? null,/);
  });

  it('renders the button only on the bubble the rule chose, labelled by the shared constant', () => {
    expect(src).toMatch(/fallbackResend && fallbackResend\.assistantId === msg\.id/);
    expect(src).toMatch(panel.button);
    expect(src).toMatch(/\{TRY_AGAIN_LABEL\}/);
    expect(src).toMatch(/disabled=\{retrying \|\| loading\}/);
  });

  it('sends through sendChatMessage and nothing else', () => {
    const retry = body(src, 'retryFallback');
    expect(retry, 'retryFallback not found').not.toBe('');
    expect(retry).toMatch(/await sendChatMessage\(\s*resend\.text,/);
    expect(retry).toMatch(/resend\.handoff,\s*resend\.handoff,?\s*\)/);
    expect(retry).not.toMatch(/\bfetch\(|apiFetch\(|api\.|\/api\/trip\/replan|startTurnStream/);
  });

  it('shows a failed resend inline instead of swallowing it', () => {
    expect(body(src, 'retryFallback')).toMatch(/catch \(err\) \{\s*setRetryError\(\{/);
    expect(src).toMatch(/testID="penny-try-again-error"|data-testid="penny-try-again-error"/);
  });

  it('keeps the live hand-off as the hidden `handoff` row, so its fallback resends as a hand-off', () => {
    expect(src).toMatch(/kind: handoff \? ["']handoff["'] : ["']ai["'],/);
    expect(src).not.toMatch(/\.\.\.\(handoff \? \[\] : \[tempUserMsg\]\)/);
  });
});

describe('the shared rule', () => {
  const rule = read('src/lib/pennyFallbackRetry.ts');

  it("reads the server's flag and never the reply's text", () => {
    expect(rule).toMatch(/const meta = reply\.fallback_meta;/);
    expect(rule).not.toMatch(/reply\.content/);
    expect(code(rule)).not.toMatch(SENTENCE);
  });

  it('labels the button exactly "Try again"', () => {
    expect(TRY_AGAIN_LABEL).toBe('Try again');
  });
});

describe('the server marks it', () => {
  const route = read('src/app/api/trip/replan/route.ts');

  it('on the persisted row and on the streamed payload, from the same value', () => {
    expect(route).toMatch(/const fallbackMeta: ChatFallbackMeta \| null = final\.fallback/);
    expect(route).toMatch(/planSummary,\s*null,\s*null,\s*fallbackMeta,\s*\);/);
    expect(route).toMatch(/fallback: fallbackMeta,/);
  });
});
