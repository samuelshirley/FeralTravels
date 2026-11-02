import { StyleSheet } from "react-native";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Every one of these opens Google Maps — `buildSegmentedNavUrls` produces an
 * external URL and `Linking` hands the user to another app. The label says
 * which app and the glyph says it leaves; "Route to" implied turn-by-turn
 * inside a product that has never had any.
 *
 * Lifted out of LegCard (with its styles, unchanged) so the first-launch intro
 * draws the same button without importing a component that fetches fuel.
 */
export function navButtonLabel(seg: { label: string; stopType?: string }): string {
  return `${seg.label} in Google Maps`;
}

export const navButtonStyles = StyleSheet.create({
  /**
   * WRAPS, never truncates, and never exceeds the card.
   *
   * `alignSelf: "flex-start"` keeps a short button content-width, which is what
   * it is for — but on its own it is also uncapped, and in RN the Yoga default
   * for `flexShrink` is 0 (not 1, as on the web), so `navButtonText` could not
   * give either. A long station name therefore grew the row past the card,
   * which sets `overflow: "hidden"`, and the end of the button was cut off.
   *
   * Measured on an iPhone SE (3rd gen) with the real name from a live trip,
   * "Estación de Servicio Repsol": the card ended at x=358 and the button ran
   * to x=363, so its right edge — the rounded corner, and on an `isNext` button
   * the NEXT chip with it — was clipped. The most important button was the one
   * losing its label.
   *
   * `maxWidth: "100%"` caps it at the container; `flexShrink: 1` on the label
   * makes the TEXT the thing that gives, so it wraps to a second line while the
   * icon and the NEXT chip keep their natural size (both already `flexShrink: 0`
   * by RN's default, stated explicitly on the chip because it is the part that
   * must never give). `alignItems: "center"` then reads as deliberate on two
   * lines: the icon and chip sit centred against the whole label block rather
   * than hanging off its first line.
   */
  navButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: theme.primary,
  },
  navButtonText: {
    fontSize: 12,
    fontFamily: font.semibold,
    letterSpacing: 0.5,
    color: theme.onPrimary,
    flexShrink: 1,
  },
  /** The GPS-promoted button. Sits first and reads a shade heavier. */
  navButtonNext: { paddingVertical: 9 },
  /** Everything after a promoted button — still fully tappable, just quieter. */
  navButtonSecondary: { opacity: 0.82 },
  navNextChip: {
    // Never the thing that gives — see navButton. RN defaults flexShrink to 0,
    // but this is the one child where that default is load-bearing.
    flexShrink: 0,
    fontSize: 9,
    fontFamily: font.extrabold,
    letterSpacing: 1,
    color: theme.onPrimary,
    backgroundColor: "rgba(0,0,0,0.18)",
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: "hidden",
  },
});
