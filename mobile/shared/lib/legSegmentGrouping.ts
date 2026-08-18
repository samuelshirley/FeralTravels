/**
 * Stop-to-stop segment tags for itinerary LEG headers.
 * Drive legs carry segment_index/segment_name from Penny; rest legs at a stop
 * inherit the arriving drive leg's tags (see rebuildTripSchedule).
 */

export function restSegmentFromDriveLeg(drive: {
  segmentIndex: number | null;
  segmentName: string | null;
}): {
  segmentIndex: number | null;
  segmentName: string | null;
} {
  return {
    segmentIndex: drive.segmentIndex ?? null,
    segmentName: drive.segmentName ?? null,
  };
}

/** UI fallback: untagged rest days inherit the nearest preceding segment tag. */
export function effectiveLegSegment(
  leg: {
    segment_index: number | null;
    segment_name: string | null;
    leg_type?: string | null;
  },
  precedingLegs: Array<{ segment_index: number | null; segment_name: string | null }>,
): { segment_index: number | null; segment_name: string | null } {
  if (leg.segment_index != null) {
    return { segment_index: leg.segment_index, segment_name: leg.segment_name };
  }
  if ((leg.leg_type ?? 'drive') !== 'rest') {
    return { segment_index: null, segment_name: null };
  }
  for (let i = precedingLegs.length - 1; i >= 0; i--) {
    const prev = precedingLegs[i];
    if (prev.segment_index != null) {
      return {
        segment_index: prev.segment_index,
        segment_name: prev.segment_name,
      };
    }
  }
  return { segment_index: null, segment_name: null };
}
