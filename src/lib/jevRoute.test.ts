import { describe, expect, it } from 'vitest';

import {
  compareRowTruth,
  countToolNames,
  JEV_ROUTE_CRITERIA,
  JEV_ROUTE_INSTRUCTIONS,
  JEV_ROUTES,
  turnRouteTruth,
  type TurnFacts,
} from './jevRoute';

/**
 * The definition of "Jev's route was right", one route at a time. Each case is
 * a turn shape Penny really produces; the comment says why it grades the way
 * it does. If a definition changes, these change with it, on purpose.
 */

const clean: TurnFacts = {
  status: 'done',
  toolCounts: {},
  appliedCounts: {},
  failedCount: 0,
  fuelPlanRan: false,
  fuelStopUpdates: 0,
  fuelStopDeletes: 0,
  otherStopEdits: 0,
  mapsLinkCount: 0,
};
const turn = (patch: Partial<TurnFacts>): TurnFacts => ({ ...clean, ...patch });

describe('add_pasted_place: a Maps link, and the turn only resolved/added that place', () => {
  it('link + add_stop, nothing else → add_pasted_place', () => {
    expect(turnRouteTruth(turn({ mapsLinkCount: 1, toolCounts: { add_stop: 1 }, appliedCounts: { add_stop: 1 } }))).toBe(
      'add_pasted_place',
    );
  });

  it('reads (resolve_place, get_route) along the way do not change it — code makes its own', () => {
    expect(
      turnRouteTruth(
        turn({
          mapsLinkCount: 1,
          toolCounts: { resolve_place: 1, get_route: 2, add_stop: 1 },
          appliedCounts: { add_stop: 1 },
        }),
      ),
    ).toBe('add_pasted_place');
  });

  it('two links, two stops → still add_pasted_place; three stops for two links is not', () => {
    expect(turnRouteTruth(turn({ mapsLinkCount: 2, toolCounts: { add_stop: 2 }, appliedCounts: { add_stop: 2 } }))).toBe(
      'add_pasted_place',
    );
    expect(turnRouteTruth(turn({ mapsLinkCount: 2, toolCounts: { add_stop: 3 }, appliedCounts: { add_stop: 3 } }))).toBe(
      'needs_penny',
    );
  });

  it('no link in the message → not add_pasted_place, even if a stop was added', () => {
    expect(turnRouteTruth(turn({ mapsLinkCount: 0, toolCounts: { add_stop: 1 }, appliedCounts: { add_stop: 1 } }))).toBe(
      'needs_penny',
    );
  });

  it('a link but the turn also moved a leg → needs_penny', () => {
    expect(
      turnRouteTruth(
        turn({
          mapsLinkCount: 1,
          toolCounts: { add_stop: 1, update_leg: 1 },
          appliedCounts: { add_stop: 1, update_leg: 1 },
        }),
      ),
    ).toBe('needs_penny');
  });

  it('a link but Penny only asked a question (no stop added) → needs_penny', () => {
    expect(turnRouteTruth(turn({ mapsLinkCount: 1, toolCounts: { resolve_place: 1 } }))).toBe('needs_penny');
  });

  it('the add_stop failed to persist → needs_penny (a clean turn is part of the definition)', () => {
    expect(
      turnRouteTruth(turn({ mapsLinkCount: 1, toolCounts: { add_stop: 1 }, appliedCounts: {}, failedCount: 1 })),
    ).toBe('needs_penny');
  });
});

describe('replace_fuel_stop: the turn only touched fuel stops', () => {
  it('Finn re-ran (plan_fuel_stops), nothing else → replace_fuel_stop', () => {
    expect(turnRouteTruth(turn({ toolCounts: { plan_fuel_stops: 1 }, fuelPlanRan: true }))).toBe('replace_fuel_stop');
  });

  it('a fuel stop updated to another station (resolve_place + update_stop on fuel) → replace_fuel_stop', () => {
    expect(
      turnRouteTruth(
        turn({
          toolCounts: { resolve_place: 1, update_stop: 1 },
          appliedCounts: { update_stop: 1 },
          fuelStopUpdates: 1,
        }),
      ),
    ).toBe('replace_fuel_stop');
  });

  it('delete a fuel stop and re-run Finn → replace_fuel_stop', () => {
    expect(
      turnRouteTruth(
        turn({
          toolCounts: { delete_stop: 1, plan_fuel_stops: 1 },
          appliedCounts: { delete_stop: 1 },
          fuelStopDeletes: 1,
          fuelPlanRan: true,
        }),
      ),
    ).toBe('replace_fuel_stop');
  });

  it('deleting a fuel stop with no replacement is NOT a replacement', () => {
    expect(
      turnRouteTruth(turn({ toolCounts: { delete_stop: 1 }, appliedCounts: { delete_stop: 1 }, fuelStopDeletes: 1 })),
    ).toBe('needs_penny');
  });

  it('plan_fuel_stops called but Finn did not run (leg not saved yet) → needs_penny', () => {
    expect(turnRouteTruth(turn({ toolCounts: { plan_fuel_stops: 1 }, fuelPlanRan: false }))).toBe('needs_penny');
  });

  it('a stop edit landed on a non-fuel stop → needs_penny', () => {
    expect(
      turnRouteTruth(
        turn({
          toolCounts: { update_stop: 2, plan_fuel_stops: 1 },
          appliedCounts: { update_stop: 2 },
          fuelStopUpdates: 1,
          otherStopEdits: 1,
          fuelPlanRan: true,
        }),
      ),
    ).toBe('needs_penny');
  });

  it('a fuel change plus a leg change → needs_penny', () => {
    expect(
      turnRouteTruth(
        turn({
          toolCounts: { plan_fuel_stops: 1, update_leg: 1 },
          appliedCounts: { update_leg: 1 },
          fuelPlanRan: true,
        }),
      ),
    ).toBe('needs_penny');
  });

  it('declare_fuel_state (the tank level) is not replacing a stop → needs_penny', () => {
    expect(turnRouteTruth(turn({ toolCounts: { declare_fuel_state: 1, plan_fuel_stops: 1 }, fuelPlanRan: true }))).toBe(
      'needs_penny',
    );
  });
});

describe('needs_penny and the ungraded', () => {
  it('a text-only reply (no tool) → needs_penny: Penny answered something', () => {
    expect(turnRouteTruth(turn({}))).toBe('needs_penny');
  });

  it('a full plan → needs_penny', () => {
    expect(
      turnRouteTruth(
        turn({
          toolCounts: { extract_trip_intent: 1, get_route: 3, check_trip_feasibility: 1, add_leg: 3 },
          appliedCounts: { add_leg: 3 },
        }),
      ),
    ).toBe('needs_penny');
  });

  it('a turn that ERRORED has no truth: it is left out, never guessed', () => {
    expect(turnRouteTruth(turn({ status: 'error', mapsLinkCount: 1 }))).toBeNull();
  });
});

describe('a compare row’s truth', () => {
  it('Haiku refusing (T2/T3) on the classifier path is off_topic', () => {
    expect(compareRowTruth({ tierAsked: true, haikuTier: 'T2', turnTruth: null })).toBe('off_topic');
    expect(compareRowTruth({ tierAsked: true, haikuTier: 'T3', turnTruth: null })).toBe('off_topic');
  });

  it('a Haiku T1, or a message the free rules let through, takes its turn’s truth', () => {
    expect(compareRowTruth({ tierAsked: true, haikuTier: 'T1', turnTruth: 'add_pasted_place' })).toBe('add_pasted_place');
    expect(compareRowTruth({ tierAsked: false, haikuTier: null, turnTruth: 'replace_fuel_stop' })).toBe(
      'replace_fuel_stop',
    );
    expect(compareRowTruth({ tierAsked: true, haikuTier: 'T1', turnTruth: null })).toBeNull();
  });
});

describe('the question', () => {
  it('offers exactly the four routes, each with one short criterion', () => {
    expect(Object.keys(JEV_ROUTE_CRITERIA)).toEqual([...JEV_ROUTES]);
    for (const text of Object.values(JEV_ROUTE_CRITERIA)) expect(text.length).toBeLessThanOrEqual(90);
    expect(JEV_ROUTE_INSTRUCTIONS.length).toBeLessThanOrEqual(60);
  });

  it('counts tool names across model calls', () => {
    expect(countToolNames([['resolve_place', 'get_route'], ['add_stop'], []])).toEqual({
      resolve_place: 1,
      get_route: 1,
      add_stop: 1,
    });
  });
});
