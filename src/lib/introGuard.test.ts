import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The first-launch intro's three invariants, read from source.
 *
 *  1. IT SPENDS NOTHING AND NEEDS NO NETWORK. The intro runs before sign-in,
 *     on a fresh install, possibly offline. Nothing it renders may import the
 *     API client (an authenticated call from a signed-out screen, and the road
 *     to a paid one: LegCard fetches fuel), a map view (tiles are paid and need
 *     a network) or a video player. Checked over the whole graph of components
 *     it reaches, not just its own folder: the danger is a reused card.
 *  2. ONLY A FRESH INSTALL SEES IT. The launch gate is the one route to
 *     /intro, and only from its no-token branch — a signed-in user never meets
 *     it, whatever the flag says.
 *  3. SIGNING OUT DOES NOT SHOW IT AGAIN. `clearToken()` never deletes the
 *     intro flag, and nothing else ever does. The flag is written when the
 *     user LEAVES the intro, by either exit, never on mount.
 *
 * Read as text, never imported: `noMobileImportGuard.test.ts` forbids src/
 * importing mobile/, because CI's unit job installs no mobile/node_modules.
 * The device half of 2 and 3 is mobile/maestro/sign-out.yaml and
 * intro-create-trip.yaml, which relaunch a signed-out install and assert
 * /sign-in, not /intro.
 */
const ROOT = path.resolve(__dirname, '../..');
const MOBILE = path.join(ROOT, 'mobile');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Comments blanked, so a word in an explanation is not a reference. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function importsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of code(src).matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code(src).matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** A specifier → the mobile file it names, or null for a package. */
function resolveMobile(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(MOBILE, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const ext of ['', '.tsx', '.ts', '/index.tsx', '/index.ts']) {
    const f = base + ext;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

const FORBIDDEN: Array<{ test: (spec: string, resolved: string | null) => boolean; why: string }> = [
  {
    test: (_s, r) => r === path.join(MOBILE, 'lib/api.ts'),
    why: 'the API client (authenticated calls, and LegCard-style paid fuel fetches)',
  },
  { test: (s) => s === 'react-native-maps', why: 'a map view (paid tiles, network)' },
  { test: (s) => s === 'expo-video', why: 'a video player' },
];

/**
 * Every component file the intro reaches: intro.tsx, then each import that
 * resolves under mobile/components or mobile/app, recursively. lib/ and
 * shared/ are leaves — they are where a component's own imports are checked.
 */
function introGraph(): string[] {
  const start = path.join(MOBILE, 'app/intro.tsx');
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(fs.readFileSync(f, 'utf8'))) {
      const r = resolveMobile(f, spec);
      if (!r) continue;
      const rel = path.relative(MOBILE, r);
      if (rel.startsWith('components/') || rel.startsWith('app/')) queue.push(r);
    }
  }
  return [...seen];
}

describe('the intro spends nothing and needs no network', () => {
  const graph = introGraph();

  it('finds the intro and the components it draws (canary)', () => {
    const rels = graph.map((f) => path.relative(MOBILE, f));
    expect(rels).toContain('app/intro.tsx');
    for (const f of fs.readdirSync(path.join(MOBILE, 'components/intro'))) {
      expect(rels, `components/intro/${f} is not reached from intro.tsx`).toContain(`components/intro/${f}`);
    }
    expect(rels).toContain('components/chat/PlanSummaryCard.tsx');
    expect(rels).toContain('components/RouteTimelineRow.tsx');
  });

  it('no file it reaches imports the API client, a map view or a video player', () => {
    const hits: string[] = [];
    for (const f of graph) {
      for (const spec of importsOf(fs.readFileSync(f, 'utf8'))) {
        const r = resolveMobile(f, spec);
        for (const rule of FORBIDDEN) {
          if (rule.test(spec, r)) hits.push(`${path.relative(MOBILE, f)} imports ${spec} — ${rule.why}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('it never renders LegCard, StopsSection, TripMap or ChatPanel', () => {
    const rels = graph.map((f) => path.relative(MOBILE, f));
    for (const heavy of ['LegCard', 'StopsSection', 'TripMap', 'ChatPanel', 'StopCard']) {
      expect(rels, `${heavy} fetches or spends; the intro must draw from the shared pieces`).not.toContain(
        `components/${heavy}.tsx`
      );
    }
  });
});

describe('only a fresh install sees the intro', () => {
  const decision = code(read('src/lib/launchDestination.ts'));

  it("the shared decision returns /intro only inside the no-token branch", () => {
    const fn = decision.slice(decision.indexOf('export async function resolveLaunchDestination'));
    const noToken = fn.match(/if \(!\(await deps\.hasToken\(\)\)\) \{([\s\S]*?)\n  \}/);
    expect(noToken, 'the no-token branch is gone').not.toBeNull();
    expect(noToken![1]).toMatch(/'\/intro'/);
    expect(noToken![1]).toMatch(/deps\.introSeen\(\)/);
    // Exactly one '/intro' in the function: the one in that branch.
    expect(fn.match(/'\/intro'/g)).toHaveLength(1);
    // And introSeen is consulted nowhere else.
    expect(fn.match(/introSeen\(\)/g)).toHaveLength(1);
  });

  it('the launch gate routes through it and names /intro nowhere itself', () => {
    const gate = code(read('mobile/app/index.tsx'));
    expect(gate).toMatch(/resolveLaunchDestination\(\{/);
    expect(gate).toMatch(/introSeen: getIntroSeen/);
    expect(gate).not.toMatch(/['"`]\/intro/);
  });

  it('nothing else in the app navigates to /intro', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && !e.name.startsWith('.') && e.name !== 'maestro') walk(p);
        } else if (/\.tsx?$/.test(e.name) && /['"`]\/intro\b/.test(code(fs.readFileSync(p, 'utf8')))) {
          hits.push(path.relative(MOBILE, p));
        }
      }
    };
    walk(MOBILE);
    expect(hits.filter((h) => h !== 'shared/lib/launchDestination.ts')).toEqual([]);
  });
});

describe('signing out does not show the intro again', () => {
  const auth = code(read('mobile/lib/auth.ts'));
  const keyName = auth.match(/const (\w+) = "feraltravels\.introSeen";/)?.[1];

  it('the flag has one key, in auth.ts', () => {
    expect(keyName, 'the intro flag key moved or was renamed').toBeTruthy();
  });

  it('clearToken deletes the session and the address, and never the intro flag', () => {
    const start = auth.indexOf('export async function clearToken');
    const body = auth.slice(start, auth.indexOf('\n}\n', start));
    expect(body.length).toBeGreaterThan(50);
    const deleted = [...body.matchAll(/deleteItemAsync\(\s*([^)]+?)\s*\)/g)].map((m) => m[1]);
    expect(deleted.sort()).toEqual(['EMAIL_KEY', 'TOKEN_KEY']);
    expect(body).not.toContain(keyName!);
    expect(body).not.toMatch(/introSeen/i);
  });

  it('nothing in the app ever deletes the intro flag', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p);
        } else if (/\.tsx?$/.test(e.name)) {
          const src = code(fs.readFileSync(p, 'utf8'));
          if (/deleteItemAsync\([^)]*(INTRO_SEEN_KEY|introSeen)/.test(src)) hits.push(path.relative(MOBILE, p));
        }
      }
    };
    walk(MOBILE);
    expect(hits).toEqual([]);
  });

  it('the flag is written when the user leaves the intro, by either exit, never on mount', () => {
    const intro = code(read('mobile/app/intro.tsx'));
    // One write, inside `leave`, started before the navigation.
    expect(intro.match(/setIntroSeen\(\)/g)).toHaveLength(1);
    const leave = intro.slice(intro.indexOf('const leave = useCallback('));
    const leaveBody = leave.slice(0, leave.indexOf('\n  );\n'));
    const writeAt = leaveBody.indexOf('setIntroSeen()');
    const pushAt = leaveBody.indexOf('router.push(');
    expect(writeAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(writeAt);
    // Both exits go through `leave`.
    expect(intro).toMatch(/\bleave\("\/sign-in\?next=new-trip&from=intro"\)/);
    expect(intro).toMatch(/onPress=\{\(\) => leave\("\/sign-in\?from=intro"\)\}/);
    // No effect writes it.
    for (const effect of intro.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)) {
      expect(effect[1]).not.toMatch(/setIntroSeen|leave\(/);
    }
  });

  it('leaving never waits on the keychain write', () => {
    // CI run 41431447677: securityd took 20 s to insert the flag, and an
    // `await setIntroSeen()` before router.push made the exit a dead tap for
    // those 20 s. The write is started, its failure reported, and the
    // navigation happens regardless — nothing between the two may await.
    const intro = code(read('mobile/app/intro.tsx'));
    const leave = intro.slice(intro.indexOf('const leave = useCallback('));
    const leaveBody = leave.slice(0, leave.indexOf('\n  );\n'));
    expect(leaveBody).not.toMatch(/\bawait\b/);
    expect(leaveBody).not.toMatch(/async\s*\(/);
    expect(leaveBody).toMatch(/setIntroSeen\(\)\.catch\(/);
  });
});
