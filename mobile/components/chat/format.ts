import { formatDate, parseISODate } from "@/shared/lib/dates";
import type { UnitsPref } from "@/shared/lib/units";

/* ── iMessage-style grouping ─────────────────────────────────────────────
 * Consecutive messages from the same role are visually grouped: tighter
 * spacing and varied corner radii. Straight port of getGroupPosition /
 * bubbleRadius in src/components/ChatPanel.tsx — the only difference is that
 * RN wants four numeric corner props instead of a CSS shorthand string. */
export interface GroupPosition {
  isFirst: boolean;
  isLast: boolean;
}

export function getGroupPosition(
  messages: { role: string }[],
  index: number
): GroupPosition {
  const msg = messages[index];
  const prev = index > 0 ? messages[index - 1] : null;
  const next = index < messages.length - 1 ? messages[index + 1] : null;
  return {
    isFirst: !prev || prev.role !== msg?.role,
    isLast: !next || next.role !== msg?.role,
  };
}

export interface BubbleRadii {
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomRightRadius: number;
  borderBottomLeftRadius: number;
}

/** The iMessage-style corner radii for a bubble: 18 full, 4 on the grouped side. */
export function bubbleRadius(role: string, pos: GroupPosition): BubbleRadii {
  const R = 18; // full radius
  const r = 4; // grouped-side radius
  if (role === "user") {
    // Right side grouped: top-right and bottom-right shrink for non-edge.
    return {
      borderTopLeftRadius: R,
      borderTopRightRadius: pos.isFirst ? R : r,
      borderBottomRightRadius: pos.isLast ? R : r,
      borderBottomLeftRadius: R,
    };
  }
  // Assistant: left side grouped.
  return {
    borderTopLeftRadius: pos.isFirst ? R : r,
    borderTopRightRadius: R,
    borderBottomRightRadius: R,
    borderBottomLeftRadius: pos.isLast ? R : r,
  };
}

/** minutes → "~5h 12m" / "~45m" — planning-grade, not odometer-grade. */
export function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h <= 0) return `~${m}m`;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

export function fmtPlanDate(iso: string | null, units: UnitsPref): string | null {
  if (!iso) return null;
  return formatDate(parseISODate(iso), units);
}

/** "HH:MM" → "08:00" (metric, 24h) or "8:00 AM" (imperial, 12h). */
export function formatClock(
  hhmm: string | null | undefined,
  units: UnitsPref
): string | null {
  if (!hhmm) return null;
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  if (units === "imperial") {
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${period}`;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes of slack → "26 min" / "2h 10m" (absolute value). */
export function formatSlack(minutes: number): string {
  const a = Math.abs(minutes);
  if (a < 60) return `${a} min`;
  const h = Math.floor(a / 60);
  const m = a % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
