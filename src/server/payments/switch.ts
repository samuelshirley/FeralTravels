import 'server-only';

/**
 * The paywall's master switch. OFF unless `PAYWALL_ENABLED=1`.
 *
 * Default-off, and it is the default that matters. Merging the paywall PR
 * deployed it, and deploying it blocked 28 of 29 production accounts in the
 * same instant — everyone who had signed up more than seven days earlier,
 * which by then was everyone. None of them had been told a trial existed, and
 * with no App Store app there was no way for any of them to pay their way out.
 * The code was doing exactly what it was written to do.
 *
 * So enforcement is now a thing you turn ON deliberately, once there is
 * something to buy, rather than a thing that happens the moment a migration
 * lands. Turning it on is an env change, not a deploy.
 *
 * Why an env var rather than comping the existing users: `syncCompedFlagOnSignIn`
 * clears `users.comped` for anyone off the hardcoded allowlist on every sign-in,
 * so a bulk `UPDATE users SET comped = true` undoes itself one sign-in at a
 * time. That is the correct behaviour for a comp allowlist and the wrong tool
 * for this job.
 *
 * This does NOT stop the trial clock, the usage metering or the account-state
 * machine. They keep running and stay truthful — the admin panel still shows
 * that an account IS `trial_expired`. The switch decides only whether that
 * fact is allowed to block anybody, which is what makes it safe to flip on and
 * back off without any state to repair.
 */
type EnvLike = Record<string, string | undefined>;

export function paywallEnabled(env: EnvLike = process.env): boolean {
  return env.PAYWALL_ENABLED === '1';
}
