import 'server-only';
import { getAiConsent } from '@/server/repos/users';
import { AiConsentRequiredError } from '@/server/auth/errors';
import { TYPESAFE_CONSENT_VERSION } from '@/lib/aiConsent';

/**
 * The server half of App Review 5.1.2(i): nothing a user wrote, photographed
 * or was located at reaches a third-party AI until that user has agreed to
 * the sheet that names it.
 *
 * ── Why a PROOF and not just a check ──
 *
 * A route-level `if (!consented) return 403` is one forgotten line away from
 * a route that sends without asking, and the paywall's history here says that
 * line does get forgotten (the onboarding route spent Anthropic money with no
 * cap of any kind for weeks). So the check MINTS a value, and every function
 * that sends user content to an AI provider takes one as a required argument
 * and verifies it before the request is built:
 *
 *   - Anthropic (`replanStream`, `classifyMessage`, `scanFirstMessage`,
 *     `resolveStartDate`/`parseDateWithLLM`, `estimateRange`) demand an
 *     `AiConsentProof` and call `assertAiConsent`.
 *   - TypeSafe (Jev, `src/server/jev/`) demands a `TypeSafeConsentProof`,
 *     which only `typeSafeConsentFrom` mints, and only from an
 *     `AiConsentProof` whose account agreed to sheet version ≥
 *     `TYPESAFE_CONSENT_VERSION` — the one that names TypeSafe. The fetch in
 *     `jev/client.ts` calls `assertTypeSafeConsent` first.
 *
 *   - At compile time, a call without a proof does not typecheck.
 *   - At run time, a proof that did not come out of this file (a cast, a
 *     literal, a test double that leaked) is not in its `MINTED` set and the
 *     send throws before any request is made. So does a proof minted for a
 *     different user.
 *
 * `aiConsentGuard.test.ts` covers the rest: every outbound AI call — SDK or
 * plain fetch — sits behind one of these asserts, every route that can reach
 * one calls `requireAiConsent`, and nothing outside this file fabricates
 * either type with a cast.
 */

declare const AI_CONSENT_PROOF: unique symbol;
declare const TYPESAFE_CONSENT_PROOF: unique symbol;

/** Only `requireAiConsent` makes one. Carries the user and the sheet version they agreed to. */
export interface AiConsentProof {
  readonly [AI_CONSENT_PROOF]: true;
  readonly userId: string;
  /** The newest consent sheet this user agreed to (1 = Anthropic only). */
  readonly version: number;
}

/** Only `typeSafeConsentFrom` makes one: this user agreed to the sheet naming TypeSafe. */
export interface TypeSafeConsentProof {
  readonly [TYPESAFE_CONSENT_PROOF]: true;
  readonly userId: string;
}

/** Every proof this process minted. Weak, so a finished request's proof is collected. */
const MINTED = new WeakSet<object>();
const MINTED_TYPESAFE = new WeakSet<object>();

/**
 * Throws 403 `ai_consent_required` unless `userId` has agreed; otherwise
 * returns the proof the Anthropic-calling functions demand.
 *
 * Call it AFTER authentication, entitlement and ownership (so a stranger
 * still gets the ownership 403 and a lapsed trial the 402 they would get
 * anyway) and BEFORE anything that reads the user's content into a prompt.
 */
export async function requireAiConsent(userId: string): Promise<AiConsentProof> {
  const { at: consentedAt, version } = await getAiConsent(userId);
  if (!consentedAt) throw new AiConsentRequiredError();
  const proof = Object.freeze({ userId, version: version ?? 1 }) as unknown as AiConsentProof;
  MINTED.add(proof);
  return proof;
}

/**
 * The sink side. Throws — a programming error, not a user-facing one — when
 * the proof was not minted by `requireAiConsent` or belongs to someone else.
 * Runs before the SDK client is even constructed.
 */
export function assertAiConsent(proof: AiConsentProof, userId?: string | null): void {
  if (!proof || typeof proof !== 'object' || !MINTED.has(proof)) {
    throw new Error('AI consent proof missing or forged: refusing to send user content to Anthropic');
  }
  if (userId && proof.userId !== userId) {
    throw new Error('AI consent proof belongs to another user: refusing to send user content to Anthropic');
  }
}

/**
 * The TypeSafe proof for this request, or NULL when the user has not agreed
 * to the sheet that names TypeSafe — in which case the caller must not call
 * Jev at all (the gate then asks Haiku only, exactly as with Jev off).
 *
 * Only a genuine `AiConsentProof` counts, so it can only grant anything after
 * `requireAiConsent` ran for this request; the version it reads was read
 * from the database by that call.
 */
export function typeSafeConsentFrom(proof: AiConsentProof): TypeSafeConsentProof | null {
  // Fails CLOSED and quietly: a proof this file did not mint grants nothing,
  // and the caller carries on with Haiku only. (Anthropic's own sinks still
  // throw on it — this path must never be the reason a message fails.)
  if (!proof || typeof proof !== 'object' || !MINTED.has(proof)) return null;
  if (!(proof.version >= TYPESAFE_CONSENT_VERSION)) return null;
  const ts = Object.freeze({ userId: proof.userId }) as unknown as TypeSafeConsentProof;
  MINTED_TYPESAFE.add(ts);
  return ts;
}

/**
 * The sink side for TypeSafe. Throws unless the proof came out of
 * `typeSafeConsentFrom` (and so out of a version ≥ 2 agreement) and belongs
 * to `userId`. Called by `jev/client.ts` before the request body is built.
 */
export function assertTypeSafeConsent(proof: TypeSafeConsentProof, userId?: string | null): void {
  if (!proof || typeof proof !== 'object' || !MINTED_TYPESAFE.has(proof)) {
    throw new Error('TypeSafe consent proof missing or forged: refusing to send user content to TypeSafe');
  }
  if (userId && proof.userId !== userId) {
    throw new Error('TypeSafe consent proof belongs to another user: refusing to send user content to TypeSafe');
  }
}
