/**
 * One rule, three doors.
 *
 * Google and Apple are both registered with `allowDangerousEmailAccountLinking`,
 * and `createSessionForEmail` links by verified email on the native path too —
 * so on all three sign-in routes an address the holder has not proven is an
 * account takeover waiting to happen. The check therefore has to be identical
 * everywhere, and until now "identical" was a comment on two separate copies:
 * one in `oauthIdentity.ts` (native Google + native Apple), one inline in the
 * Auth.js `signIn` callback (web). Two copies of a security rule drift; this
 * module is the rule itself, so they cannot.
 *
 * The web copy in particular had no test at all, and it fails CLOSED into a
 * dead end — a refusal surfaces as Auth.js's generic `AccessDenied` with no
 * way forward for the user. If Apple's profile mapping ever stopped surfacing
 * `email_verified` on some flow, every web Apple sign-in would be refused and
 * the only symptom would be a banner.
 */

/**
 * Apple's "Hide My Email" alias domain. Apple mints these itself and routes
 * them, so the address is Apple-proven by construction even when the token
 * carries no `email_verified` claim — the ONLY case where an absent claim is
 * acceptable. Note the leading `@`: without it, `evil@privaterelay.appleid.com.
 * attacker.test` would slip through a bare suffix match.
 */
export const APPLE_RELAY_DOMAIN = '@privaterelay.appleid.com';

/**
 * Has the provider asserted that this person owns this address?
 *
 * Providers are inconsistent about the claim's type — Google sends a boolean,
 * Apple the string `"true"` — so both are accepted. An ABSENT claim is a
 * refusal, not a shrug: jose and Auth.js both hand back whatever the token
 * contained, and "the field was missing" is exactly what a forged or
 * minimally-populated token looks like.
 */
export function isProviderEmailProven(
  provider: 'google' | 'apple',
  claim: unknown,
  email: string
): boolean {
  if (claim === true || claim === 'true') return true;
  if (claim === false || claim === 'false') return false;

  return provider === 'apple' && email.trim().toLowerCase().endsWith(APPLE_RELAY_DOMAIN);
}
