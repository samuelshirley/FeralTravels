import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";
import LegCard from "@/components/LegCard";
import { Distance } from "@/components/ui";
import { updateTrip } from "@/lib/api";
import { useUnits } from "@/lib/units";
import { theme, shadow } from "@/lib/theme";
import { PencilRenameIcon } from "@/components/icons";
import { behindCutoffRank, formatDate, parseISODate, todayISOInZone } from "@/shared/lib/dates";
import { isTripCompleted, lastDayFromLegDates } from "@/shared/lib/tripCompletion";
import { effectiveLegSegment } from "@/shared/lib/legSegmentGrouping";
import type { LegWithDetails, Trip } from "@/shared/types/trip";
import { font } from "@/lib/typography";

// Pagination tuning. The first chunk is sized so a 20-day trip fits in a
// single render (matches the user-facing "20 days" model). Subsequent
// chunks are smaller so the loading footer feels like progress, not a
// long pause.
const INITIAL_VISIBLE_LEGS = 20;
const INCREMENTAL_BATCH_SIZE = 10;
/** Breathing room after the last leg so the list scrolls past the final card. */
const ITINERARY_SCROLL_END_INSET = 48;
// The web adds a 220ms artificial pause before revealing each batch so the
// reveal reads as "something happened". Dropped here on purpose: FlatList
// already virtualizes, `onEndReached` fires ahead of the fold (see
// onEndReachedThreshold), and a deliberate delay on a scroll gesture reads as
// jank on a phone rather than as feedback.

/**
 * The driver's own timezone, used to resolve "today" for the behind-you cutoff.
 * The device zone IS the driver's zone on mobile (unlike the web server, which
 * runs in UTC and has to read the stored preference), so reading it here keeps
 * the day boundary correct near midnight. Resolved once per launch.
 */
const DEVICE_TIME_ZONE: string | null = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

interface ItineraryProps {
  trip: Trip;
  legs: LegWithDetails[];
  readonly: boolean;
  /**
   * Set when the user taps a leg or stop marker on the map. We expand the
   * owning leg (revealing it past the lazy window / "behind you" fold if
   * needed) and scroll the leg into view. The nonce lets a repeat tap on the
   * same target re-trigger the scroll.
   */
  focusTarget: { legId: string; stopId?: string | null; nonce: number } | null;
  selectedLegId: string | null;
  onSelectLeg: (legId: string | null) => void;
  onTripUpdated: () => void;
}

/** One rendered row: a segment header or a leg card. */
type Row =
  | {
      kind: "segment";
      key: string;
      segmentIndex: number | null;
      segmentName: string | null;
      dayCount: number;
      km: number;
      first: boolean;
    }
  | { kind: "leg"; key: string; leg: LegWithDetails; first: boolean; last: boolean };

/**
 * Native port of src/components/Itinerary.tsx.
 */
export default function Itinerary({
  trip,
  legs: allLegs,
  readonly,
  focusTarget,
  selectedLegId,
  onSelectLeg,
  onTripUpdated,
}: ItineraryProps) {
  const tripId = trip.id;
  // Mirrors the web's `onLegSelect`, which its LegCard receives as `onNavigate`
  // and never calls — tapping a day expands it, it does not jump to the map.
  // Kept in the signature so the workspace wiring stays identical; the map
  // highlight is driven by `selectedLegId` coming the other way.
  void onSelectLeg;

  // Driver progress splits the itinerary into "behind you" (completed) and the
  // legs from here forward. We anchor the list at the current leg and tuck past
  // days behind a collapsible header so opening the trip shows where the driver
  // is NOW at the top.
  //
  // Two signals feed the cutoff (see behindCutoffRank), combined as a max:
  //   1. The calendar — legs dated strictly before today are past.
  //   2. An explicit reportPosition (trip.current_leg_id) — a floor, so we never
  //      collapse a leg the driver said they'd reached. It does NOT freeze the
  //      view: the calendar advances past a stale report as real days pass.
  const reportedRank = trip.current_leg_id
    ? allLegs.findIndex((l) => l.id === trip.current_leg_id)
    : -1;
  // A trip whose last day has passed has nothing ahead of it. Every day goes
  // behind the fold and the list above it renders empty — no "0 days left"
  // summary, no prompt to do anything. behindCutoffRank deliberately keeps the
  // final leg visible so a live trip's list is never empty; that guard is what
  // we're overriding here, and only here.
  const completed = isTripCompleted(
    lastDayFromLegDates(allLegs.map((l) => l.date_iso)),
    todayISOInZone(DEVICE_TIME_ZONE)
  );
  const currentRank = completed
    ? allLegs.length
    : behindCutoffRank({
        reportedRank,
        legDateISOs: allLegs.map((l) => l.date_iso),
        todayISO: todayISOInZone(DEVICE_TIME_ZONE),
      });
  // Memoized so the row builder below (and its useMemo) don't see a fresh array
  // identity on every render — `allLegs` only changes when the trip reloads.
  const pastLegs = useMemo(
    () => (currentRank > 0 ? allLegs.slice(0, currentRank) : []),
    [allLegs, currentRank]
  );
  const legs = useMemo(
    () => (currentRank > 0 ? allLegs.slice(currentRank) : allLegs),
    [allLegs, currentRank]
  );

  const { units } = useUnits();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showPast, setShowPast] = useState(false);
  // Stop id to briefly ring after a map marker tap, so the user's eye lands on
  // the right card. Cleared on a timer.
  const [highlightStopId, setHighlightStopId] = useState<string | null>(null);

  // While any leg's fuel search is in flight the per-leg nav links are composed
  // from stops that are about to change, so every card shows the syncing
  // affordance. The web computes this in TripWorkspace and passes it down; the
  // native workspace keeps the same value for its header chip, so we derive it
  // here rather than widening this component's fixed prop signature.
  const isFuelSyncing = allLegs.some(
    (l) => l.fuel_status === "computing" || l.fuel_status === "pending"
  );

  // The calendar date for each leg is computed server-side (leg.date_iso).
  // Here we only format it for the user's locale preference — no date math.
  const legDateLabels = useMemo(() => {
    const map = new Map<string, string>();
    // Every leg has a date_iso — the trip start date is a hard invariant.
    for (const leg of allLegs) {
      map.set(leg.id, formatDate(parseISODate(leg.date_iso), units));
    }
    return map;
  }, [allLegs, units]);

  // ── Lazy rendering ─────────────────────────────────────────────────────
  // We mount the first INITIAL_VISIBLE_LEGS leg cards and reveal more in
  // batches as the user scrolls near the end of the list. Trips with
  // <= INITIAL_VISIBLE_LEGS render everything immediately.
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(legs.length, INITIAL_VISIBLE_LEGS)
  );

  // ── Inline trip-name edit ──────────────────────────────────────────────
  // The app auto-names the trip; this lets the user override that name in
  // place. Tapping the pencil swaps the title for a text input; saving
  // PATCHes the name and refreshes via onTripUpdated.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(trip.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<TextInput | null>(null);

  const listRef = useRef<FlatList<Row> | null>(null);

  // Keep the draft in sync when the persisted name changes (e.g. Penny renamed
  // it) while we're not actively editing.
  useEffect(() => {
    if (!editingName) setNameDraft(trip.name);
  }, [trip.name, editingName]);

  const startEditingName = () => {
    setNameDraft(trip.name);
    setNameError(null);
    setEditingName(true);
  };

  const cancelEditingName = () => {
    setEditingName(false);
    setNameError(null);
    setNameDraft(trip.name);
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next) {
      setNameError("Name cannot be empty");
      return;
    }
    if (next === trip.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      // The web PATCHes with skipGlobalErrorReport so a name collision is only
      // reported inline; the native `updateTrip` helper has no such option, so a
      // collision also raises the global toast. Inline copy is still the primary
      // signal — it sits right under the input the user is fixing.
      await updateTrip(tripId, { name: next });
      setEditingName(false);
      onTripUpdated();
    } catch (err) {
      setNameError(
        err instanceof Error && err.message ? err.message : "Could not save name"
      );
    } finally {
      setSavingName(false);
    }
  };

  // Focus the input when entering edit mode.
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  // Keep visibleCount in sync as legs are added/removed underneath us. If
  // the trip grew, we don't auto-reveal — let the scroll trigger that. If the
  // trip shrank below visibleCount, clamp down so we don't try to render
  // past the array.
  useEffect(() => {
    setVisibleCount((current) => Math.min(current, legs.length) || legs.length);
  }, [legs.length]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Expand-All implies "show me everything" — reveal all legs in addition to
  // expanding their cards. Otherwise users would tap Expand All and only
  // see the first 20 cards expanded with the rest still hidden.
  const expandAll = () => {
    setVisibleCount(legs.length);
    setExpanded(new Set(legs.map((l) => l.id)));
  };
  const collapseAll = () => setExpanded(new Set());

  const visibleLegs = useMemo(() => legs.slice(0, visibleCount), [legs, visibleCount]);
  const hiddenCount = legs.length - visibleCount;

  // ── Segment grouping ───────────────────────────────────────────────────
  // Each leg row is a *driving day* in user terms. When Penny has tagged
  // legs with a segment_index, we may render them grouped under segment
  // headers — but only if the trip is large enough that grouping helps,
  // per the user's rule: "more than 20 days OR more than 5 segments".
  // Trips smaller than that always render as a flat day list, even when
  // segment data exists.
  const distinctSegments = new Set(
    legs.map((l) => l.segment_index).filter((i): i is number => i != null)
  ).size;
  const shouldGroup = distinctSegments > 0 && (legs.length > 20 || distinctSegments > 5);

  // Walk visibleLegs and bucket consecutive same-segment legs together, then
  // flatten to rows so a single FlatList can render headers and cards (and so
  // scrollToIndex has one index space to address). Legs whose segment_index is
  // null become single-leg "loose" groups so they slot into the order they were
  // authored in.
  const rows = useMemo<Row[]>(() => {
    if (!shouldGroup) {
      return visibleLegs.map((leg, i) => ({
        kind: "leg" as const,
        key: leg.id,
        leg,
        first: i === 0,
        last: i === visibleLegs.length - 1,
      }));
    }

    type LegGroup = {
      key: string;
      segmentIndex: number | null;
      segmentName: string | null;
      legs: LegWithDetails[];
    };
    const groups: LegGroup[] = [];
    const preceding: LegWithDetails[] = [];
    for (const leg of visibleLegs) {
      const effective = effectiveLegSegment(leg, preceding);
      preceding.push(leg);
      const last = groups[groups.length - 1];
      if (
        last &&
        last.segmentIndex === effective.segment_index &&
        effective.segment_index != null
      ) {
        last.legs.push(leg);
      } else {
        groups.push({
          key: `${effective.segment_index ?? `loose-${leg.id}`}`,
          segmentIndex: effective.segment_index,
          segmentName: effective.segment_name,
          legs: [leg],
        });
      }
    }

    const out: Row[] = [];
    groups.forEach((group, gi) => {
      out.push({
        kind: "segment",
        key: `seg-${group.key}`,
        segmentIndex: group.segmentIndex,
        segmentName: group.segmentName,
        dayCount: group.legs.length,
        km: group.legs.reduce((sum, l) => sum + (l.distance_km || 0), 0),
        first: gi === 0,
      });
      group.legs.forEach((leg, i) => {
        out.push({
          kind: "leg",
          key: leg.id,
          leg,
          first: i === 0,
          last: i === group.legs.length - 1,
        });
      });
    });
    return out;
  }, [shouldGroup, visibleLegs]);

  // Read by the focus effect, which is keyed on the nonce only and must not
  // re-run when the rows array identity changes.
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;

  // ── Map-marker focus → open in list ────────────────────────────────────
  // When the user taps a leg/stop marker on the map, expand the owning leg
  // (revealing it past the lazy window or the "behind you" fold first), then
  // scroll it into view and briefly ring the stop. Keyed on the focus nonce so
  // a repeat tap on the same target re-fires.
  useEffect(() => {
    if (!focusTarget) return;
    const { legId, stopId } = focusTarget;
    const allIdx = allLegs.findIndex((l) => l.id === legId);
    if (allIdx === -1) return;

    if (currentRank > 0 && allIdx < currentRank) {
      // The leg is in the collapsed "behind you" section — open it.
      setShowPast(true);
    } else {
      // Ensure it's within the lazily-revealed window so the card is mounted.
      const fwdIdx = currentRank > 0 ? allIdx - currentRank : allIdx;
      setVisibleCount((c) => Math.max(c, fwdIdx + 1));
    }

    setExpanded((prev) => {
      if (prev.has(legId)) return prev;
      const next = new Set(prev);
      next.add(legId);
      return next;
    });
    setHighlightStopId(stopId ?? null);

    // Wait for the expand/reveal to render, then scroll the target into view.
    const scrollTimer = setTimeout(() => {
      const index = rowsRef.current.findIndex((r) => r.kind === "leg" && r.leg.id === legId);
      if (index >= 0) {
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      } else {
        // Past legs live inside the list header (the "Behind you" block), which
        // has no row index — the top of the list is where they are.
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      }
    }, 90);

    const clearHighlight = setTimeout(() => setHighlightStopId(null), 2200);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearHighlight);
    };
    // Intentionally keyed on the nonce only: allLegs/currentRank are read fresh
    // at tap time, and we don't want trip reloads to re-trigger a scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget?.nonce]);

  const totalDist = allLegs.reduce((sum, l) => sum + (l.distance_km || 0), 0);
  const drivingDays = allLegs.filter((l) => (l.leg_type ?? "drive") !== "rest").length;
  const restDays = allLegs.filter((l) => (l.leg_type ?? "drive") === "rest").length;

  const stats: Array<{ label: string; value: React.ReactNode }> = [
    // Primary total uses Distance so imperial users see the (X mi)
    // secondary line under the km value.
    {
      label: "TOTAL",
      value: (
        <Distance km={totalDist} primaryOverride={`~${totalDist.toLocaleString()} km`} />
      ),
    },
    // Show total days, with driving/rest breakdown when rest days exist.
    ...(restDays > 0
      ? [
          { label: "TOTAL DAYS", value: `${allLegs.length}` as React.ReactNode },
          { label: "DRIVING", value: `${drivingDays}` as React.ReactNode },
          { label: "REST", value: `${restDays}` as React.ReactNode },
        ]
      : [{ label: "DAYS", value: `${allLegs.length}` as React.ReactNode }]),
  ];

  const dateRange = [trip.start_date, trip.end_date].filter(Boolean).join(" → ");

  const renderLegCard = (leg: LegWithDetails, isPast: boolean) => (
    <LegCard
      tripId={tripId}
      leg={leg}
      expanded={expanded.has(leg.id)}
      onToggle={() => toggle(leg.id)}
      onChanged={onTripUpdated}
      readonly={readonly}
      dateLabel={legDateLabels.get(leg.id)}
      isFuelSyncing={isFuelSyncing}
      fuelSyncTotalLegs={isPast ? allLegs.length : legs.length}
      highlightStopId={highlightStopId}
      selected={selectedLegId === leg.id}
      isPast={isPast}
    />
  );

  const header = (
    <View>
      {/* Header */}
      <View style={styles.headerBlock}>
        <Text style={styles.eyebrow}>
          ROUTE PLAN
          {completed ? <Text style={styles.eyebrowCompleted}> · COMPLETED</Text> : null}
          {readonly ? (
            <Text style={styles.eyebrowDemo}> · DEMO (read-only — clone to edit)</Text>
          ) : null}
        </Text>

        {editingName ? (
          <View>
            <View style={styles.nameEditRow}>
              <TextInput
                ref={nameInputRef}
                value={nameDraft}
                onChangeText={setNameDraft}
                onSubmitEditing={() => void saveName()}
                maxLength={200}
                editable={!savingName}
                accessibilityLabel="Trip name"
                style={styles.nameInput}
              />
              <Pressable
                onPress={() => void saveName()}
                disabled={savingName}
                accessibilityLabel="Save name"
                style={styles.saveButton}
              >
                <Text style={styles.saveButtonText}>{savingName ? "Saving…" : "Save"}</Text>
              </Pressable>
              <Pressable
                onPress={cancelEditingName}
                disabled={savingName}
                accessibilityLabel="Cancel"
                style={styles.cancelButton}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </Pressable>
            </View>
            {nameError ? <Text style={styles.nameError}>{nameError}</Text> : null}
          </View>
        ) : (
          <View style={styles.nameRow}>
            <Text style={styles.tripName}>{trip.name}</Text>
            {!readonly ? (
              <Pressable
                onPress={startEditingName}
                accessibilityLabel="Rename trip"
                hitSlop={8}
                style={styles.pencilButton}
              >
                {/* src/components/Itinerary.tsx:474-487 — same pencil, and the
                    web tints it var(--tp-subtle) (:467). */}
                <PencilRenameIcon color={theme.subtle} />
              </Pressable>
            ) : null}
          </View>
        )}

        {dateRange ? <Text style={styles.dateRange}>{dateRange}</Text> : null}

        <View style={styles.statRow}>
          {stats.map((s, i) => (
            <View key={i}>
              <Text style={styles.statLabel}>{s.label}</Text>
              {typeof s.value === "string" ? (
                <Text style={styles.statValue}>{s.value}</Text>
              ) : (
                <View style={styles.statValueBox}>{s.value}</View>
              )}
            </View>
          ))}
        </View>
      </View>

      {/* Controls — they act on the days ahead, so a completed trip has none. */}
      {completed ? null : (
        <View style={styles.controls}>
          <Pressable onPress={expandAll} style={styles.controlButton}>
            <Text style={styles.controlText}>Expand All</Text>
          </Pressable>
          <Pressable onPress={collapseAll} style={styles.controlButton}>
            <Text style={styles.controlText}>Collapse All</Text>
          </Pressable>
        </View>
      )}

      {/* Past days, collapsed by default so the trip opens at where the driver
          actually is. On a live trip the header says "behind you" rather than
          "completed": the cutoff is positional (calendar/report), not proof the
          driver finished those days. On a completed trip it is the only thing
          left on the screen, so it reads as the disclosure it now is. */}
      {pastLegs.length > 0 ? (
        <View style={styles.pastBlock}>
          <Pressable onPress={() => setShowPast((v) => !v)} style={styles.pastToggle}>
            <Text style={styles.pastToggleText}>
              {showPast ? "▾" : "▸"}{" "}
              {completed
                ? `${showPast ? "Hide" : "Show"} past days — ${pastLegs.length} day${
                    pastLegs.length === 1 ? "" : "s"
                  }`
                : `Behind you — ${pastLegs.length} earlier day${
                    pastLegs.length === 1 ? "" : "s"
                  }`}
            </Text>
          </Pressable>
          {showPast ? (
            <View style={styles.pastList}>
              {pastLegs.map((leg) => (
                <View key={leg.id}>{renderLegCard(leg, true)}</View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const footer =
    hiddenCount > 0 ? (
      <View style={styles.loadMore}>
        <Text style={styles.loadMoreText}>
          Loading {Math.min(hiddenCount, INCREMENTAL_BATCH_SIZE)} more leg
          {Math.min(hiddenCount, INCREMENTAL_BATCH_SIZE) === 1 ? "" : "s"}…
          {hiddenCount > INCREMENTAL_BATCH_SIZE ? (
            <Text style={styles.loadMoreRemaining}> ({hiddenCount} remaining)</Text>
          ) : null}
        </Text>
      </View>
    ) : null;

  const renderRow = ({ item }: ListRenderItemInfo<Row>) => {
    if (item.kind === "segment") {
      // Segment header. Looks like a small section title, not a full chrome
      // card — the leg cards underneath carry the visual weight. Loose legs (no
      // segment tagged) get a dimmer, non-numbered header so they read as
      // "uncatalogued" rather than as their own equal-weight segment.
      const isLoose = item.segmentIndex === null;
      return (
        <View style={[styles.segmentHeader, !item.first && styles.segmentHeaderSpaced]}>
          <Text style={styles.segmentKicker}>
            {isLoose ? "OTHER" : `LEG ${(item.segmentIndex ?? 0) + 1}`}
          </Text>
          <Text
            style={[styles.segmentName, isLoose && styles.segmentNameLoose]}
            numberOfLines={1}
          >
            {item.segmentName ?? "—"}
          </Text>
          <Text style={styles.segmentMeta}>
            {item.dayCount} day{item.dayCount === 1 ? "" : "s"}
            {item.km > 0 ? (
              <Text style={styles.segmentMeta}>
                {" · "}
                <Distance
                  km={Math.round(item.km)}
                  layout="inline"
                  primaryOverride={`~${Math.round(item.km).toLocaleString()} km`}
                />
              </Text>
            ) : null}
          </Text>
        </View>
      );
    }
    return (
      <View
        style={[
          styles.legContainer,
          item.first && styles.legContainerFirst,
          item.last && styles.legContainerLast,
        ]}
      >
        {renderLegCard(item.leg, false)}
      </View>
    );
  };

  return (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={renderRow}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        setVisibleCount((c) => Math.min(legs.length, c + INCREMENTAL_BATCH_SIZE));
      }}
      onScrollToIndexFailed={(info) => {
        // Rows are variable height, so FlatList can't always resolve an offset
        // for an index it hasn't measured yet. Approximate, then retry once the
        // real rows are laid out.
        listRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: true,
        });
        setTimeout(() => {
          listRef.current?.scrollToIndex({
            index: info.index,
            animated: true,
            viewPosition: 0.5,
          });
        }, 120);
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: ITINERARY_SCROLL_END_INSET },
  headerBlock: { marginBottom: 20 },
  eyebrow: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1.5,
    color: theme.subtle,
    marginBottom: 6,
  },
  eyebrowDemo: { color: theme.primary },
  eyebrowCompleted: { color: theme.muted },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  tripName: { flex: 1, fontSize: 24, fontFamily: font.bold, lineHeight: 29, color: theme.text },
  pencilButton: { padding: 4 },
  nameEditRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  nameInput: {
    flex: 1,
    fontSize: 20,
    fontFamily: font.bold,
    color: theme.text,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  saveButton: {
    backgroundColor: theme.primary,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  saveButtonText: { color: theme.onPrimary, fontSize: 12, fontFamily: font.semibold },
  cancelButton: {
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  cancelButtonText: { fontFamily: font.regular, color: theme.muted, fontSize: 12 },
  nameError: { fontFamily: font.regular, fontSize: 12, color: theme.danger, marginTop: 6 },
  dateRange: { fontFamily: font.regular, fontSize: 13, color: theme.muted, marginTop: 6 },
  statRow: { flexDirection: "row", flexWrap: "wrap", gap: 20, marginTop: 14 },
  statLabel: { fontSize: 9, fontFamily: font.bold, letterSpacing: 1, color: theme.subtle },
  statValue: { fontSize: 14, fontFamily: font.semibold, color: theme.text, marginTop: 2 },
  statValueBox: { marginTop: 2 },
  controls: { flexDirection: "row", gap: 8, marginBottom: 12 },
  controlButton: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 4,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  controlText: { fontFamily: font.regular, fontSize: 11, color: theme.muted },
  pastBlock: { marginBottom: 12 },
  pastToggle: {
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  pastToggleText: { fontSize: 12, fontFamily: font.semibold, color: theme.muted },
  pastList: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: theme.surface,
    marginTop: 8,
    // The web dims the whole "behind you" block to 0.75 — these are days the
    // driver has already passed.
    opacity: 0.75,
  },
  // The web wraps the leg list in one bordered, rounded card. A FlatList can't
  // wrap its rows, so each row carries the sides and the ends carry the caps.
  legContainer: {
    backgroundColor: theme.surface,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: theme.border,
  },
  legContainerFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    ...shadow.sm,
  },
  legContainerLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
  },
  segmentHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingHorizontal: 4,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    marginBottom: 8,
  },
  segmentHeaderSpaced: { marginTop: 18 },
  segmentKicker: { fontSize: 9, fontFamily: font.bold, letterSpacing: 1.6, color: theme.subtle },
  segmentName: { flex: 1, minWidth: 0, fontSize: 15, fontFamily: font.semibold, color: theme.text },
  segmentNameLoose: { color: theme.muted },
  segmentMeta: { fontFamily: font.regular, fontSize: 11, color: theme.subtle },
  loadMore: {
    marginTop: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.border,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  loadMoreText: { fontSize: 11, letterSpacing: 0.9, color: theme.muted, fontFamily: font.semibold },
  loadMoreRemaining: { color: theme.subtle },
});
