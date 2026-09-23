import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import {
  WEEKDAYS,
  dayLabel,
  dayNumber,
  localIso,
  monthGrid,
  monthTitle,
  stepMonth,
} from "@/shared/lib/calendarGrid";

/**
 * A month calendar drawn in the chat, for the onboarding date step. The native
 * port of `src/components/CalendarPopover.tsx`: same grid, same test ids, same
 * contract.
 *
 * Ordinary Views on the theme tokens, NOT the OS picker
 * (`@react-native-community/datetimepicker`) — for the reasons the web walked
 * away from `<input type="date">`: the system calendar is chrome no palette
 * controls, so it is not Nocturne, and the e2e driver cannot see into it. It
 * would also be a native module, which means a prebuild.
 *
 * The date maths — the grid, the local ISO day, the labels — comes from
 * `@/shared/lib/calendarGrid`, the SAME module the web calendar imports, so the
 * two cannot disagree about which day a cell is.
 *
 * It knows nothing about onboarding: it reports a local `YYYY-MM-DD` and the
 * caller submits it. No minimum date — a driver already on the road may well
 * answer with yesterday.
 */
export default function CalendarPopover({ onPick }: { onPick: (iso: string) => void }) {
  const today = new Date();
  const todayIso = localIso(today);
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });

  const cells = monthGrid(view.year, view.month);
  const step = (delta: number) => setView((v) => stepMonth(v, delta));

  return (
    <View testID="onboarding-date-popover" accessibilityLabel="Pick a start date" style={styles.root}>
      <View style={styles.head}>
        <Pressable
          testID="onboarding-date-prev"
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          hitSlop={6}
          onPress={() => step(-1)}
          style={({ pressed }) => [styles.nav, pressed ? styles.navPressed : null]}
        >
          <ChevronLeftIcon color={theme.text} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header" accessibilityLiveRegion="polite">
          {monthTitle(view.year, view.month)}
        </Text>
        <Pressable
          testID="onboarding-date-next"
          accessibilityRole="button"
          accessibilityLabel="Next month"
          hitSlop={6}
          onPress={() => step(1)}
          style={({ pressed }) => [styles.nav, pressed ? styles.navPressed : null]}
        >
          <ChevronRightIcon color={theme.text} />
        </Pressable>
      </View>

      <View style={styles.grid}>
        {WEEKDAYS.map((d) => (
          <View key={d} style={styles.cell} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <Text style={styles.weekday}>{d}</Text>
          </View>
        ))}
        {cells.map((iso, i) =>
          iso === null ? (
            <View key={`blank-${i}`} style={styles.cell} />
          ) : (
            <View key={iso} style={styles.cell}>
              <Pressable
                testID="onboarding-date-day"
                accessibilityRole="button"
                // aria-current="date" has no RN equivalent; VoiceOver hears it
                // in the name instead, and the ISO rides in the value so a
                // Maestro flow can assert which day a cell is.
                accessibilityLabel={iso === todayIso ? `Today, ${dayLabel(iso)}` : dayLabel(iso)}
                accessibilityValue={{ text: iso }}
                onPress={() => onPick(iso)}
                style={({ pressed }) => [
                  styles.day,
                  iso === todayIso ? styles.dayToday : null,
                  pressed ? styles.dayPressed : null,
                ]}
              >
                <Text style={styles.dayText}>{dayNumber(iso)}</Text>
              </Pressable>
            </View>
          ),
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: 260,
    maxWidth: "100%",
    padding: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusMd,
    ...shadow.sm,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  nav: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusSm,
  },
  navPressed: { backgroundColor: theme.primaryMuted },
  title: { fontFamily: font.semibold, fontSize: 13, color: theme.text },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  // Seven to a row; the 1px padding on each side is the web grid's 2px gap.
  cell: { width: `${100 / 7}%`, padding: 1 },
  weekday: {
    fontFamily: font.regular,
    fontSize: 10.5,
    color: theme.subtle,
    textAlign: "center",
    paddingTop: 2,
    paddingBottom: 4,
    letterSpacing: 0.4,
  },
  day: {
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surfaceMuted,
  },
  dayToday: { borderColor: theme.primary },
  dayPressed: { backgroundColor: theme.primaryMuted },
  dayText: { fontFamily: font.regular, fontSize: 13, color: theme.text },
});
