/**
 * No purchase sheet a customer or an App Review tester can open may tell them
 * the store is not ready.
 *
 * The incident: on 2026-09-21 the sheet showed "The App Store isn't offering
 * these plans yet — these are the prices, not a checkout." The cause was App
 * Store Connect (StoreKit returned both product ids as invalid), and the
 * sentence was honest — but it was the copy for EVERY build, so the first
 * reviewer to land in that state would have read, in our own words, that the
 * app was not finished.
 *
 * The fix is structural, and this guard holds its three parts:
 *
 *  1. The customer's copy (`unavailableMessage`, and the Buy/Restore failure
 *     lines in `purchaseOutcome.ts`) never uses the vocabulary of an
 *     unfinished app — checked against every reason. `misconfigured` said
 *     "isn't set up correctly in this build" until this guard was written.
 *  2. The developer's five-way copy lives in `purchaseDiagnostics.ts`, and the
 *     app may reach it ONLY as `__DEV__ ? require(...) : null`, which Metro
 *     folds out of a release bundle before collecting dependencies. A static
 *     import anywhere would ship it. (The Mobile typecheck CI job bundles the
 *     app in release mode and greps for the sentinel — the proof on the actual
 *     artifact; this is the fast, local half.)
 *  3. No diagnostic sentence, and no copy of the old one, lives anywhere else
 *     in the app, where it could be rendered without going through (2).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unavailableMessage, type UnavailableReason } from './purchaseMode';
import {
  purchaseOutcomeMessage,
  restoreOutcomeMessage,
  type PurchaseFailureReason,
} from './purchaseOutcome';
import { PURCHASE_DIAGNOSTICS_SENTINEL, unavailableDiagnostic } from './purchaseDiagnostics';

const ROOT = process.cwd();

/** Every way a tap on Buy or Restore can fail — all reachable in a release build. */
const FAILURES: PurchaseFailureReason[] = [
  'network',
  'store',
  'not_allowed',
  'payment_invalid',
  'unavailable',
  'misconfigured',
  'unknown',
];

const REASONS: UnavailableReason[] = [
  'no_key',
  'store_empty',
  'store_error',
  'no_match',
  'no_plans',
];

/**
 * Words that tell a reader the app, or our paperwork, is unfinished. None of
 * them is ever the reader's problem, and all of them read as "not ready" to a
 * reviewer.
 */
const NOT_READY_VOCABULARY: RegExp[] = [
  /\byet\b/i,
  /not a checkout/i,
  /isn'?t offering/i,
  /\bthis build\b/i,
  /isn'?t connected/i,
  /App Store Connect/i,
  /RevenueCat/i,
  /agreement/i,
  /metadata/i,
  /offering/i,
  /product id/i,
  /\bconfigur/i,
  /\bnot (?:set up|wired)/i,
  /\bcoming soon\b/i,
];

/** The app's own source: everything under mobile/ that Metro can bundle. */
function mobileSourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'ios', 'android', '.expo', 'dist', 'maestro']);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name) || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'mobile'));
  return out;
}

const rel = (full: string) => path.relative(ROOT, full);
const DIAGNOSTICS_MIRROR = 'mobile/shared/lib/purchaseDiagnostics.ts';

describe('the customer never reads that the store is not ready', () => {
  it.each(REASONS)('unavailableMessage(%s) uses no not-ready vocabulary', (reason) => {
    const message = unavailableMessage(reason);
    for (const word of NOT_READY_VOCABULARY) {
      expect(message, `unavailableMessage('${reason}') says ${word}: "${message}"`).not.toMatch(word);
    }
  });

  it.each(FAILURES)('the failure copy for %s (Buy and Restore) uses no not-ready vocabulary', (reason) => {
    const messages = [
      purchaseOutcomeMessage({ kind: 'failed', reason }),
      restoreOutcomeMessage({ kind: 'failed', reason }),
    ];
    for (const message of messages) {
      expect(message).toBeTruthy();
      for (const word of NOT_READY_VOCABULARY) {
        expect(message, `failed/${reason} says ${word}: "${message}"`).not.toMatch(word);
      }
    }
  });

  it('the list is not decoration: the old store_empty sentence trips it', () => {
    const old =
      "The App Store isn't offering these plans yet — these are the prices, not a checkout.";
    expect(NOT_READY_VOCABULARY.some((w) => w.test(old))).toBe(true);
  });
});

describe('the developer diagnostic cannot reach a release build', () => {
  it('keeps one distinct diagnostic per reason, each naming its reason', () => {
    const lines = REASONS.map(unavailableDiagnostic);
    expect(new Set(lines).size).toBe(REASONS.length);
    REASONS.forEach((reason, i) => expect(lines[i].startsWith(`${reason}:`)).toBe(true));
  });

  it('is reached from mobile/ only through a __DEV__-guarded require', () => {
    const offenders: string[] = [];
    let guardedRequires = 0;
    for (const file of mobileSourceFiles()) {
      if (rel(file) === DIAGNOSTICS_MIRROR) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('purchaseDiagnostics')) continue;

      // A value import of any kind (static, side-effect, re-export, dynamic).
      // `import type` and `typeof import(...)` are erased and allowed.
      const valueImport =
        /^\s*import\s+(?!type\b)[^;]*?from\s*["'][^"']*purchaseDiagnostics["']/m.test(source) ||
        /^\s*import\s*["'][^"']*purchaseDiagnostics["']/m.test(source) ||
        /^\s*export\s+(?!type\b)[^;]*?from\s*["'][^"']*purchaseDiagnostics["']/m.test(source) ||
        /(?<!typeof\s)\bimport\(\s*["'][^"']*purchaseDiagnostics["']\s*\)/.test(source);
      if (valueImport) offenders.push(`${rel(file)}: value import`);

      for (const m of source.matchAll(/require\(\s*["'][^"']*purchaseDiagnostics["']\s*\)/g)) {
        // The require must be the true arm of a `__DEV__ ?` ternary — the one
        // shape Metro is proven (by the CI bundle check) to fold away.
        const before = source.slice(Math.max(0, m.index! - 80), m.index!);
        if (/__DEV__\s*\?\s*$/.test(before)) guardedRequires++;
        else offenders.push(`${rel(file)}: require not guarded by \`__DEV__ ?\``);
      }
    }
    expect(offenders).toEqual([]);
    // And the sheet does still use it — otherwise the five-way reading is lost.
    expect(guardedRequires).toBeGreaterThan(0);
  });

  it('no diagnostic sentence, the sentinel or the old sentence lives anywhere else in the app', () => {
    const needles = [
      PURCHASE_DIAGNOSTICS_SENTINEL,
      ...REASONS.map((r) => unavailableDiagnostic(r).slice(0, 40)),
      "isn't offering these plans",
      'the prices, not a checkout',
    ];
    const offenders: string[] = [];
    for (const file of mobileSourceFiles()) {
      if (rel(file) === DIAGNOSTICS_MIRROR) continue;
      const source = readFileSync(file, 'utf8');
      for (const n of needles) if (source.includes(n)) offenders.push(`${rel(file)}: "${n}"`);
    }
    expect(offenders).toEqual([]);
  });
});
