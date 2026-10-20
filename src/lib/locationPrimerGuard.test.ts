import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The location pre-prompt has exactly ONE action, and it leads to iOS's dialog.
 *
 * App Review 5.1.1(iv): a custom screen before a permission request may explain
 * the request, but it may not let the user skip the system dialog. Build 12's
 * LocationPrimer had "Turn on location" and "Not now", and "Not now" did exactly
 * that (confirmed on a device: the OS dialog appeared only after "Turn on
 * location"). Sam's rule is the other half: the question is asked at launch, on
 * the splash, and the app does not go on until iOS has an answer.
 *
 * The decision itself (when to show the primer, what Continue does, waiting for
 * a real answer) is shared/lib/launchLocation.ts, driven branch by branch in
 * launchLocation.test.ts. THIS file pins the native wiring, which no test
 * runner here can render: read as TEXT (noMobileImportGuard).
 */
const MOBILE = path.resolve(__dirname, '../../mobile');
const read = (rel: string) => fs.readFileSync(path.join(MOBILE, rel), 'utf8');

/** Code only — comments here discuss "Not now" at length, which is not a control. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PRIMER = code(read('components/LocationPrimer.tsx'));
const GATE = code(read('app/index.tsx'));
const PROVIDER = code(read('lib/location.tsx'));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'ios', 'android', '.expo', 'maestro'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('LocationPrimer: one action, no skip', () => {
  it('has exactly one pressable control', () => {
    const controls = PRIMER.match(/<(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Button)\b/g) ?? [];
    expect(controls).toHaveLength(1);
    expect(PRIMER.match(/\bonPress=/g) ?? []).toHaveLength(1);
  });

  it('that control is Continue, wired to onContinue', () => {
    expect(PRIMER).toMatch(/onPress=\{onContinue\}/);
    expect(PRIMER).toMatch(/>\s*Continue\s*</);
  });

  it('takes no decline/dismiss callback at all', () => {
    // Only `visible` and `onContinue` cross the boundary — a second callback is
    // a second way out.
    const props = PRIMER.match(/export default function LocationPrimer\(\{([\s\S]*?)\}:/);
    expect(props?.[1].replace(/\s/g, '')).toBe('visible,onContinue,');
  });

  it('the hardware back / dismiss path is Continue too, not a skip', () => {
    expect(PRIMER).toMatch(/onRequestClose=\{onContinue\}/);
  });

  it.each(['Not now', 'Skip', 'Later', 'No thanks', 'Cancel', "Don't", 'Don&apos;t', 'Turn on location'])(
    'offers no "%s"',
    (label) => {
      expect(PRIMER).not.toContain(label);
    },
  );
});

describe('launch asks, and waits for the answer', () => {
  it('the primer is shown only by the launch gate', () => {
    const renderers = walk(MOBILE)
      .filter((f) => /<LocationPrimer\b/.test(code(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(MOBILE, f));
    expect(renderers).toEqual([path.join('app', 'index.tsx')]);
  });

  it('the gate runs the shared launch question, and only asks — it never watches', () => {
    expect(GATE).toMatch(/resolveLaunchLocation\(/);
    expect(GATE).not.toMatch(/watchPositionAsync|getCurrentPositionAsync|getLastKnownPositionAsync/);
    expect(GATE).toMatch(/requestForegroundPermissionsAsync\(/);
    expect(GATE).toMatch(/<LocationPrimer visible=\{primerVisible\} onContinue=\{/);
  });

  it('routes only after the location question has settled', () => {
    // `go` is the only way off the splash; it must come after awaiting both
    // the location answer and the route decision.
    const effect = GATE.slice(GATE.indexOf('useEffect('), GATE.indexOf('return (\n'));
    const awaitAt = effect.search(/await Promise\.all\(\[located, routeDestination\(\)\]\)/);
    const goAt = effect.indexOf('go(destination)');
    expect(awaitAt).toBeGreaterThan(-1);
    expect(goAt).toBeGreaterThan(awaitAt);
    expect(effect.match(/\bgo\(/g) ?? []).toHaveLength(1);
  });

  it("the trip screen's provider never prompts on mount", () => {
    const mount = PROVIDER.slice(
      PROVIDER.indexOf('if (!promptAllowed)'),
      PROVIDER.indexOf('}, [promptAllowed]);'),
    );
    expect(mount.length).toBeGreaterThan(100);
    expect(mount).not.toMatch(/requestForegroundPermissionsAsync|\brequest\(|askOs\(/);
  });

  it('the system dialog is raised from exactly three places, each one a user action or launch', () => {
    const callers = walk(MOBILE)
      .filter((f) => /requestForegroundPermissionsAsync\(/.test(code(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(MOBILE, f))
      .sort();
    expect(callers).toEqual(
      [
        path.join('app', 'index.tsx'), // launch, after Continue
        path.join('components', 'LocationSection.tsx'), // Settings switch, off -> on
        path.join('lib', 'location.tsx'), // "LOCATION OFF — TAP TO TURN ON"
      ].sort(),
    );
  });
});
