import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * An HONEST placeholder.
 *
 * The workspace shell is real and wired; three of its panes are not written
 * yet. Rather than comment the imports out (which would silently change the
 * shell's behaviour and hide the gap), each unbuilt pane renders this, naming
 * the web component it still has to match and what it must do. If you can see
 * this on a device, that pane is NOT implemented — there is nothing subtle
 * about it.
 */
export function NotBuiltYet({
  name,
  webSource,
  webLines,
  todo,
}: {
  name: string;
  webSource: string;
  webLines: number;
  todo: string[];
}) {
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>NOT BUILT YET</Text>
      </View>
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.meta}>
        Web original: {webSource} ({webLines} lines)
      </Text>
      <Text style={styles.heading}>Still to port</Text>
      {todo.map((t) => (
        <Text key={t} style={styles.item}>
          •  {t}
        </Text>
      ))}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  wrap: { padding: 24, gap: 6 },
  badge: {
    alignSelf: "flex-start",
    backgroundColor: theme.dangerMuted,
    // The web has no NotBuiltYet; this is the danger-border literal the web
    // uses everywhere else, e.g. src/app/login/page.tsx:111.
    borderColor: "rgba(198, 93, 74, 0.35)",
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 10,
  },
  badgeText: { fontSize: 9, fontFamily: font.bold, letterSpacing: 0.8, color: theme.danger },
  title: { fontSize: 20, fontFamily: font.bold, color: theme.text },
  meta: { fontFamily: font.regular, fontSize: 12, color: theme.subtle, marginBottom: 18 },
  heading: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 2,
    color: theme.subtle,
    marginBottom: 6,
  },
  item: { fontFamily: font.regular, fontSize: 13, lineHeight: 20, color: theme.muted },
});
export default NotBuiltYet;
