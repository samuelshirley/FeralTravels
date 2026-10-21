import 'server-only';
import { getAiConsentAt } from '@/server/repos/users';
import { AiConsentRequiredError } from '@/server/auth/errors';

/**
 * The server half of App Review 5.1.2(i): nothing a user wrote, photographed
 * or was located at reaches Anthropic until that user has agreed.
 *
 * ── Why a PROOF and not just a check ──
 *
 * A route-level `if (!consented) return 403` is one forgotten line away from
 * a route that sends without asking, and the paywall's history here says that
 * line does get forgotten (the onboarding route spent Anthropic money with no
 * cap of any kind for weeks). So the check MINTS a value, and every function
 * that sends user content to Anthropic — `replanStream`, `classifyMessage`,
 * `scanFirstMessage`, `resolveStartDate`/`parseDateWithLLM`, `estimateRange` —
 * takes one as a required argument and verifies it with `assertAiConsent`.
 *
 *   - At compile time, a call without a proof does not typecheck.
 *   - At run time, a proof that did not come out of `requireAiConsent` (a
 *     cast, a literal, a test double that leaked) is not in `MINTED` and the
 *     send throws before the SDK is touched. So does a proof minted for a
 *     different user.
 *
 * `aiConsentGuard.test.ts` covers the rest: every route that can reach one of
 * those functions calls `requireAiConsent`, and nothing outside this file
 * fabricates the type with `as AiConsentProof`.
 */

declare const AI_CONSENT_PROOF: unique symbol;

/** Only `requireAiConsent` makes one. Carries the user it was minted for. */
export interface AiConsentProof {
  readonly [AI_CONSENT_PROOF]: true;
  readonly userId: string;
}

/** Every proof this process minted. Weak, so a finished request's proof is collected. */
const MINTED = new WeakSet<object>();

/**
 * Throws 403 `ai_consent_required` unless `userId` has agreed; otherwise
 * returns the proof the Anthropic-calling functions demand.
 *
 * Call it AFTER authentication, entitlement and ownership (so a stranger
 * still gets the ownership 403 and a lapsed trial the 402 they would get
 * anyway) and BEFORE anything that reads the user's content into a prompt.
 */
export async function requireAiConsent(userId: string): Promise<AiConsentProof> {
  const consentedAt = await getAiConsentAt(userId);
  if (!consentedAt) throw new AiConsentRequiredError();
  const proof = Object.freeze({ userId }) as unknown as AiConsentProof;
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
