/**
 * The launch-time location question — the ONE place the app asks iOS.
 *
 * Product rule (Sam): location is asked at launch, on the purple Finn splash,
 * and the app does not go on until the user has answered the SYSTEM dialog —
 * Allow or Don't Allow. Our own sheet in front of it (LocationPrimer) has
 * exactly one control, Continue, and it always leads to that dialog. App
 * Review 5.1.1(iv): a pre-permission screen may explain, but it may not offer
 * a way past the system prompt. Build 12's primer did ("Not now"), and was
 * shown inside the trip workspace rather than at launch.
 *
 * Pure orchestration over injected platform calls, so the root vitest project
 * (the only test runner) can drive every branch: mobile/app/index.tsx supplies
 * expo-location, AppState and the primer; launchLocation.test.ts supplies fakes.
 */

export type LaunchPermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface LaunchPermission {
  status: LaunchPermissionStatus;
  canAskAgain: boolean;
}

export interface LaunchLocationDeps {
  /** Read the permission WITHOUT prompting (getForegroundPermissionsAsync). */
  read(): Promise<LaunchPermission>;
  /** Location Services on device-wide (hasServicesEnabledAsync). */
  servicesEnabled(): Promise<boolean>;
  /** Raise the system dialog (requestForegroundPermissionsAsync). */
  request(): Promise<LaunchPermission>;
  /** Show the primer; resolves when the user taps Continue — its only control. */
  showPrimer(): Promise<void>;
  /** Hide the primer before the system dialog is raised. */
  hidePrimer(): void;
  /** Subscribe to the app returning to the foreground; returns unsubscribe. */
  onForeground(cb: () => void): () => void;
}

/**
 * What happened, for the caller's logs and tests. Every outcome lets launch
 * continue; only 'answered' involved the user.
 *
 *   decided     — iOS already has an answer (granted, or denied for good).
 *   unaskable   — the question cannot be answered here: Location Services are
 *                 off device-wide, or the permission could not be read. The
 *                 trip screen offers the way on (Settings) instead of a launch
 *                 that never finishes.
 *   answered    — primer, Continue, system dialog, Allow or Don't Allow.
 */
export type LaunchLocationOutcome = 'decided' | 'unaskable' | 'answered';

/** Does launch have to stop and ask? Exported for the tests' truth table. */
export function needsLaunchQuestion(
  perm: LaunchPermission | null,
  servicesEnabled: boolean,
): boolean {
  if (!perm) return false;
  if (perm.status !== 'undetermined') return false;
  if (!perm.canAskAgain) return false;
  return servicesEnabled;
}

export async function resolveLaunchLocation(deps: LaunchLocationDeps): Promise<LaunchLocationOutcome> {
  const perm = await deps.read().catch(() => null);
  if (!perm) return 'unaskable';
  if (perm.status !== 'undetermined' || !perm.canAskAgain) return 'decided';
  const services = await deps.servicesEnabled().catch(() => false);
  if (!needsLaunchQuestion(perm, services)) return 'unaskable';

  // The primer is the only thing between launch and the system dialog, and
  // Continue is the only way past it.
  await deps.showPrimer();
  deps.hidePrimer();
  await askUntilAnswered(deps);
  return 'answered';
}

/**
 * Raise the system dialog and wait for a real answer.
 *
 * The request promise alone is not enough: if the app is backgrounded while
 * the dialog is up, iOS can take it down with the status still undetermined,
 * and the promise never settles — a launch stuck on the splash forever. So
 * every return to the foreground re-reads the permission: answered means go
 * on; still undetermined means ask again (iOS shows the dialog again while the
 * status is undetermined). A native error also lets launch go on — the trip
 * screen can still offer the way to turn location on; a dead splash cannot.
 */
function askUntilAnswered(deps: LaunchLocationDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      resolve();
    };
    const ask = () => {
      deps
        .request()
        .then((r) => {
          if (r.status !== 'undetermined') finish();
        })
        .catch(finish);
    };
    unsubscribe = deps.onForeground(() => {
      if (done) return;
      deps
        .read()
        .then((r) => {
          if (r.status !== 'undetermined') finish();
          else ask();
        })
        .catch(finish);
    });
    ask();
  });
}
