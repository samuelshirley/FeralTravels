import { describe, it, expect } from 'vitest';
import { deriveApplyOutcome } from './applyOutcome';

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
