/**
 * Architectural guard for App Review 5.1.2(i): no server path sends a user's
 * content to Anthropic without that user's recorded agreement.
 *
 * The mechanism is a PROOF (`src/server/aiConsent.ts`): `requireAiConsent`
 * mints one only for an account with `users.ai_consent_at` set, and every
 * function that calls the Anthropic SDK demands one and verifies it with
 * `assertAiConsent` before it builds a client. The type system then makes a
 * call without a proof fail to compile. What the compiler cannot see, this
 * file pins:
 *
 *   1. THE SINKS ARE ALL KNOWN. Every non-test file under src/ that constructs
 *      an Anthropic client or calls `messages.create`/`messages.stream` is in
 *      SINKS. A new one fails here until it is added — and adding it means
 *      item 2 applies to it.
 *   2. EVERY CALL INTO THE SDK IS BEHIND THE CHECK. In each sink, the function
 *      containing each `getClient()` call runs `assertAiConsent(` before it.
 *   3. EVERY ROUTE THAT CAN REACH A SINK ASKS. Walking the real import graph
 *      from every `route.ts`, a route that can reach a sink calls
 *      `requireAiConsent(` — after its ownership check, before the first
 *      Anthropic-bound call — or is listed in NO_USER_CONTENT with the reason
 *      it cannot send a user's content.
 *   4. NOBODY FORGES THE PROOF. `as AiConsentProof` appears only in
 *      aiConsent.ts and in test files (whose doubles never reach a real sink:
 *      the runtime WeakSet check would throw if one did).
 *
 * Mutation-checked when written (2026-10-20): deleting the
 * `requireAiConsent` line from either route, deleting `assertAiConsent` from
 * `estimateRange`, adding an unlisted `new Anthropic(` file, and adding a cast
 * in a non-test file each turned this red.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

/** Every module that talks to the Anthropic SDK on a user's behalf. */
const SINKS = [
  'src/lib/claude.ts',
  'src/server/pennyClassifier.ts',
  'src/server/onboardingIntentScan.ts',
  'src/server/parseRangeEstimate.ts',
  'src/server/parseStartDate.ts',
];

/**
 * Routes that import a sink's module graph but cannot send a user's content:
 * each reaches `src/server/onboarding.ts` only for the canned transcript
 * builder (`seededTranscript.ts`), and every Anthropic-bound function there
 * demands a proof these routes never mint. Fixture/admin routes, never a
 * user's request.
 */
const NO_USER_CONTENT: Record<string, string> = {
  'src/app/api/admin/test-users/route.ts': 'admin: builds a canned transcript, no model call',
  'src/app/api/test/announcement/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/breakers/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/cleanup/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/deletion/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/maps-link-stop/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/otp/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/seed/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/subscription/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/trip/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/turn/route.ts': 'test fixture (testSupport → seededTranscript)',
};

/** The calls that put user content into a prompt; the consent check must precede the first. */
const ANTHROPIC_BOUND = /\b(submitAnswer|gateMessage|replanStream|replan|classifyMessage|scanFirstMessage|resolveStartDate|parseDateWithLLM|estimateRange)\(/;

function rel(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) && !p.startsWith(path.join(SRC, 'test') + path.sep)) {
      out.push(p);
    }
  }
  return out;
}

/** Source with comments removed, so prose never counts as code. */
function code(abs: string): string {
  return fs
    .readFileSync(abs, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Value imports only: `import type` / `export type` carry no runtime edge. */
function valueImports(abs: string): string[] {
  const src = code(abs);
  const specs: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs.map((s) => resolveImport(abs, s)).filter((x): x is string => !!x);
}

const FILES = walk(SRC);
const ROUTES = FILES.filter((f) => f.endsWith(`${path.sep}route.ts`));

/**
 * For every file that can reach a sink, the next hop towards it. A reverse
 * breadth-first walk from the sinks over the whole import graph — not a
 * memoised DFS, which marks a file "unreachable" when it is visited inside an
 * import cycle and then trusts that wrong answer (the first draft did, and
 * lost ten routes).
 */
const NEXT_HOP = (() => {
  const importers = new Map<string, string[]>();
  for (const f of FILES) {
    for (const dep of valueImports(f)) {
      if (!importers.has(dep)) importers.set(dep, []);
      importers.get(dep)!.push(f);
    }
  }
  const next = new Map<string, string | null>();
  const queue: string[] = [];
  for (const s of SINKS) {
    const abs = path.join(ROOT, s);
    next.set(abs, null);
    queue.push(abs);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const imp of importers.get(cur) ?? []) {
      if (next.has(imp)) continue;
      next.set(imp, cur);
      queue.push(imp);
    }
  }
  return next;
})();

/** The import chain from `abs` to a sink, or null. */
function chainToSink(abs: string): string[] | null {
  if (!NEXT_HOP.has(abs)) return null;
  const chain = [abs];
  let hop = NEXT_HOP.get(abs);
  while (hop) {
    chain.push(hop);
    hop = NEXT_HOP.get(hop);
  }
  return chain;
}

describe('AI consent guard — the sinks', () => {
  it('every file that calls the Anthropic SDK is a known sink', () => {
    const callers = FILES.filter((f) => /new\s+Anthropic\s*\(|\.messages\.(create|stream)\s*\(/.test(code(f))).map(rel);
    expect(callers.length, 'the scan found no SDK call at all — the regex broke').toBeGreaterThanOrEqual(SINKS.length);
    const unknown = callers.filter((f) => !SINKS.includes(f));
    expect(
      unknown,
      'These files call the Anthropic SDK but are not in SINKS. Make the function demand an ' +
        'AiConsentProof and call assertAiConsent before getClient(), then list the file here.',
    ).toEqual([]);
  });

  for (const sink of SINKS) {
    it(`${sink}: every SDK client use is behind assertAiConsent`, () => {
      const src = code(path.join(ROOT, sink));
      const uses = [...src.matchAll(/\bgetClient\(\)/g)].map((m) => m.index!);
      // The definition `function getClient()` is not a use.
      const calls = uses.filter((i) => !/function\s+$/.test(src.slice(Math.max(0, i - 20), i)));
      expect(calls.length, `${sink}: found no getClient() call — the guard no longer sees the SDK`).toBeGreaterThan(0);
      for (const at of calls) {
        // The top-level declaration this call sits in: the last column-0
        // function/const declaration before it.
        const before = src.slice(0, at);
        const decls = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/gm)];
        const decl = decls[decls.length - 1];
        expect(decl, `${sink}: getClient() at ${at} is outside any function`).toBeTruthy();
        const body = src.slice(decl!.index!, at);
        expect(
          body,
          `${sink}: ${decl![1]}() calls getClient() without assertAiConsent( first — ` +
            'user content would reach Anthropic without the user agreeing.',
        ).toMatch(/assertAiConsent\(/);
      }
    });
  }
});

describe('AI consent guard — the routes', () => {
  const reaching = ROUTES.map((r) => ({ route: rel(r), chain: chainToSink(r) })).filter((x) => x.chain);

  it('finds the user-facing routes that reach Anthropic', () => {
    // Guards the graph walk: if it stopped following imports, every check
    // below would pass vacuously.
    const names = reaching.map((r) => r.route);
    expect(names).toContain('src/app/api/trip/replan/route.ts');
    expect(names).toContain('src/app/api/trips/[id]/onboarding/route.ts');
  });

  it('every NO_USER_CONTENT entry still exists and still reaches a sink (no stale exemptions)', () => {
    const names = new Set(reaching.map((r) => r.route));
    for (const r of Object.keys(NO_USER_CONTENT)) expect(names.has(r), `${r} is exempt but no longer reaches a sink — remove it`).toBe(true);
  });

  for (const route of ROUTES) {
    const name = rel(route);
    const chain = chainToSink(route);
    if (!chain || name in NO_USER_CONTENT) continue;
    it(`${name} asks for consent before anything Anthropic-bound`, () => {
      const body = code(route)
        .split('\n')
        .filter((l) => !/^\s*import\b/.test(l))
        .join('\n');
      const gate = body.indexOf('requireAiConsent(');
      expect(
        gate,
        `${name} reaches ${rel(chain[chain.length - 1])} via ${chain.map(rel).join(' → ')} but never calls ` +
          'requireAiConsent(). Call it after the ownership check and before the first model-bound call, ' +
          'or — only if the route cannot send a user’s content — add it to NO_USER_CONTENT with the reason.',
      ).toBeGreaterThan(-1);
      const owner = body.indexOf('assertTripOwnedByUser(');
      if (owner > -1) {
        expect(gate, `${name}: consent is checked before ownership, so a stranger would be told to consent`).toBeGreaterThan(owner);
      }
      const first = body.match(ANTHROPIC_BOUND);
      expect(first, `${name}: no Anthropic-bound call found — update ANTHROPIC_BOUND`).toBeTruthy();
      expect(first!.index!, `${name}: ${first![0]} runs before requireAiConsent()`).toBeGreaterThan(gate);
    });
  }
});

describe('AI consent guard — the proof cannot be fabricated', () => {
  it('`as AiConsentProof` appears only in aiConsent.ts', () => {
    const casts = FILES.filter((f) => rel(f) !== 'src/server/aiConsent.ts' && /\bas\s+(unknown\s+as\s+)?AiConsentProof\b/.test(code(f))).map(rel);
    expect(casts, 'A cast mints a proof without asking the user. Use requireAiConsent().').toEqual([]);
  });

  it('requireAiConsent throws rather than returning a falsy verdict', () => {
    const src = code(path.join(ROOT, 'src/server/aiConsent.ts'));
    const start = src.indexOf('export async function requireAiConsent');
    const fn = src.slice(start, src.indexOf('\nexport', start + 1));
    expect(fn).toMatch(/if \(!consentedAt\) throw new AiConsentRequiredError\(\)/);
    expect(fn).toMatch(/MINTED\.add\(proof\)/);
  });
});
