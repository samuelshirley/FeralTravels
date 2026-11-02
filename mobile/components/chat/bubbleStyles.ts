import { StyleSheet } from "react-native";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * The chat bubble's look, in ONE place. ChatPanel draws the real transcript
 * with these, and the first-launch intro (components/intro/) draws its
 * "how it works" bubbles with the same objects, so the preview cannot drift
 * from the screen it previews. Corner radii come from `bubbleRadius`
 * (./format.ts), which both also share.
 */
export const bubbleStyles = StyleSheet.create({
  row: { maxWidth: "80%" },
  bubble: { paddingVertical: 8, paddingHorizontal: 14 },
  bubbleUser: { backgroundColor: theme.primaryMuted },
  bubbleAssistant: { backgroundColor: theme.surface },
  bubbleText: { fontFamily: font.regular, fontSize: 14, color: theme.text, lineHeight: 21 },
});
