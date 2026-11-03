import { Pressable, StyleSheet, Text, View } from "react-native";
import InProgressBadge from "@/components/InProgressBadge";
import { VoteIcon } from "@/components/icons";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import { votingOpen, type FeatureRequestView } from "@/shared/lib/featureRequests";

/**
 * One feature request on the Feature requests screen: the vote control on the
 * left, title / description / Sam's reply on the right, and "In progress" in
 * the bottom-right corner when it is.
 *
 * A `not_doing` request is drawn dimmed with its count but NO vote control —
 * `votingOpen` is the same rule the server refuses the vote by. Its reply is
 * the reason.
 *
 * testIDs carry the request id, because the Maestro flow seeds its own rows on
 * a preview that other runs share and must address exactly those. The vote
 * button is one accessibility element, so its LABEL carries the count
 * ("Vote. 3 votes" / "Remove your vote. 4 votes") — that is what VoiceOver
 * reads and what the flow asserts on.
 */
interface Props {
  request: FeatureRequestView;
  onVote: (vote: boolean) => void;
}

export default function FeatureRequestCard({ request, onVote }: Props) {
  const open = votingOpen(request.status);
  const inProgress = request.status === "in_progress";
  const voted = request.votedByMe;
  const countLabel = `${request.voteCount} ${request.voteCount === 1 ? "vote" : "votes"}`;

  return (
    <View
      style={[styles.card, !open && styles.cardClosed, inProgress && styles.cardWithBadge]}
      testID={`feature-request-${request.id}`}
    >
      {open ? (
        <Pressable
          onPress={() => onVote(!voted)}
          style={({ pressed }) => [styles.vote, voted && styles.voteOn, pressed && styles.votePressed]}
          accessibilityRole="button"
          accessibilityState={{ selected: voted }}
          accessibilityLabel={voted ? `Remove your vote. ${countLabel}` : `Vote. ${countLabel}`}
          testID={`feature-request-vote-${request.id}`}
          hitSlop={4}
        >
          <VoteIcon color={voted ? theme.accent400 : theme.muted} />
          {/* No testID of its own: the Pressable is ONE accessibility element
              (its subtree merges), so the count is read off its label. */}
          <Text style={[styles.count, voted && styles.countOn]}>{request.voteCount}</Text>
        </Pressable>
      ) : (
        <View
          style={styles.vote}
          accessible
          accessibilityLabel={`${countLabel}. Voting closed`}
          testID={`feature-request-closed-${request.id}`}
        >
          <VoteIcon color={theme.subtle} />
          <Text style={[styles.count, styles.countClosed]}>{request.voteCount}</Text>
        </View>
      )}

      <View style={styles.body}>
        <Text style={[styles.title, !open && styles.titleClosed]}>{request.title}</Text>
        {request.body ? <Text style={styles.description}>{request.body}</Text> : null}
        {request.reply ? (
          <View style={[styles.reply, !open && styles.replyClosed]}>
            <Text style={styles.replyKicker}>SAM · FERAL TRAVELS</Text>
            <Text style={[styles.replyText, !open && styles.replyTextClosed]}>{request.reply}</Text>
          </View>
        ) : null}
      </View>

      {inProgress ? (
        <View style={styles.badge}>
          <InProgressBadge requestId={request.id} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusMd,
    paddingTop: 14,
    paddingBottom: 14,
    paddingRight: 14,
    paddingLeft: 10,
  },
  cardClosed: { backgroundColor: theme.surfaceMuted },
  // Room under the text for the badge, so it never sits on top of a reply.
  cardWithBadge: { paddingBottom: 44 },
  vote: {
    width: 44,
    height: 52,
    borderRadius: theme.radiusMd,
    borderWidth: 1,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  voteOn: { backgroundColor: theme.primaryMuted, borderColor: theme.primary },
  votePressed: { opacity: 0.7 },
  count: {
    fontFamily: font.semibold,
    fontSize: 13,
    color: theme.muted,
    fontVariant: ["tabular-nums"],
  },
  countOn: { color: theme.accent400 },
  countClosed: { color: theme.subtle },
  body: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontFamily: font.medium, fontSize: 15, lineHeight: 20, color: theme.text },
  titleClosed: { color: theme.muted },
  description: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: theme.muted },
  reply: {
    marginTop: 8,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.neutral900,
    borderRadius: theme.radiusMd,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  replyClosed: { backgroundColor: theme.bg },
  replyKicker: {
    fontFamily: font.semibold,
    fontSize: 9.5,
    letterSpacing: 0.8,
    color: theme.accent400,
  },
  replyText: { fontFamily: font.regular, fontSize: 12.5, lineHeight: 18, color: theme.text, marginTop: 3 },
  replyTextClosed: { color: theme.muted },
  badge: { position: "absolute", right: 10, bottom: 10 },
});
