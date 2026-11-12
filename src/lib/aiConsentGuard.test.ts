/**
 * Architectural guard for App Review 5.1.2(i): no server path sends a user's
 * content to ANY third-party AI — Anthropic through its SDK, TypeSafe (Jev)
 * through plain fetch, or anything added later — without that user's
 * recorded agreement to the consent sheet that names it.
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
 *   5. EVERY OUTBOUND CALL IS CLASSIFIED (2026-11-03, when TypeSafe arrived
 *      over plain fetch and the SDK-only scan above could not see it). Every
 *      non-test file that makes a request to anywhere but our own origin is
 *      listed either in AI_HTTP_SINKS — an AI provider, which must assert its
 *      proof before the call, exactly like item 2 — or in OUTBOUND_NOT_AI with
 *      what it calls. A new outbound file fails until someone decides which,
 *      so a new AI provider cannot arrive as "just a fetch". Importing an AI
 *      SDK package by value outside SINKS fails too.
 *   6. EVERY FUNCTION THE JEV MODULE EXPORTS THAT CAN SEND DEMANDS A
 *      `TypeSafeConsentProof`, and the routes that reach Jev ask for consent
 *      like any other sink (item 3 walks to AI_HTTP_SINKS as well).
 *
 * Mutation-checked when written (2026-10-20): deleting the
 * `requireAiConsent` line from either route, deleting `assertAiConsent` from
 * `estimateRange`, adding an unlisted `new Anthropic(` file, and adding a cast
 * in a non-test file each turned this red. Items 5 and 6 (2026-11-03):
 * deleting `assertTypeSafeConsent` from `postSystemOne`, adding an unlisted
 * file that fetches an absolute URL, importing `openai` in an unlisted file,
 * dropping the proof parameter from `startJevCompare`, and adding an
 * `as TypeSafeConsentProof` cast each turned it red.
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
 * AI providers reached by plain HTTP rather than an SDK, and the assert each
 * one's sending function must run before its request (item 5).
 */
const AI_HTTP_SINKS: Record<string, string> = {
  'src/server/jev/client.ts': 'assertTypeSafeConsent',
};

/**
 * Every other file that calls somewhere other than our own origin, and what it
 * calls. None of these is an AI provider; each is named on /privacy where it
 * receives personal data (`legalPagesGuard.test.ts`).
 */
const OUTBOUND_NOT_AI: Record<string, string> = {
  'src/lib/api.ts': "the app's own API — buildUrl() over a same-origin path",
  'src/lib/coordsResolve.ts': 'expands Google Maps short links',
  'src/lib/google/directions.ts': 'Google Directions',
  'src/lib/google/geocode.ts': 'Google Places (searchText)',
  'src/lib/google/places.ts': 'Google Places (along-route search)',
  // Sends a station's place id only — no personal data.
  'src/lib/google/placeDetails.ts': 'Google Places (place details: a station name by place id)',
  'src/lib/osm/nominatim.ts': 'OpenStreetMap Nominatim',
  'src/server/auth/appleDiscovery.ts': "Apple's sign-in key discovery",
  'src/server/auth/appleTokens.ts': "Apple's token revoke endpoint",
  'src/server/auth/jwksSource.ts': "Google's and Apple's sign-in public keys (JWKS)",
};

/** AI SDK packages. A value import of one outside SINKS is an unguarded AI call. */
const AI_SDK_PACKAGES = /^(@anthropic-ai\/|openai$|@openai\/|@google\/(generative-ai|genai)$|@mistralai\/|cohere-ai$|groq-sdk$|replicate$|together-ai$|@huggingface\/inference$|ai$|@ai-sdk\/)/;

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
  'src/app/api/test/feature-request/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/maps-link-stop/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/otp/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/seed/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/subscription/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/trip/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/test/turn/route.ts': 'test fixture (testSupport → seededTranscript)',
  'src/app/api/admin/jev/route.ts': "admin: reads Jev's config status and flips the switch; sends no message",
  'src/app/api/admin/jev/user/route.ts': "admin: sets one account's Jev mode; sends no message",
};

/** The calls that put user content into a prompt; the consent check must precede the first. */
const ANTHROPIC_BOUND = /\b(submitAnswer|gateMessage|replanStream|replan|classifyMessage|scanFirstMessage|resolveStartDate|parseDateWithLLM|estimateRange|jevClassifyTier|startJevCompare)\(/;

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
  for (const s of [...SINKS, ...Object.keys(AI_HTTP_SINKS)]) {
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

/** Each outbound call site in a file: the call and the first thing it is passed. */
function outboundCalls(src: string): Array<{ at: number; call: string; firstArg: string }> {
  const out: Array<{ at: number; call: string; firstArg: string }> = [];
  const re = /(?<![\w$])(?:globalThis\.|window\.|r\.|deps\.)?(fetch|fetchImpl|doFetch)\s*\(|\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\s*\(|\bhttps?\.(request|get)\s*\(/g;
  for (const m of src.matchAll(re)) {
    const after = src.slice(m.index! + m[0].length).replace(/^\s+/, '');
    out.push({ at: m.index!, call: m[0].replace(/\s*\($/, ''), firstArg: after.slice(0, 40) });
  }
  return out;
}

/** A literal path on our own origin: '/api/…', "/x", `/api/${id}`. */
const sameOrigin = (firstArg: string) => /^['"`]\//.test(firstArg);

describe('AI consent guard — every outbound call is classified (item 5)', () => {
  const outbound = FILES.map((f) => ({ file: rel(f), calls: outboundCalls(code(f)).filter((c) => !sameOrigin(c.firstArg)) })).filter(
    (x) => x.calls.length > 0,
  );

  it('the scan finds the outbound files it must (it is not vacuous)', () => {
    const names = outbound.map((o) => o.file);
    expect(names).toContain('src/server/jev/client.ts');
    expect(names).toContain('src/lib/google/places.ts');
    expect(names).toContain('src/lib/osm/nominatim.ts');
  });

  it('every file that calls off-origin is an AI sink or a named non-AI service', () => {
    const unknown = outbound
      .map((o) => o.file)
      .filter((f) => !(f in AI_HTTP_SINKS) && !(f in OUTBOUND_NOT_AI));
    expect(
      unknown,
      'These files make requests to somewhere other than our own origin and are not classified. ' +
        'If the destination is an AI provider, the sending function must demand a consent proof and ' +
        'assert it before the request — then list the file in AI_HTTP_SINKS. Otherwise list it in ' +
        'OUTBOUND_NOT_AI with what it calls (and name that service on /privacy if it receives personal data).',
    ).toEqual([]);
  });

  it('no stale classification: every listed file still calls off-origin', () => {
    const names = new Set(outbound.map((o) => o.file));
    for (const f of [...Object.keys(AI_HTTP_SINKS), ...Object.keys(OUTBOUND_NOT_AI)]) {
      expect(names.has(f), `${f} is classified but makes no off-origin call — remove it`).toBe(true);
    }
  });

  for (const [sink, assertFn] of Object.entries(AI_HTTP_SINKS)) {
    it(`${sink}: every request is behind ${assertFn}`, () => {
      const src = code(path.join(ROOT, sink));
      const calls = outboundCalls(src).filter((c) => !sameOrigin(c.firstArg));
      expect(calls.length, `${sink}: found no request — the guard no longer sees it`).toBeGreaterThan(0);
      for (const c of calls) {
        const before = src.slice(0, c.at);
        const decls = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/gm)];
        const decl = decls[decls.length - 1];
        expect(decl, `${sink}: ${c.call}( at ${c.at} is outside any function`).toBeTruthy();
        const body = src.slice(decl!.index!, c.at);
        expect(
          body,
          `${sink}: ${decl![1]}() makes a request without ${assertFn}( first — a user's message would ` +
            'reach an AI provider without the user agreeing to the sheet that names it.',
        ).toMatch(new RegExp(`\\b${assertFn}\\(`));
      }
    });
  }

  it('no AI SDK is imported (by value) outside the known SDK sinks', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = code(f);
      for (const m of src.matchAll(/^\s*import\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
        if (AI_SDK_PACKAGES.test(m[1]) && !SINKS.includes(rel(f))) offenders.push(`${rel(f)} imports ${m[1]}`);
      }
      for (const m of src.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (AI_SDK_PACKAGES.test(m[1]) && !SINKS.includes(rel(f))) offenders.push(`${rel(f)} loads ${m[1]}`);
      }
    }
    expect(offenders, 'An AI SDK used outside SINKS is a send nobody checked consent for.').toEqual([]);
  });

  it('the classifier of call sites tells our origin from everyone else', () => {
    const calls = outboundCalls(
      "await fetch('/api/me'); await fetch(`/api/x/${id}`); await fetch(url); await fetchImpl(`${base}/v1`); new WebSocket('wss://x'); https.request(opts)",
    );
    expect(calls.map((c) => sameOrigin(c.firstArg))).toEqual([true, true, false, false, false, false]);
  });
});

describe('AI consent guard — the Jev module (item 6)', () => {
  const index = code(path.join(ROOT, 'src/server/jev/index.ts'));

  it('every exported function that can reach the network demands a TypeSafeConsentProof', () => {
    // Exported functions whose body reaches the client (directly, or through
    // the module's own send/jevCompare helpers).
    const exported = [...index.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*:/gm)];
    /** The function's own body: from its first `{` to the matching `}`. */
    const bodyOf = (from: number) => {
      // `from` is just past the parameter list's `):`; return types here carry no braces.
      const open = index.indexOf('{', from);
      let depth = 0;
      for (let i = open; i < index.length; i++) {
        if (index[i] === '{') depth++;
        else if (index[i] === '}' && --depth === 0) return index.slice(open, i + 1);
      }
      return index.slice(open);
    };
    const sending = exported.filter((m) => /\b(send|postSystemOne|jevCompare)\(/.test(bodyOf(m.index! + m[0].length)));
    expect(sending.map((m) => m[1]).sort()).toEqual(['jevClassifyTier', 'startJevCompare']);
    for (const m of sending) {
      expect(m[2], `${m[1]}() can send a message to TypeSafe but takes no TypeSafeConsentProof`).toMatch(
        /:\s*TypeSafeConsentProof\b/,
      );
    }
  });

  it('the client demands the proof and the user, and checks them first', () => {
    const client = code(path.join(ROOT, 'src/server/jev/client.ts'));
    expect(client).toMatch(/consent:\s*TypeSafeConsentProof,\s*userId:\s*string/);
    const fn = client.slice(client.indexOf('export async function postSystemOne'));
    const firstStatement = fn.slice(fn.indexOf('{') + 1).trim();
    expect(firstStatement.startsWith('assertTypeSafeConsent(consent, userId);')).toBe(true);
  });
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
  it('`as AiConsentProof` / `as TypeSafeConsentProof` appear only in aiConsent.ts', () => {
    const casts = FILES.filter(
      (f) => rel(f) !== 'src/server/aiConsent.ts' && /\bas\s+(unknown\s+as\s+)?(AiConsentProof|TypeSafeConsentProof)\b/.test(code(f)),
    ).map(rel);
    expect(casts, 'A cast mints a proof without asking the user. Use requireAiConsent() / typeSafeConsentFrom().').toEqual([]);
  });

  it('typeSafeConsentFrom mints only from a genuine proof of the version that names TypeSafe', () => {
    const src = code(path.join(ROOT, 'src/server/aiConsent.ts'));
    const start = src.indexOf('export function typeSafeConsentFrom');
    const fn = src.slice(start, src.indexOf('\nexport', start + 1));
    expect(fn).toMatch(/!MINTED\.has\(proof\)\) return null/);
    expect(fn).toMatch(/proof\.version >= TYPESAFE_CONSENT_VERSION\)\) return null/);
    expect(fn).toMatch(/MINTED_TYPESAFE\.add\(ts\)/);
  });

  it('requireAiConsent throws rather than returning a falsy verdict', () => {
    const src = code(path.join(ROOT, 'src/server/aiConsent.ts'));
    const start = src.indexOf('export async function requireAiConsent');
    const fn = src.slice(start, src.indexOf('\nexport', start + 1));
    expect(fn).toMatch(/if \(!consentedAt\) throw new AiConsentRequiredError\(\)/);
    expect(fn).toMatch(/MINTED\.add\(proof\)/);
  });
});
