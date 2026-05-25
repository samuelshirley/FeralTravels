import { describe, expect, it } from 'vitest';
import {
  effectiveLegSegment,
  restSegmentFromDriveLeg,
} from './legSegmentGrouping';

describe('restSegmentFromDriveLeg', () => {
  it('copies segment tags from the anchor drive leg', () => {
    expect(
      restSegmentFromDriveLeg({
        segmentIndex: 0,
        segmentName: 'Girona → Innsbruck',
      }),
    ).toEqual({
      segmentIndex: 0,
      segmentName: 'Girona → Innsbruck',
    });
  });

  it('returns null tags when the drive leg is untagged', () => {
    expect(
      restSegmentFromDriveLeg({ segmentIndex: null, segmentName: null }),
    ).toEqual({
      segmentIndex: null,
      segmentName: null,
    });
  });
});

describe('effectiveLegSegment', () => {
  it('returns explicit tags when present', () => {
    expect(
      effectiveLegSegment(
        {
          segment_index: 1,
          segment_name: 'Innsbruck → Bad Kissingen',
          leg_type: 'rest',
        },
        [],
      ),
    ).toEqual({
      segment_index: 1,
      segment_name: 'Innsbruck → Bad Kissingen',
    });
  });

  it('inherits preceding segment for untagged rest days', () => {
    const preceding = [
      { segment_index: 0, segment_name: 'Girona → Innsbruck' },
      { segment_index: 0, segment_name: 'Girona → Innsbruck' },
    ];
    expect(
      effectiveLegSegment(
        { segment_index: null, segment_name: null, leg_type: 'rest' },
        preceding,
      ),
    ).toEqual({
      segment_index: 0,
      segment_name: 'Girona → Innsbruck',
    });
  });

  it('does not inherit for untagged drive days', () => {
    expect(
      effectiveLegSegment(
        { segment_index: null, segment_name: null, leg_type: 'drive' },
        [{ segment_index: 0, segment_name: 'Girona → Innsbruck' }],
      ),
    ).toEqual({
      segment_index: null,
      segment_name: null,
    });
  });

  it('walks backward past untagged legs to find a segment', () => {
    const preceding = [
      { segment_index: 0, segment_name: 'Girona → Innsbruck' },
      { segment_index: null, segment_name: null },
      { segment_index: null, segment_name: null },
    ];
    expect(
      effectiveLegSegment(
        { segment_index: null, segment_name: null, leg_type: 'rest' },
        preceding,
      ),
    ).toEqual({
      segment_index: 0,
      segment_name: 'Girona → Innsbruck',
    });
  });
});

describe('itinerary grouping (Girona scenario)', () => {
  type Day = {
    id: string;
    segment_index: number | null;
    segment_name: string | null;
    leg_type: 'drive' | 'rest';
  };

  function bucketLegs(days: Day[]) {
    const groups: Array<{ segmentIndex: number | null; ids: string[] }> = [];
    const preceding: Day[] = [];
    for (const leg of days) {
      const effective = effectiveLegSegment(leg, preceding);
      preceding.push(leg);
      const last = groups[groups.length - 1];
      if (
        last &&
        last.segmentIndex === effective.segment_index &&
        effective.segment_index != null
      ) {
        last.ids.push(leg.id);
      } else {
        groups.push({
          segmentIndex: effective.segment_index,
          ids: [leg.id],
        });
      }
    }
    return groups;
  }

  it('groups Innsbruck rest days under LEG 1 with drive days', () => {
    const days: Day[] = [
      { id: 'd1', segment_index: 0, segment_name: 'Girona → Innsbruck', leg_type: 'drive' },
      { id: 'd2', segment_index: 0, segment_name: 'Girona → Innsbruck', leg_type: 'drive' },
      { id: 'r1', segment_index: null, segment_name: null, leg_type: 'rest' },
      { id: 'r2', segment_index: null, segment_name: null, leg_type: 'rest' },
      { id: 'r3', segment_index: null, segment_name: null, leg_type: 'rest' },
      { id: 'd3', segment_index: 1, segment_name: 'Innsbruck → Bad Kissingen', leg_type: 'drive' },
    ];

    const groups = bucketLegs(days);
    expect(groups).toHaveLength(2);
    expect(groups[0].segmentIndex).toBe(0);
    expect(groups[0].ids).toEqual(['d1', 'd2', 'r1', 'r2', 'r3']);
    expect(groups[1].segmentIndex).toBe(1);
    expect(groups[1].ids).toEqual(['d3']);
  });
});
