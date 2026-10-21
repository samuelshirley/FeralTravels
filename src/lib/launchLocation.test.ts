import { describe, expect, it, vi } from 'vitest';
import {
  needsLaunchQuestion,
  resolveLaunchLocation,
  type LaunchLocationDeps,
  type LaunchPermission,
} from './launchLocation';

const UNDETERMINED: LaunchPermission = { status: 'undetermined', canAskAgain: true };
const GRANTED: LaunchPermission = { status: 'granted', canAskAgain: true };
const DENIED: LaunchPermission = { status: 'denied', canAskAgain: false };

/** Fakes with a log, so the ORDER of primer and system dialog is assertable. */
function fake(over: Partial<LaunchLocationDeps> & { initial?: LaunchPermission } = {}) {
  const log: string[] = [];
  let foreground: (() => void) | null = null;
  let continueTap: (() => void) | null = null;
  let answer: ((p: LaunchPermission) => void) | null = null;
  const deps: LaunchLocationDeps = {
    read: vi.fn(async () => {
      log.push('read');
      return over.initial ?? UNDETERMINED;
    }),
    servicesEnabled: vi.fn(async () => true),
    request: vi.fn(
      () =>
        new Promise<LaunchPermission>((resolve) => {
          log.push('system-dialog');
          answer = resolve;
        }),
    ),
    showPrimer: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          log.push('primer');
          continueTap = resolve;
        }),
    ),
    hidePrimer: vi.fn(() => {
      log.push('primer-hidden');
    }),
    onForeground: vi.fn((cb: () => void) => {
      foreground = cb;
      return () => {
        foreground = null;
      };
    }),
    ...over,
  };
  return {
    deps,
    log,
    tapContinue: () => continueTap?.(),
    answer: (p: LaunchPermission) => answer?.(p),
    foreground: () => foreground?.(),
    hasForegroundListener: () => foreground !== null,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('needsLaunchQuestion', () => {
  it.each([
    [UNDETERMINED, true, true],
    [UNDETERMINED, false, false], // Location Services off: the dialog cannot be answered
    [GRANTED, true, false],
    [DENIED, true, false],
    [{ status: 'undetermined', canAskAgain: false } as LaunchPermission, true, false],
    [null, true, false],
  ])('%j with services=%s -> %s', (perm, services, expected) => {
    expect(needsLaunchQuestion(perm, services)).toBe(expected);
  });
});

describe('resolveLaunchLocation', () => {
  it('a new install: primer, then Continue, then the SYSTEM dialog, then launch goes on', async () => {
    const f = fake();
    let settled = false;
    const run = resolveLaunchLocation(f.deps).then((o) => {
      settled = true;
      return o;
    });
    await tick();
    expect(f.log).toEqual(['read', 'primer']);
    // Nothing reaches iOS until Continue — and launch does not go on either.
    expect(f.deps.request).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    f.tapContinue();
    await tick();
    expect(f.log).toEqual(['read', 'primer', 'primer-hidden', 'system-dialog']);
    // The primer is gone but the SYSTEM dialog is unanswered: still waiting.
    expect(settled).toBe(false);

    f.answer(GRANTED);
    expect(await run).toBe('answered');
    expect(f.hasForegroundListener()).toBe(false);
  });

  it("Don't Allow is an answer too — launch goes on, location off", async () => {
    const f = fake();
    const run = resolveLaunchLocation(f.deps);
    await tick();
    f.tapContinue();
    await tick();
    f.answer(DENIED);
    expect(await run).toBe('answered');
  });

  it('the primer offers no way past the system dialog: Continue is the only exit', async () => {
    // There is no "decline" in the deps at all — showPrimer resolves only on
    // Continue, and the next thing after it is always request().
    const f = fake();
    void resolveLaunchLocation(f.deps);
    await tick();
    f.tapContinue();
    await tick();
    expect(f.deps.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['granted', GRANTED],
    ['denied for good', DENIED],
  ])('already %s: no primer, no dialog', async (_label, perm) => {
    const f = fake({ initial: perm });
    expect(await resolveLaunchLocation(f.deps)).toBe('decided');
    expect(f.deps.showPrimer).not.toHaveBeenCalled();
    expect(f.deps.request).not.toHaveBeenCalled();
  });

  it('Location Services off device-wide: no primer (it would promise a dialog that cannot be answered)', async () => {
    const f = fake({ servicesEnabled: vi.fn(async () => false) });
    expect(await resolveLaunchLocation(f.deps)).toBe('unaskable');
    expect(f.deps.showPrimer).not.toHaveBeenCalled();
  });

  it('an unreadable permission does not strand launch on the splash', async () => {
    const f = fake({ read: vi.fn(async () => Promise.reject(new Error('native'))) });
    expect(await resolveLaunchLocation(f.deps)).toBe('unaskable');
  });

  it('a request that throws lets launch go on', async () => {
    const f = fake({ request: vi.fn(async () => Promise.reject(new Error('plist'))) });
    const run = resolveLaunchLocation(f.deps);
    await tick();
    f.tapContinue();
    expect(await run).toBe('answered');
  });

  it('dialog torn down by backgrounding: back in front, still undetermined -> asks again', async () => {
    const f = fake();
    let settled = false;
    const run = resolveLaunchLocation(f.deps).then(() => {
      settled = true;
    });
    await tick();
    f.tapContinue();
    await tick();
    // The first request never settles (iOS took the dialog down).
    f.foreground(); // read -> still undetermined
    await tick();
    expect(f.deps.request).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    f.answer(DENIED);
    await run;
    expect(settled).toBe(true);
  });

  it('answered while backgrounded (or the request promise lost): the foreground read finishes it', async () => {
    let perm = UNDETERMINED;
    const f = fake({ read: vi.fn(async () => perm) });
    const run = resolveLaunchLocation(f.deps);
    await tick();
    f.tapContinue();
    await tick();
    perm = GRANTED;
    f.foreground();
    expect(await run).toBe('answered');
    expect(f.deps.request).toHaveBeenCalledTimes(1);
  });
});
