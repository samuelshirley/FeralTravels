/**
 * The guard for scripts/decide-mobile-release.mjs — the OTA-vs-native call the
 * Mobile workflow makes on every merge.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it has already happened:
 *
 * The decision was a regex in a YAML `run:` block, matching on FILE NAME:
 *
 *   NATIVE_RE='^mobile/(app\.config\.js|package\.json|package-lock\.json|eas\.json|assets/)'
 *
 * A merge whose only change to mobile/package.json was
 *
 *   -    "sync:shared": "node ../scripts/sync-shared.mjs",
 *   +    "sync:shared": "cd .. && node scripts/sync-shared.mjs",
 *
 * was classified native. mobile/package-lock.json was untouched, which is
 * proof that no dependency moved. It burned ~30 minutes of EAS queue and a
 * build credit, and — because the native path deliberately SKIPS the OTA —
 * fifteen genuinely-JS files reached nobody until the binary landed.
 *
 * THE ASYMMETRY THE ASSERTIONS ENCODE:
 *
 * A wrongly-chosen native build is slow. A wrongly-chosen OTA is silent: a
 * bundle reaching a binary without the native module it expects crashes on
 * launch on a tester's phone with nothing going red anywhere. So every
 * failure path below asserts `native`, and an unrecognised key asserts
 * `native` too — the allowlist is of things provably unable to reach the
 * binary, and everything else defaults to the expensive-but-safe side.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// Plain ESM JS with no declarations; tsconfig's allowJs infers it, and the
// exports are narrowed to their real shapes just below. Same arrangement as
// sharedMirror.test.ts, which imports scripts/sync-shared.mjs.
import {
  classifyPackageJsonChange,
  decideMobileRelease,
  isAutomaticScriptHook,
} from '../../scripts/decide-mobile-release.mjs';

type Verdict = { native: boolean; reasons: string[] };
type Decision = { decision: 'native' | 'js-only'; reasons: string[] };

const classify = classifyPackageJsonChange as (
  beforeText: unknown,
  afterText: unknown
) => Verdict;

const decide = decideMobileRelease as (input: {
  changedFiles: unknown;
  packageJsonBefore?: string | null;
  packageJsonAfter?: string | null;
}) => Decision;

const isHook = isAutomaticScriptHook as (name: string) => boolean;

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The manifest as it stood BEFORE the merge that caused all this. Written out
 * rather than read from disk so the regression case cannot quietly change
 * shape when someone edits the real file.
 */
const BASE = `{
  "name": "feraltravels-mobile",
  "version": "1.0.0",
  "main": "expo-router/entry",
  "private": true,
  "scripts": {
    "start": "expo start",
    "ios": "expo run:ios",
    "doctor": "npx expo-doctor",
    "typecheck": "tsc --noEmit",
    "sync:shared": "node ../scripts/sync-shared.mjs",
    "android": "expo run:android"
  },
  "dependencies": {
    "expo": "~54.0.37",
    "expo-router": "~6.0.0",
    "react": "19.1.0",
    "react-native": "0.81.5",
    "react-native-maps": "1.20.1"
  },
  "devDependencies": {
    "@types/react": "~19.1.0",
    "typescript": "~5.9.0"
  },
  "expo": {
    "install": { "exclude": [] }
  }
}
`;

/** Apply an edit to BASE by literal substring replacement. */
function edited(from: string, to: string): string {
  expect(BASE.includes(from), `fixture does not contain: ${from}`).toBe(true);
  return BASE.replace(from, to);
}

/** Parse BASE, mutate it, re-serialise. For structural edits. */
function mutated(fn: (manifest: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(BASE) as Record<string, unknown>;
  fn(parsed);
  return JSON.stringify(parsed, null, 2) + '\n';
}

/** The whole-workflow answer for a push that touched only mobile/package.json. */
function decideManifestOnly(before: string | null, after: string | null): Decision {
  return decide({
    changedFiles: ['mobile/package.json'],
    packageJsonBefore: before,
    packageJsonAfter: after,
  });
}

describe('mobile/package.json classification', () => {
  it('THE REGRESSION CASE: a scripts-only change is js-only', () => {
    // Verbatim the diff that cost a build credit and skipped an OTA.
    const after = edited(
      '"sync:shared": "node ../scripts/sync-shared.mjs"',
      '"sync:shared": "cd .. && node scripts/sync-shared.mjs"'
    );
    expect(classify(BASE, after).native).toBe(false);
    expect(decideManifestOnly(BASE, after).decision).toBe('js-only');
  });

  it('a dependency added is native', () => {
    const after = mutated((m) => {
      (m.dependencies as Record<string, string>)['react-native-svg'] = '15.12.1';
    });
    expect(classify(BASE, after).native).toBe(true);
    expect(decideManifestOnly(BASE, after).decision).toBe('native');
  });

  it('a dependency removed is native', () => {
    const after = mutated((m) => {
      delete (m.dependencies as Record<string, string>)['react-native-maps'];
    });
    expect(classify(BASE, after).native).toBe(true);
    expect(decideManifestOnly(BASE, after).decision).toBe('native');
  });

  it('a dependency version bumped is native', () => {
    const after = mutated((m) => {
      (m.dependencies as Record<string, string>)['react-native-maps'] = '1.21.0';
    });
    expect(classify(BASE, after).native).toBe(true);
    expect(decideManifestOnly(BASE, after).decision).toBe('native');
  });

  it('a devDependency moved into dependencies is native', () => {
    const after = mutated((m) => {
      const dev = m.devDependencies as Record<string, string>;
      const deps = m.dependencies as Record<string, string>;
      deps.typescript = dev.typescript;
      delete dev.typescript;
    });
    expect(classify(BASE, after).native).toBe(true);
    expect(decideManifestOnly(BASE, after).decision).toBe('native');
  });

  it('the expo key changed is native — config-plugin config lives there', () => {
    const after = mutated((m) => {
      m.expo = { install: { exclude: ['react-native-maps'] } };
    });
    expect(classify(BASE, after).native).toBe(true);
    expect(decideManifestOnly(BASE, after).decision).toBe('native');
  });

  it('an unrecognised top-level key added is native — the fail-safe default', () => {
    const after = mutated((m) => {
      m.someKeyInventedAfterThisFileWasWritten = { turnsOn: 'who knows' };
    });
    const verdict = classify(BASE, after);
    expect(verdict.native).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('someKeyInventedAfterThisFileWasWritten');
    expect(decideManifestOnly(BASE, after).decision).toBe('native');
  });

  it('the base side unparseable is native', () => {
    expect(classify('{ this is not json', BASE).native).toBe(true);
    expect(decideManifestOnly('{ this is not json', BASE).decision).toBe('native');
  });

  it('the head side unparseable is native', () => {
    expect(classify(BASE, '{ "name": "x", ').native).toBe(true);
    expect(decideManifestOnly(BASE, '{ "name": "x", ').decision).toBe('native');
  });

  it('a missing file on either side is native', () => {
    expect(classify(null, BASE).native).toBe(true);
    expect(classify(BASE, null).native).toBe(true);
    expect(decideManifestOnly(null, BASE).decision).toBe('native');
  });

  it('valid JSON that is not an object is native', () => {
    expect(classify('[]', BASE).native).toBe(true);
    expect(classify(BASE, '"a string"').native).toBe(true);
  });

  it('identical files are js-only', () => {
    expect(classify(BASE, BASE).native).toBe(false);
    expect(decideManifestOnly(BASE, BASE).decision).toBe('js-only');
  });

  it('reformatting and key reordering alone are js-only', () => {
    const parsed = JSON.parse(BASE) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    expect(classify(BASE, JSON.stringify(reordered)).native).toBe(false);
  });

  it('the inert allowlist covers name, version, private and description', () => {
    const after = mutated((m) => {
      m.name = 'feraltravels-mobile-renamed';
      m.version = '2.0.0';
      m.private = true;
      m.description = 'added a description';
    });
    expect(classify(BASE, after).native).toBe(false);
  });

  it('an npm lifecycle hook in scripts is native even though scripts is otherwise inert', () => {
    // patch-package in a postinstall rewrites native source before the binary
    // is compiled. `sync:shared` cannot run itself; `postinstall` can.
    const after = mutated((m) => {
      (m.scripts as Record<string, string>).postinstall = 'patch-package';
    });
    const verdict = classify(BASE, after);
    expect(verdict.native).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('postinstall');
  });

  it('an EAS build hook in scripts is native', () => {
    const after = mutated((m) => {
      (m.scripts as Record<string, string>)['eas-build-pre-install'] = './fiddle-with-pods.sh';
    });
    expect(classify(BASE, after).native).toBe(true);
  });

  it('classifies hook names', () => {
    expect(isHook('postinstall')).toBe(true);
    expect(isHook('prepare')).toBe(true);
    expect(isHook('eas-build-on-success')).toBe(true);
    expect(isHook('sync:shared')).toBe(false);
    expect(isHook('typecheck')).toBe(false);
  });
});

describe('the whole-push decision', () => {
  it('mobile/package-lock.json changed is native regardless of package.json', () => {
    // Even with an identical manifest, and even with a manifest change that
    // is provably inert on its own. The lockfile is the strongest evidence
    // available that the dependency graph actually moved.
    const inert = edited(
      '"sync:shared": "node ../scripts/sync-shared.mjs"',
      '"sync:shared": "cd .. && node scripts/sync-shared.mjs"'
    );
    for (const after of [BASE, inert]) {
      const result = decide({
        changedFiles: ['mobile/package.json', 'mobile/package-lock.json'],
        packageJsonBefore: BASE,
        packageJsonAfter: after,
      });
      expect(result.decision).toBe('native');
      expect(result.reasons.join(' ')).toContain('package-lock.json');
    }

    expect(
      decide({ changedFiles: ['mobile/package-lock.json'] }).decision
    ).toBe('native');
  });

  it('a push that touches nothing under mobile/ is a release of NOTHING', () => {
    // The workflow triggers on changes to ITSELF, so editing mobile.yml used
    // to publish an OTA carrying a bundle byte for byte identical to the one
    // already out there: a new update id, a download on every tester's phone,
    // and nothing to show for it. Third outcome, not a flavour of js-only.
    const result = decide({
      changedFiles: [
        '.github/workflows/mobile.yml',
        'scripts/decide-mobile-release.mjs',
        'src/lib/decideMobileRelease.test.ts',
        'CLAUDE.md',
      ],
    });
    expect(result.decision).toBe('none');
    expect(result.reasons.join(' ')).toContain('mobile/');
  });

  it('an empty diff is a release of nothing', () => {
    expect(decide({ changedFiles: [] }).decision).toBe('none');
  });

  it('one mobile file among many non-mobile ones is still a release', () => {
    expect(
      decide({ changedFiles: ['README.md', 'src/lib/units.ts', 'mobile/app/index.tsx'] }).decision
    ).toBe('js-only');
  });

  it('"nothing changed under mobile/" never overrides a native signal', () => {
    // Guards the ordering: the none-check runs first, so if it ever stopped
    // requiring the absence of mobile/ files it would silently swallow every
    // native input below it.
    for (const file of ['mobile/package-lock.json', 'mobile/app.config.js', 'mobile/eas.json']) {
      expect(decide({ changedFiles: ['CLAUDE.md', file] }).decision).toBe('native');
    }
  });

  it('keeps app.config.js, eas.json and assets file-level', () => {
    for (const file of [
      'mobile/app.config.js',
      'mobile/eas.json',
      'mobile/assets/icon.png',
      'mobile/assets/nested/splash-icon.png',
    ]) {
      expect(decide({ changedFiles: [file] }).decision).toBe('native');
    }
  });

  it('a push of ordinary mobile JS is js-only', () => {
    const result = decide({
      changedFiles: [
        'mobile/app/index.tsx',
        'mobile/components/ChatPanel.tsx',
        'mobile/lib/identity.ts',
        'src/lib/units.ts',
      ],
    });
    expect(result.decision).toBe('js-only');
  });

  it('a file merely NAMED like a native input elsewhere in the repo is not native', () => {
    // The web app's own package.json has nothing to do with the binary. On its
    // own it is not even a release; alongside a real mobile change it must
    // still not drag the decision to native.
    expect(decide({ changedFiles: ['package.json', 'package-lock.json'] }).decision).toBe('none');
    expect(
      decide({
        changedFiles: ['package.json', 'package-lock.json', 'mobile/app/index.tsx'],
      }).decision
    ).toBe('js-only');
  });

  it('no usable list of changed files is native', () => {
    expect(decide({ changedFiles: undefined }).decision).toBe('native');
    expect(decide({ changedFiles: null }).decision).toBe('native');
  });

  it('every decision carries a reason a human can read', () => {
    for (const input of [
      { changedFiles: ['mobile/app/index.tsx'] },
      { changedFiles: ['mobile/package-lock.json'] },
      { changedFiles: ['mobile/app.config.js'] },
      { changedFiles: ['mobile/package.json'], packageJsonBefore: BASE, packageJsonAfter: BASE },
    ]) {
      const { reasons } = decide(input);
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe('the real mobile/package.json', () => {
  // Read as TEXT, never imported: the root unit suite installs only the root
  // node_modules, so anything under mobile/ that gets transformed dies in CI.
  // src/lib/noMobileImportGuard.test.ts enforces that; readFileSync is legal.
  const real = readFileSync(path.join(ROOT, 'mobile', 'package.json'), 'utf8');

  it('parses, so the classifier can reason about it at all', () => {
    expect(() => JSON.parse(real)).not.toThrow();
  });

  it('is unchanged against itself', () => {
    expect(classify(real, real).native).toBe(false);
  });

  it('carries no npm or EAS lifecycle hook today', () => {
    // If this fails, someone added a postinstall. That is allowed — but the
    // classifier now treats every future change to it as native, which is the
    // point, and this assertion is how you find out why.
    const scripts = (JSON.parse(real) as { scripts?: Record<string, string> }).scripts ?? {};
    expect(Object.keys(scripts).filter(isHook)).toEqual([]);
  });
});

describe('.github/workflows/mobile.yml calls the classifier', () => {
  // Without this, someone reinstates the inline regex and every assertion
  // above keeps passing while the workflow ignores the script entirely.
  const workflow = readFileSync(
    path.join(ROOT, '.github', 'workflows', 'mobile.yml'),
    'utf8'
  );

  /**
   * Comment lines dropped and shell line-continuations folded back together,
   * so a `run:` command wrapped over two lines with a trailing `\\` is still
   * one string to match against. Without the fold, the forecast's invocation
   * reads as two half-commands and no assertion can see the whole call.
   */
  const commands = workflow
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));

  it('invokes scripts/decide-mobile-release.mjs', () => {
    // A RUN line, not a mention. The header comment names the script twice,
    // and an earlier version of this assertion was satisfied by those alone —
    // it stayed green through a mutation that reinstated the inline regex and
    // deleted the call. Comment lines are stripped before matching.
    const invocations = commands.filter((line) =>
      /node\s+scripts\/decide-mobile-release\.mjs/.test(line)
    );

    expect(
      invocations.length,
      'mobile.yml no longer RUNS scripts/decide-mobile-release.mjs — the decision ' +
        'has moved back into YAML, where it cannot be tested. That is how the ' +
        'sync:shared build shipped.'
    ).toBeGreaterThan(0);
  });

  it('gates the TestFlight build on the classifier', () => {
    // The build step had NO `if:` at all: every mobile merge spent ~30 minutes
    // of the free plan's low-priority queue and one of 15 monthly iOS credits,
    // including merges that only moved JS. If this assertion fails, the gate
    // was removed and the credits are going again.
    const lines = workflow.split('\n');
    const step = lines.findIndex((l) => l.includes('name: Build and submit to TestFlight'));
    expect(step, 'the build step is gone from mobile.yml').toBeGreaterThan(-1);

    const window = lines.slice(step, step + 12).join('\n');
    expect(
      /if:\s*steps\.native\.outputs\.decision == 'native'/.test(window),
      'the TestFlight build step is no longer gated on the decision the classifier made — ' +
        'every mobile merge will spend a build credit again, JS-only ones included.'
    ).toBe(true);
  });

  it('forecasts the decision on the PR before the merge', () => {
    expect(
      /^\s*pull_request:/m.test(workflow),
      'mobile.yml no longer runs on pull_request, so nothing tells you whether ' +
        'merging costs a build credit until after you have spent it.'
    ).toBe(true);

    const invocations = commands.filter(
      (line) => /decide-mobile-release\.mjs/.test(line) && /--json/.test(line)
    );

    expect(
      invocations.length,
      'the PR forecast no longer asks the classifier for its reasons (--json), so ' +
        'the comment cannot say WHY.'
    ).toBeGreaterThan(0);
  });

  it('does not classify mobile/package.json with an inline regex', () => {
    const offenders = workflow
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /NATIVE_RE|package(-lock)?\\\.json/.test(line));

    expect(
      offenders,
      'mobile.yml classifies package.json inline again:\n' +
        offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n') +
        '\n\n  Put the rule in scripts/decide-mobile-release.mjs, where the spec ' +
        'above can hold it.'
    ).toEqual([]);
  });
});
