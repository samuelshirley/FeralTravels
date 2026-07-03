import { describe, it, expect } from 'vitest';
import { countQueuedMutations, deriveApplyOutcome } from './applyOutcome';

describe('countQueuedMutations', () => {
  it('excludes submit_idea, keeps real mutations', () => {
    expect(countQueuedMutations([])).toBe(0);
    expect(countQueuedMutations([{ name: 'submit_idea' }])).toBe(0);
    expect(
      countQueuedMutations([
        { name: 'submit_idea' },
        { name: 'add_stop' },
        { name: 'update_leg' },
      ])
    ).toBe(2);
  });
});

describe('deriveApplyOutcome', () => {
  it('clean success: changes applied, no errors', () => {
    const r = deriveApplyOutcome({
      appliedCount: 3,
      failedCount: 0,
      changes: { changes: [{}, {}, {}] },
    });
    expect(r.applyError).toBeNull();
    expect(r.partialApplyWarning).toBeNull();
    expect(r.appliedChanges).toBe(true);
  });

  it('partial: some applied, some persist-failed → warning, not hard error', () => {
    const r = deriveApplyOutcome({
      appliedCount: 2,
      failedCount: 1,
      persistFailedCount: 1,
      persistFailedActions: [{ action: 'add_leg', error: 'boom' }],
      changes: { changes: [{}, {}] },
    });
    expect(r.applyError).toBeNull();
    expect(r.partialApplyWarning).toContain('add_leg');
    expect(r.appliedChanges).toBe(true);
  });

  it('total persist failure: nothing applied → hard error with detail', () => {
    const r = deriveApplyOutcome({
      appliedCount: 0,
      failedCount: 1,
      persistFailedCount: 1,
      persistFailedActions: [{ action: 'add_stop', error: 'no leg' }],
      changes: { changes: [] },
      validatedQueuedCount: 1,
    });
    expect(r.applyError).toContain('Changes failed to save');
    expect(r.applyError).toContain('add_stop');
    expect(r.appliedChanges).toBe(false);
  });

  it('proposed but nothing saved (no persist info) → "nothing was saved" nudge', () => {
    const r = deriveApplyOutcome({
      appliedCount: 0,
      failedCount: 0,
      validatedQueuedCount: 2,
      changes: { changes: [] },
    });
    expect(r.applyError).toContain('nothing was saved');
    expect(r.appliedChanges).toBe(false);
  });

  it('legacy payload (no persist* fields) falls back to failed* counts', () => {
    const r = deriveApplyOutcome({
      appliedCount: 0,
      failedCount: 2,
      failedActions: [
        { action: 'update_leg', error: 'x' },
        { action: 'add_stop', error: 'y' },
      ],
      changes: { changes: [] },
      validatedQueuedCount: 2,
    });
    // persistFailedCount falls back to failedCount (2) → hard error path
    expect(r.applyError).toContain('Changes failed to save');
    expect(r.applyError).toContain('update_leg');
  });

  it('submit_idea-only turn → no false "nothing was saved" banner', () => {
    // The real bug: submit_idea was never counted as applied but WAS counted
    // as queued, so a turn whose only action was submit_idea rendered the red
    // error banner even though the idea logged fine. With countQueuedMutations
    // the server reports validatedQueuedCount=0 → clean outcome.
    const r = deriveApplyOutcome({
      appliedCount: 0,
      failedCount: 0,
      validatedQueuedCount: countQueuedMutations([{ name: 'submit_idea' }]),
      changes: { changes: [] },
    });
    expect(r.applyError).toBeNull();
    expect(r.partialApplyWarning).toBeNull();
    expect(r.appliedChanges).toBe(false);
  });

  it('pure chat reply (no changes) → no error, no reload', () => {
    const r = deriveApplyOutcome({
      appliedCount: 0,
      failedCount: 0,
      changes: { changes: [] },
    });
    expect(r.applyError).toBeNull();
    expect(r.partialApplyWarning).toBeNull();
    expect(r.appliedChanges).toBe(false);
  });
});
