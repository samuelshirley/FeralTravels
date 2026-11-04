/**
 * Feature requests — the one definition both clients and the server share.
 *
 * Mirrored into `mobile/shared/lib/featureRequests.ts` by
 * `scripts/sync-shared.mjs`. The status list is pinned against the database
 * enum in `featureRequests.test.ts`, so a fourth status cannot be added on one
 * side only.
 */

export const FEATURE_REQUEST_STATUSES = ['open', 'in_progress', 'not_doing'] as const;
export type FeatureRequestStatus = (typeof FEATURE_REQUEST_STATUSES)[number];

/** Limits enforced by the admin routes' schemas. */
export const FEATURE_REQUEST_TITLE_MAX = 120;
export const FEATURE_REQUEST_BODY_MAX = 1000;
export const FEATURE_REQUEST_REPLY_MAX = 1000;

/**
 * The 409 code a vote on a closed request is refused with. The app hides the
 * vote button on those rows, so the code only reaches a client whose list is
 * stale (the admin closed the request after the screen loaded).
 */
export const VOTING_CLOSED_CODE = 'voting_closed';

/** What `GET /api/feature-requests` returns for each row. */
export interface FeatureRequestView {
  id: string;
  title: string;
  body: string | null;
  status: FeatureRequestStatus;
  reply: string | null;
  voteCount: number;
  votedByMe: boolean;
  createdAt: string;
}

/** What a vote or unvote returns. */
export interface VoteResult {
  voteCount: number;
  votedByMe: boolean;
}

/**
 * Only `not_doing` closes voting. The server refuses a vote there with
 * `VOTING_CLOSED_CODE`; the app shows no vote button there. One rule, so the
 * two cannot disagree.
 */
export function votingOpen(status: FeatureRequestStatus): boolean {
  return status !== 'not_doing';
}

const STATUS_ORDER: Record<FeatureRequestStatus, number> = {
  in_progress: 0,
  open: 1,
  not_doing: 2,
};

/**
 * The order the list is shown in, on the phone and on /admin: in progress
 * first, then open by votes, then not doing. Ties go to the newer request.
 * Done once, on the server; the app does NOT re-sort after a vote, so a row
 * never jumps out from under the thumb that just tapped it.
 */
export function compareFeatureRequests(
  a: Pick<FeatureRequestView, 'status' | 'voteCount' | 'createdAt'>,
  b: Pick<FeatureRequestView, 'status' | 'voteCount' | 'createdAt'>,
): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    b.voteCount - a.voteCount ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}

/**
 * The count the app shows the moment a vote is tapped, before the server
 * answers. The server's `VoteResult` then replaces it.
 */
export function optimisticVote(
  row: Pick<FeatureRequestView, 'voteCount' | 'votedByMe'>,
  vote: boolean,
): VoteResult {
  if (row.votedByMe === vote) return { voteCount: row.voteCount, votedByMe: vote };
  return { voteCount: Math.max(0, row.voteCount + (vote ? 1 : -1)), votedByMe: vote };
}

/**
 * What to say when a vote fails, and whether the list must be re-read. One
 * rule for the iOS screen and the web page, so the two can never word the same
 * failure differently. `status` is null (or 0) when the request never reached
 * a server. A 401 is not handled here: each client sends the user to sign-in.
 */
export function voteFailure(
  status: number | null,
  code: string | null,
): { message: string; reload: boolean } {
  if (status === 409 && code === VOTING_CLOSED_CODE) {
    return { message: 'Voting on this one has closed.', reload: true };
  }
  if (status === 404) return { message: 'That request has been removed.', reload: true };
  if (status == null || status === 0) {
    return {
      message: "Your vote didn't go through. Check your connection and try again.",
      reload: false,
    };
  }
  return { message: "Your vote didn't go through. Try again.", reload: false };
}
