/**
 * Tests for post-pipeline edit-override detection + its applyOutcome surfacing.
 *
 * The scenario these protect: Penny's prose streams before dispatch; the
 * deterministic pipeline (rebuildTripSchedule / repairLegContinuity) may then
 * rewrite a leg she just edited. Real incident (prod, 2026-07-02): a rest day
 * was update_leg'd into "Trondheim → Campsite (Alset area)", the rebuild
 * re-materialized it back to a Trondheim rest day, and the transcript kept
 * claiming the campsite was saved. detectOverriddenLegEdits is the tripwire.
 *
 * (The deriveApplyOutcome cases live here rather than in applyOutcome.test.ts
 * to keep this change self-contained.)
 */
import { describe, it, expect } from 'vitest';

import {
  detectOverriddenLegEdits,
  overriddenEditsSummary,
  type OverrideCheckLegRow,
} from './editOverride';
import { deriveApplyOutcome } from './applyOutcome';

const LEG_ID = '00000000-0000-0000-0000-000000000001';

/** The persisted row AFTER the pipeline re-materialized the rest day. */
const revertedRow: OverrideCheckLegRow = {
  id: LEG_ID,
  title: 'Trondheim, Norway (rest day)',
  startName: 'Trondheim, Norway',
  endName: 'Trondheim, Norway',
  startLat: 63.43037,
  startLng: 10.39503,
  endLat: 63.43037,
  endLng: 10.39503,
};

/** Penny's campsite edit — exactly the prod payload. */
const campsiteEdit = {
  name: 'update_leg',
  input: {
    leg_id: LEG_ID,
    data: {
      title: 'Trondheim → Campsite (Alset area)',
      start_name: 'Trondheim, Norway',
      end_name: 'Campsite, Alset, Norway',
      start_lat: 63.43037,
      start_lng: 10.39503,
      end_lat: 63.6989632,
      end_lng: 10.4189239,
      distance_km: 53.1,
      drive_time_minutes: 88,
    },
  },
};

describe('detectOverriddenLegEdits', () => {
  it('flags the campsite-revert incident (title/end moved back)', () => {
    const out = detectOverriddenLegEdits([campsiteEdit], [revertedRow]);
    expect(out).toHaveLength(1);
    expect(out[0].legId).toBe(LEG_ID);
    expect(out[0].legTitle).toBe('Trondheim, Norway (rest day)');
    expect(out[0].fields).toEqual(['title', 'end_name', 'end_lat', 'end_lng']);
  });

  it('is quiet when the persisted row matches the edit', () => {
    const persisted: OverrideCheckLegRow = {
      id: LEG_ID,
      title: 'Trondheim → Campsite (Alset area)',
      startName: 'Trondheim, Norway',
      endName: 'Campsite, Alset, Norway',
      startLat: 63.43037,
      startLng: 10.39503,
      endLat: 63.6989632,
      endLng: 10.4189239,
    };
    expect(detectOverriddenLegEdits([campsiteEdit], [persisted])).toEqual([]);
  });

  it('tolerates sub-epsilon float drift in coords (~11m)', () => {
    const persisted: OverrideCheckLegRow = {
      id: LEG_ID,
      title: 'Trondheim → Campsite (Alset area)',
      startName: 'Trondheim, Norway',
      endName: 'Campsite, Alset, Norway',
      startLat: 63.43037,
      startLng: 10.39503,
      endLat: 63.69897, // rounded by the DB / re-route
      endLng: 10.41893,
    };
    expect(detectOverriddenLegEdits([campsiteEdit], [persisted])).toEqual([]);
  });

  it('only checks fields the edit actually set', () => {
    const notesOnly = {
      name: 'update_leg',
      input: { leg_id: LEG_ID, data: { notes: ['Laundry day'] } },
    };
    expect(detectOverriddenLegEdits([notesOnly], [revertedRow])).toEqual([]);
  });

  it('skips non-update_leg actions and unknown leg ids', () => {
    const addStop = { name: 'add_stop', input: { leg_id: LEG_ID, data: { name: 'X' } } };
    const unknownLeg = {
      ...campsiteEdit,
      input: { ...campsiteEdit.input, leg_id: '00000000-0000-0000-0000-0000000000ff' },
    };
    expect(detectOverriddenLegEdits([addStop, unknownLeg], [revertedRow])).toEqual([]);
  });

  it('summary names the persisted leg and the mismatched fields', () => {
    const out = detectOverriddenLegEdits([campsiteEdit], [revertedRow]);
    const s = overriddenEditsSummary(out);
    expect(s).toContain('Trondheim, Norway (rest day)');
    expect(s).toContain('end_name');
  });
});

describe('deriveApplyOutcome — overriddenEdits surfacing', () => {
  const base = {
    appliedCount: 1,
    failedCount: 0,
    persistFailedCount: 0,
    persistFailedActions: [],
    changes: { changes: [{}] },
  };

  it('renders a soft warning (not an error) when an applied edit was overridden', () => {
    const outcome = deriveApplyOutcome({
      ...base,
      overriddenEdits: [
        { legId: LEG_ID, legTitle: 'Trondheim, Norway (rest day)', fields: ['end_name'] },
      ],
    });
    expect(outcome.applyError).toBeNull();
    expect(outcome.partialApplyWarning).toContain('Trondheim, Norway (rest day)');
    expect(outcome.appliedChanges).toBe(true);
  });

  it('appends to an existing partial-save warning instead of replacing it', () => {
    const outcome = deriveApplyOutcome({
      ...base,
      appliedCount: 1,
      persistFailedCount: 1,
      persistFailedActions: [{ action: 'add_stop', error: 'boom' }],
      overriddenEdits: [{ legId: LEG_ID, legTitle: 'Day 4', fields: ['title'] }],
    });
    expect(outcome.partialApplyWarning).toContain("didn't save");
    expect(outcome.partialApplyWarning).toContain('Day 4');
  });

  it('is unchanged for legacy payloads without the field', () => {
    const outcome = deriveApplyOutcome(base);
    expect(outcome.partialApplyWarning).toBeNull();
    expect(outcome.applyError).toBeNull();
  });
});
