import { blockNoticeFor } from '@/lib/paywallCopy';
import EntitlementOverlay from '@/components/EntitlementOverlay';
import type { BlockReason } from '@/types/entitlement';

/**
 * The web block.
 *
 * Still a plain server component with no fetch: the page already resolved the
 * verdict, so the correct message is in the first HTML byte. A client component
 * polling `/api/me/entitlement` would flash the full UI — including a "+ New
 * trip" button — before deciding to take it away, which is a worse experience
 * than the block itself and briefly lies about what the account can do.
 *
 * What changed (2026-08-27): it is no longer a card in the page flow with a
 * live trip list underneath. It renders an OVERLAY over the whole page. The
 * list is still drawn and still legible through it — covered, not deleted —
 * but nothing behind it can be operated. This is the deliberate reversal of
 * "Allowed: viewing existing trips" in docs/design/subscriptions.md; the doc is
 * unedited and the owner decides which of the two is now right.
 *
 * Whether the trip list below is rendered at all is still the caller's
 * decision, because `refunded`/`revoked` close the trips themselves.
 */
export default function EntitlementNotice({
  blockReason,
  pennyHref = null,
}: {
  blockReason: BlockReason;
  /** Link to the chat the user should be having instead. Null when they have no trip. */
  pennyHref?: string | null;
}) {
  return (
    <EntitlementOverlay
      blockReason={blockReason}
      notice={blockNoticeFor(blockReason)}
      pennyHref={pennyHref}
    />
  );
}
