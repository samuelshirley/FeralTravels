import { describe, it, expect } from 'vitest';
import {
  LIST_VIEW_WORDS,
  PLAN_READY_FOLLOW_UP,
  PLAN_READY_HEADLINE,
  PLAN_READY_TEXT,
  planReadyHeadlineParts,
} from './planReady';

describe('plan-ready copy', () => {
  it('names the list view exactly once, so the tappable split is unambiguous', () => {
    const hits = PLAN_READY_HEADLINE.split(LIST_VIEW_WORDS).length - 1;
    expect(hits).toBe(1);
  });

  it('rebuilds the headline from its parts', () => {
    const { before, link, after } = planReadyHeadlineParts();
    expect(before + link + after).toBe(PLAN_READY_HEADLINE);
    expect(link).toBe(LIST_VIEW_WORDS);
  });

  it('stores both lines, blank line between', () => {
    expect(PLAN_READY_TEXT).toBe(`${PLAN_READY_HEADLINE}\n\n${PLAN_READY_FOLLOW_UP}`);
  });

  it('states no plan numbers — the summary card owns those', () => {
    // Same rule as <plan_summary_format>: a date, a day count or a distance in
    // this copy would be a second, stale source of truth for facts the card
    // already renders correctly.
    expect(PLAN_READY_TEXT).not.toMatch(/\d/);
  });

  it('tells the driver the one thing they cannot see: how to change a destination', () => {
    expect(PLAN_READY_FOLLOW_UP).toMatch(/Google Maps link/);
  });
});

/*
 * STRUCTURAL GUARDS. The plan-ready bubble is three files agreeing: the server
 * writes the row, and two renderers draw it. What can rot is the agreement —
 * a reworded sentence that no longer contains the tappable phrase, a client
 * that hard-codes the copy, or the row escaping the one turn it belongs on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('the plan-ready row is written on exactly one turn', () => {
  const route = () => read('src/app/api/trip/replan/route.ts');

  it('only on the handoff turn, and only when something was saved', () => {
    // "Trip is planned" over an itinerary nothing was written to is the
    // dishonest-transcript failure this repo has already shipped once.
    expect(route()).toMatch(/const planReady = isHandoff && appliedCount > 0;/);
  });

  it('is written BEFORE Penny’s reply, so it takes the lower seq', () => {
    const src = route();
    const planReadyWrite = src.indexOf("PLAN_READY_TEXT, null, 'plan_ready'");
    const replyWrite = src.indexOf('persistedResponse,\n            assistantChangesMade,');
    expect(planReadyWrite).toBeGreaterThan(-1);
    expect(replyWrite).toBeGreaterThan(-1);
    expect(planReadyWrite).toBeLessThan(replyWrite);
  });

  it('tells the live client to splice the same bubble into the same place', () => {
    // Without this the bubble appears only after a reload, so the driver who
    // waited through the whole build is the one person who never sees it.
    expect(route()).toContain('planReady,');
  });
});

describe('both clients draw the shared copy', () => {
  for (const [label, path] of [
    ['web', 'src/components/ChatPanel.tsx'],
    ['native', 'mobile/components/ChatPanel.tsx'],
  ] as const) {
    it(`${label} ChatPanel renders it from planReady.ts, not from its own strings`, () => {
      const src = read(path);
      expect(src).toContain('planReadyHeadlineParts()');
      expect(src).toContain('PLAN_READY_FOLLOW_UP');
      // The words themselves must appear in NEITHER client.
      expect(src).not.toContain('Trip is planned');
      expect(src).not.toContain('Come back to me if you want');
    });

    it(`${label} ChatPanel makes the list view a control and inserts it idempotently`, () => {
      const src = read(path);
      expect(src).toContain('onOpenList');
      // A heal re-applies the same payload; two confirmations is worse than none.
      expect(src).toMatch(/some\(\(m\) => m\.kind === ["']plan_ready["']\)/);
    });
  }
});
