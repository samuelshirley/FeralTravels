import { describe, expect, it } from 'vitest';
import { rejectTurnBeforeDispatch, CONTIGUITY_REASON } from './turnAtomicity';
import type { ValidatedAction } from './tools';

const del = (id: string) => ({ name: 'delete_leg', input: { leg_id: id } }) as ValidatedAction;
const add = () => ({ name: 'add_leg', input: { title: 'x' } }) as ValidatedAction;
const task = () => ({ name: 'add_task', input: { title: 't' } }) as unknown as ValidatedAction;
const idea = () => ({ name: 'submit_idea', input: { idea: 'i' } }) as unknown as ValidatedAction;

const none = new Set<string>();

describe('rejectTurnBeforeDispatch', () => {
  it('lets a batch through when no gate objects', () => {
    expect(
      rejectTurnBeforeDispatch({
        actions: [del('a'), add(), task()],
        blockedDeleteLegIds: none,
        feasibilityBlocks: false,
        feasibilityVerdict: null,
      }),
    ).toBeNull();
  });

  it('one blocked delete rejects EVERY action in the batch, not just the delete', () => {
    const r = rejectTurnBeforeDispatch({
      actions: [del('a'), del('b'), add(), add(), task()],
      blockedDeleteLegIds: new Set(['a']),
      feasibilityBlocks: false,
      feasibilityVerdict: null,
    });
    expect(r?.reason).toBe(CONTIGUITY_REASON);
    expect(r?.rows.map((x) => x.action)).toEqual(['delete_leg', 'delete_leg', 'add_leg', 'add_leg', 'add_task']);
    expect(r?.rows.every((x) => x.error.includes('Nothing from this edit was saved') || x.error.includes('nothing from this edit was saved'))).toBe(true);
    expect(r?.blockedDeleteLegIds).toEqual(['a']);
  });

  it('an over-budget plan rejects its deletes as well as its adds', () => {
    const r = rejectTurnBeforeDispatch({
      actions: [del('a'), add()],
      blockedDeleteLegIds: none,
      feasibilityBlocks: true,
      feasibilityVerdict: 'over_budget',
    });
    expect(r?.reason).toBe('the plan exceeds your time budget');
    expect(r?.rows.map((x) => x.action)).toEqual(['delete_leg', 'add_leg']);
  });

  it('the feasibility gate only concerns batches that add legs (as before)', () => {
    expect(
      rejectTurnBeforeDispatch({
        actions: [del('a'), task()],
        blockedDeleteLegIds: none,
        feasibilityBlocks: true,
        feasibilityVerdict: null,
      }),
    ).toBeNull();
  });

  it('holds back submit_idea with the rest but lists it in no banner', () => {
    const r = rejectTurnBeforeDispatch({
      actions: [del('a'), idea()],
      blockedDeleteLegIds: new Set(['a']),
      feasibilityBlocks: false,
      feasibilityVerdict: null,
    });
    expect(r?.rows.map((x) => x.action)).toEqual(['delete_leg']);
  });
});
