import { StyleSheet, Text, View } from "react-native";
import type { PlanSummary } from "@/shared/types/trip";
import { formatKm, type UnitsPref } from "@/shared/lib/units";
import { theme } from "@/lib/theme";
import { fmtPlanDate, formatClock, formatDuration, formatSlack } from "./format";
import { font } from "@/lib/typography";

/**
 * Deterministic plan summary card. Renders the DB-derived facts that Penny is
 * FORBIDDEN from stating in prose — day counts, dates, totals, deadline check —
 * so the numbers the user sees are always the plan that actually saved. Penny's
 * bubble above is the conversational wrapper; THIS is the source of truth.
 *
 * That is the entire reason this card exists: an LLM asked to recite "you
 * arrive Thursday at 16:20 after 512 km" will happily invent all three. Every
 * number below comes from `computePlanSummary` on the server, reading the
 * persisted legs. Never render Penny's prose numbers here, and never let this
 * card fall back to parsing her text.
 *
 * Clock formatting follows the units preference: 24h for metric, 12h AM/PM for
 * imperial (see formatClock).
 */
export default function PlanSummaryCard({
  summary,
  units,
}: {
  summary: PlanSummary;
  units: UnitsPref;
}) {
  const departDate = fmtPlanDate(summary.depart_date_iso, units);
  const arriveDate = fmtPlanDate(summary.arrive_date_iso, units);
  const deadlineDate = fmtPlanDate(summary.deadline?.date_iso ?? null, units);
  const departTime = formatClock(summary.depart_time, units);
  const arriveTime = formatClock(summary.arrive_time, units);

  const dl = summary.deadline;
  const dlTime = formatClock(dl?.local_time ?? null, units);
  const clock = dl?.same_day_clock ?? null;
  const lateSameDay = clock != null && clock.slack_minutes < 0;
  const tightSameDay =
    clock != null && clock.slack_minutes >= 0 && !clock.clears_buffer;
  const missed = dl?.status === "after" || lateSameDay;

  const dayBits = [`${summary.total_days} day${summary.total_days !== 1 ? "s" : ""}`];
  if (summary.drive_days > 0) dayBits.push(`${summary.drive_days} driving`);
  if (summary.rest_days > 0) dayBits.push(`${summary.rest_days} rest`);

  // Deadline phrasing appended to the Arrive line. All numbers deterministic.
  let deadlineSuffix: string | null = null;
  if (dl && deadlineDate) {
    const dlLabel = `${deadlineDate}${dlTime ? ` ${dlTime}` : ""}`;
    if (dl.status === "before" && dl.buffer_days != null) {
      deadlineSuffix = ` — ${dl.buffer_days} day${
        dl.buffer_days !== 1 ? "s" : ""
      } before your ${dlLabel} deadline`;
    } else if (dl.status === "after" && dl.buffer_days != null) {
      const late = Math.abs(dl.buffer_days);
      deadlineSuffix = ` — ${late} day${
        late !== 1 ? "s" : ""
      } AFTER your ${dlLabel} deadline`;
    } else if (dl.status === "same_day") {
      const dlClock = dlTime ?? "deadline";
      if (lateSameDay) {
        deadlineSuffix = ` — past your ${dlClock} deadline`;
      } else if (tightSameDay && clock) {
        deadlineSuffix = ` — only ${formatSlack(
          clock.slack_minutes
        )} before your ${dlClock} deadline (tight)`;
      } else if (clock && clock.clears_buffer) {
        deadlineSuffix = ` — ${formatSlack(
          clock.slack_minutes
        )} before your ${dlClock} deadline`;
      } else {
        deadlineSuffix = ` — your deadline day`;
      }
    }
  }

  // The web uses a literal #c98a00 for the "tight" case rather than the warning
  // token — kept as-is so the two clients read identically.
  const arriveColor = missed ? theme.danger : tightSameDay ? "#c98a00" : theme.text;

  return (
    <View style={styles.card}>
      <Text style={styles.days}>{dayBits.join(" · ")}</Text>

      {departDate ? (
        <Text style={styles.line}>
          <Text style={styles.label}>Depart </Text>
          {summary.depart_name ? `${summary.depart_name} · ` : ""}
          {departDate}
          {departTime ? ` · leave ${departTime}` : ""}
        </Text>
      ) : null}

      {arriveDate ? (
        <Text style={[styles.line, { color: arriveColor }]}>
          <Text style={styles.label}>Arrive </Text>
          {summary.arrive_name ? `${summary.arrive_name} · ` : ""}
          {arriveDate}
          {arriveTime ? ` · ETA ~${arriveTime}` : ""}
          {deadlineSuffix ?? ""}
        </Text>
      ) : null}

      {summary.total_drive_minutes > 0 ? (
        <Text style={styles.line}>
          <Text style={styles.label}>Driving </Text>
          {formatDuration(summary.total_drive_minutes)}
          {summary.total_distance_km > 0
            ? ` · ${formatKm(summary.total_distance_km, units)}`
            : ""}
        </Text>
      ) : null}

      {summary.nights_per_stop.length > 0 ? (
        <Text style={styles.line}>
          <Text style={styles.label}>Nights </Text>
          {summary.nights_per_stop.map((s) => `${s.name ?? "stop"} ${s.nights}`).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 6,
    borderWidth: 1,
    // src/components/ChatPanel.tsx:324
    borderColor: "rgba(127, 127, 127, 0.22)",
    gap: 2,
  },
  days: { fontSize: 11.5, fontFamily: font.semibold, color: theme.text, lineHeight: 18 },
  line: { fontFamily: font.regular, fontSize: 11.5, color: theme.text, lineHeight: 18 },
  label: { color: theme.muted },
});
