/**
 * Decides whether a merge to `main` needs a NATIVE binary or can ride an
 * over-the-air JS update.
 *
 * WHY THIS IS A FILE AND NOT A REGEX IN A `run:` BLOCK.
 *
 * It used to be one line inside .github/workflows/mobile.yml:
 *
 *   NATIVE_RE='^mobile/(app\.config\.js|package\.json|package-lock\.json|eas\.json|assets/)'
 *
 * A merge whose only change to mobile/package.json was
 *
 *   -    "sync:shared": "node ../scripts/sync-shared.mjs",
 *   +    "sync:shared": "cd .. && node scripts/sync-shared.mjs",
 *
 * was classified native. package-lock.json was untouched, which is proof no
 * dependency moved. It spent ~30 minutes of EAS queue and a build credit, and
 * because that path deliberately SKIPS the OTA, fifteen genuinely-JS files
 * reached nobody until the binary landed. Logic that cannot be tested is how
 * that shipped, so the logic now lives here and is exercised by
 * src/lib/decideMobileRelease.test.ts.
 *
 * THE ASYMMETRY, which governs every decision below.
 *
 * A wrongly-chosen NATIVE build costs half an hour and a credit, and still
 * delivers the JS — it is slow, never silent. A wrongly-chosen OTA ships a
 * bundle to a binary that may not carry the native module it expects, which
 * crashes on launch, on a tester's phone, with nothing anywhere going red.
 * `runtimeVersion: { policy: 'appVersion' }` only guards that when `version`
 * in app.config.js is also bumped, which is exactly what a careless merge
 * forgets.
 *
 * So EVERY failure path returns native: an unreadable file, unparseable JSON
 * on either side, a `git show` that errors, a key nobody has classified.
 * The allowlist below is of keys provably unable to reach the binary; a
 * package.json key that is not on it is native by default, including one
 * invented after this file was written.
 *
 * USAGE
 *
 *   node scripts/decide-mobile-release.mjs --base <ref> --head <ref>
 *
 * stdout is exactly one line, `native` or `js-only`, for the workflow to
 * capture. The reasoning goes to stderr so a human reading the run can see
 * WHY. Any thrown error is caught and printed as `native`.
 */
import { execFileSync } from 'node:child_process';

/** The manifest whose CONTENT decides; everything else here is file-level. */
export const MANIFEST = 'mobile/package.json';

/**
 * The lockfile is an unconditional native signal on its own. It is the
 * strongest evidence available that the dependency graph actually moved, and
 * it is not worth being clever about: a lockfile diff can re-resolve a
 * transitive native module without mobile/package.json changing by a byte.
 */
export const LOCKFILE = 'mobile/package-lock.json';

/**
 * The native inputs that stay FILE-LEVEL, deliberately unchanged.
 *
 *   app.config.js   plugins, Info.plist, entitlements, bundle id, and
 *                   `version` — which IS the runtimeVersion. Reasoning about
 *                   its contents is a separate and much riskier change.
 *   eas.json        build profile, channel, env baked into the bundle.
 *   assets/**       icon and splash art are compiled in at prebuild.
 *
 * mobile/ios and mobile/android are gitignored (CNG — EAS regenerates them at
 * build time), so they can never appear in a diff.
 */
export const FILE_LEVEL_NATIVE_RE = /^mobile\/(app\.config\.js|eas\.json|assets\/)/;

/**
 * Top-level package.json keys that provably cannot reach the binary.
 *
 *   name         npm package identity. The app's display name is
 *                app.config.js's `expo.name`; the bundle id is
 *                `expo.ios.bundleIdentifier`. Neither reads this.
 *   version      NOT the runtimeVersion. app.config.js hardcodes
 *                `version: '1.0.0'` rather than requiring package.json, and
 *                eas.json sets `appVersionSource: "remote"`, so buildNumber
 *                comes from EAS. If app.config.js is ever changed to read
 *                this field, remove it from this set in the same commit.
 *   private      npm publish guard. Nothing in a build reads it.
 *   description  metadata.
 *
 * `scripts` is handled separately below — inert for the names a human has to
 * type, native for the ones npm and EAS run on their own.
 *
 * NOT here, and each for a reason worth stating: dependencies,
 * devDependencies, peerDependencies, optionalDependencies, overrides,
 * resolutions (any of them can add, remove or re-version a native module),
 * `expo` (config-plugin and install-version config lives there), and `main`
 * (the entry Metro bundles). They are covered by the default rather than by
 * a denylist, so a key invented tomorrow lands on the safe side too.
 */
export const INERT_TOP_LEVEL_KEYS = new Set(['name', 'version', 'private', 'description']);

/**
 * Script names npm or EAS run WITHOUT anyone asking, so a change to one can
 * modify native source before the binary is compiled. `patch-package` in a
 * postinstall is the canonical example, and `eas-build-pre-install` exists
 * precisely to run code inside the build.
 *
 * This is deliberately stricter than "all of `scripts` is inert". The names a
 * human has to type — start, ios, doctor, typecheck, sync:shared — cannot run
 * themselves, and those are the ones the regression case is about.
 */
export const AUTOMATIC_SCRIPT_HOOKS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'dependencies',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublish',
]);

/** EAS Build's own hooks are all `eas-build-*`; match by prefix. */
export const EAS_SCRIPT_HOOK_PREFIX = 'eas-build-';

export function isAutomaticScriptHook(name) {
  return name.startsWith(EAS_SCRIPT_HOOK_PREFIX) || AUTOMATIC_SCRIPT_HOOKS.has(name);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural equality, ignoring object key ORDER (reordering `dependencies`
 * moves nothing) but respecting array order (a plugin list is ordered).
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(a, key)) return false;
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Which top-level keys differ between two parsed manifests, including keys
 * present on one side only.
 */
function changedTopLevelKeys(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => {
    const inBefore = Object.prototype.hasOwnProperty.call(before, key);
    const inAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (inBefore !== inAfter) return true;
    return !deepEqual(before[key], after[key]);
  });
}

/** Which script NAMES differ, including added and removed ones. */
function changedScriptNames(before, after) {
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const names = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  return names.filter((name) => b[name] !== a[name]);
}

/**
 * Classify a change to mobile/package.json by what MOVED inside it.
 *
 * Returns `{ native, reasons }`. Both sides are raw text so that unparseable
 * input is a case this function decides rather than one it throws on.
 */
export function classifyPackageJsonChange(beforeText, afterText) {
  for (const [side, text] of [['base', beforeText], ['head', afterText]]) {
    if (typeof text !== 'string') {
      return { native: true, reasons: [`${MANIFEST} could not be read on the ${side} side`] };
    }
  }

  const parsed = {};
  for (const [side, text] of [['base', beforeText], ['head', afterText]]) {
    try {
      parsed[side] = JSON.parse(text);
    } catch (error) {
      return {
        native: true,
        reasons: [`${MANIFEST} is not parseable JSON on the ${side} side (${error.message})`],
      };
    }
    if (!isPlainObject(parsed[side])) {
      return { native: true, reasons: [`${MANIFEST} is not a JSON object on the ${side} side`] };
    }
  }

  const changed = changedTopLevelKeys(parsed.base, parsed.head);
  if (changed.length === 0) {
    return { native: false, reasons: [`${MANIFEST} is unchanged once parsed`] };
  }

  const reasons = [];
  const inert = [];
  for (const key of changed) {
    if (key === 'scripts') {
      const hooks = changedScriptNames(parsed.base.scripts, parsed.head.scripts).filter(
        isAutomaticScriptHook
      );
      if (hooks.length > 0) {
        reasons.push(
          `${MANIFEST} changed the ${hooks.map((h) => `"${h}"`).join(', ')} ` +
            `script${hooks.length > 1 ? 's' : ''} — npm or EAS runs ` +
            `${hooks.length > 1 ? 'those' : 'that'} during the build, so it can touch native source`
        );
      } else {
        inert.push('scripts');
      }
      continue;
    }
    if (INERT_TOP_LEVEL_KEYS.has(key)) {
      inert.push(key);
      continue;
    }
    reasons.push(
      `${MANIFEST} key "${key}" changed — not on the provably-inert allowlist, so it is treated as native`
    );
  }

  if (reasons.length > 0) return { native: true, reasons };
  return {
    native: false,
    reasons: [
      `${MANIFEST} changed only in provably-inert keys (${inert.join(', ')}) — nothing that can reach the binary`,
    ],
  };
}

/**
 * The whole decision.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles repo-relative paths in this push
 * @param {string|null|undefined} input.packageJsonBefore raw text, base side
 * @param {string|null|undefined} input.packageJsonAfter  raw text, head side
 * @returns {{ decision: 'native'|'js-only', reasons: string[] }}
 */
export function decideMobileRelease({ changedFiles, packageJsonBefore, packageJsonAfter }) {
  if (!Array.isArray(changedFiles)) {
    return { decision: 'native', reasons: ['no usable list of changed files'] };
  }
  const files = changedFiles.map((f) => String(f).trim()).filter(Boolean);

  // Kept apart on purpose. `native` is the only list that can flip the
  // decision; `notes` is explanation for the run log. Folding the two
  // together made a js-only manifest verdict read as a reason to build,
  // which the spec caught immediately — hence the separation.
  const native = [];
  const notes = [];

  if (files.includes(LOCKFILE)) {
    native.push(`${LOCKFILE} changed — the dependency graph moved`);
  }

  for (const file of files) {
    if (FILE_LEVEL_NATIVE_RE.test(file)) {
      native.push(`${file} changed — native input, matched file-level`);
    }
  }

  if (files.includes(MANIFEST)) {
    const manifest = classifyPackageJsonChange(packageJsonBefore, packageJsonAfter);
    if (manifest.native) native.push(...manifest.reasons);
    else notes.push(...manifest.reasons);
  }

  if (native.length > 0) return { decision: 'native', reasons: native };
  return {
    decision: 'js-only',
    reasons: [...notes, 'no native input moved — safe to publish over the air'],
  };
}

/* ------------------------------------------------------------------ CLI */

function gitShow(ref, filePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // git's own "exists on disk, but not in <ref>" is expected here — the
      // file being new IS the answer, and the reason we print says so far
      // more clearly than a `fatal:` in the middle of the log.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Added, deleted, or an unreadable ref. All three are native: the caller
    // only asks when the file is in the diff, so "cannot read it" means we
    // cannot prove the change is inert.
    return null;
  }
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  const base = args.get('--base');
  const head = args.get('--head');

  if (!base || !head) {
    return { decision: 'native', reasons: ['--base and --head are both required'] };
  }

  let changedFiles;
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', base, head], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).split('\n');
  } catch (error) {
    return { decision: 'native', reasons: [`git diff ${base}..${head} failed: ${error.message}`] };
  }

  process.stderr.write('Changed files:\n');
  for (const file of changedFiles.filter(Boolean)) process.stderr.write(`  ${file}\n`);

  return decideMobileRelease({
    changedFiles,
    packageJsonBefore: gitShow(base, MANIFEST),
    packageJsonAfter: gitShow(head, MANIFEST),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let result;
  try {
    result = main(process.argv.slice(2));
  } catch (error) {
    result = { decision: 'native', reasons: [`classifier threw: ${error.message}`] };
  }
  for (const reason of result.reasons) process.stderr.write(`${result.decision}: ${reason}\n`);
  process.stdout.write(`${result.decision}\n`);
}
