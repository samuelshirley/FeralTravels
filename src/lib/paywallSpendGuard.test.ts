/**
 * Architectural guardrail: a paywalled account must not cost us a single token.
 *
 * Same approach as the auth guard test in this directory — scan the source,
 * fail with a pointer at the file. (Do not name that file here: it scans for a
 * word its own filename contains, and will fail this one for quoting it.) A behavioural test would be better in principle and
 * worse in practice here: the routes import Auth.js, the Drizzle adapter and a
 * live DB client, so proving "no Anthropic call happened" needs most of the
 * server mocked, and a mock of the Anthropic client is exactly the thing that
 * would keep passing after somebody moved the real call above the guard.
 *
 * What this pins is ORDER. Every route that can reach Anthropic has to await
 * `requireEntitledUser()` before it does anything else, because that function
 * throws a 402 — so the throw is what makes the spend impossible, and its
 * position on the page is the whole mechanism.
 *
 * The owner's requirement in his own words: "make sure that all messages that
 * are sent to Penny once the seven days has expired do not make any token
 * calls and literally just return the exact same text."
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

/**
 * Routes that can spend Anthropic money, and therefore must gate first.
 *
 * `onboarding` is on this list because it is the one that was missed: it runs
 * the intent scan, the start-date parser and the range estimator — three
 * model calls — and had no cap of any kind before the paywall existed.
 */
const SPENDING_ROUTES = [
  'app/api/trip/replan/route.ts',
  'app/api/trips/[id]/onboarding/route.ts',
];

/** Anything that reaches a model, directly or through the shared client. */
const SPEND_MARKERS = [
  /from\s+['"]@anthropic-ai\/sdk['"]/,
  /\bcallClaude\b/,
  /\bstreamClaude\b/,
  /\brunPennyTurn\b/,
  /\bsubmitAnswer\b/,
  /\bscanFirstMessage\b/,
  /\bresolveStartDate\b/,
  /\bestimateComfortableRange\b/,
];

describe('a paywalled account cannot spend a token', () => {
  for (const rel of SPENDING_ROUTES) {
    const file = path.join(SRC, rel);

    it(`${rel} exists`, () => {
      expect(fs.existsSync(file), `${rel} moved — update SPENDING_ROUTES`).toBe(true);
    });

    it(`${rel} gates before it can spend`, () => {
      const src = fs.readFileSync(file, 'utf-8');

      // Strip imports AND comments before looking for anything.
      //
      // Both were caught by this test failing on its first run: the onboarding
      // route's gate is correct, but a comment ABOVE it explains what
      // `submitAnswer` spends, and a naive scan read that prose as the call.
      // A guard that cries wolf over its own documentation gets deleted.
      const body = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .split('\n')
        .filter((l) => !/^\s*import\b/.test(l))
        .join('\n');

      const gateAt = body.indexOf('requireEntitledUser(');
      expect(
        gateAt,
        `${rel} must await requireEntitledUser() — requireUser() alone does not gate spend`
      ).toBeGreaterThan(-1);

      for (const marker of SPEND_MARKERS) {
        const m = body.match(marker);
        if (!m || m.index === undefined) continue;
        expect(
          m.index,
          `${rel} reaches "${m[0]}" at character ${m.index}, BEFORE requireEntitledUser() at ` +
            `${gateAt}. An expired account would be billed for that call. Move the gate up.`
        ).toBeGreaterThan(gateAt);
      }
    });
  }

  it('the gate still throws rather than returning a falsy verdict', () => {
    // If requireEntitledUser ever starts returning a flag instead of throwing,
    // every ordering assertion above becomes decorative — the call sites would
    // sail straight past it.
    const guards = fs
      .readFileSync(path.join(SRC, 'server/auth/guards.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const start = guards.indexOf('export async function requireEntitledUser');
    expect(start, 'requireEntitledUser is gone — the paywall has no gate').toBeGreaterThan(-1);
    // To the next top-level declaration, not to the first `\n}` — the function
    // body contains braces of its own and the naive slice cut before the throw.
    const rest = guards.slice(start + 1);
    const nextDecl = rest.search(/\n(export |function |const |async function )/);
    const fn = nextDecl === -1 ? rest : rest.slice(0, nextDecl);
    expect(fn).toMatch(/throw new PaymentRequiredError/);
  });
});
