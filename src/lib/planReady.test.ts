import { describe, it, expect } from 'vitest';
import {
  LIST_VIEW_WORDS,
  PLAN_READY_FOLLOW_UP,
  PLAN_READY_HEADLINE,
  dailyPaceLine,
  planReadyBodyParagraphs,
  planReadyHeadlineParts,
  planReadyText,
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

  it('stores all three lines, blank line between', () => {
    expect(planReadyText(6, 8)).toBe(
      `${PLAN_READY_HEADLINE}\n\n${dailyPaceLine(6, 8)}\n\n${PLAN_READY_FOLLOW_UP}`,
    );
  });

  it('states no plan numbers — the summary card owns those', () => {
    /*
     * Same rule as <plan_summary_format>, and its reason is the whole of it: a
     * date, a day count or a distance here would be a SECOND, STALE source of
     * truth for a fact the card already renders correctly.
     *
     * The daily pace is the one number that is not that, which is why it was
     * added on 2026-09-11 and why the rule is now stated as what it always
     * meant rather than as "no digits". It is not derived from the plan — it is
     * the INPUT the plan was built from, sitting on the trip row, and it is
     * rendered nowhere else in the product. A driver reading "six days" had no
     * way to learn that six was arithmetic on a number they never saw.
     */
    const everything = [planReadyText(6, 8), planReadyText(null, 8)].join(' ');
    const withoutPace = everything
      .split(/\n{2,}/)
      .filter((p) => !p.includes('of driving'))
      .join(' ');
    expect(withoutPace).not.toMatch(/\d/);
  });

  describe('the daily pace line', () => {
    it('names the driver’s own answer as theirs', () => {
      expect(dailyPaceLine(5, 8)).toContain('5 h');
      expect(dailyPaceLine(5, 8)).toMatch(/asked for/);
    });

    it('says out loud when the number is OURS, not theirs', () => {
      // Presenting our default as the driver's choice is the small lie that
      // makes the rest of the numbers untrustworthy — and it is the common
      // case, since `trip_pace` is skipped whenever the opening message
      // already stated a pace and never runs at all on a seeded trip.
      const line = dailyPaceLine(null, 8);
      expect(line).toContain('8 h');
      expect(line).toMatch(/default/);
      expect(line).not.toMatch(/asked for/);
    });

    it('is a real sentence for every cap the validators allow', () => {
      for (let h = 1; h <= 8; h += 1) {
        expect(dailyPaceLine(h, 8)).toContain(`${h} h`);
      }
    });
  });

  describe('planReadyBodyParagraphs', () => {
    it('is everything after the headline, from the ROW', () => {
      // The clients render this rather than their own constant, so a row
      // written at one pace cannot be drawn at another.
      expect(planReadyBodyParagraphs(planReadyText(6, 8))).toEqual([
        dailyPaceLine(6, 8),
        PLAN_READY_FOLLOW_UP,
      ]);
    });

    it('renders a pre-pace row as exactly the one paragraph it holds', () => {
      // Rows written before 2026-09-11 have two paragraphs, not three. They
      // must keep reading correctly rather than growing a pace nobody stored.
      const old = `${PLAN_READY_HEADLINE}\n\n${PLAN_READY_FOLLOW_UP}`;
      expect(planReadyBodyParagraphs(old)).toEqual([PLAN_READY_FOLLOW_UP]);
    });
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
    const planReadyWrite = src.indexOf("'plan_ready',");
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
      // The BODY comes from the row, not from a client-side constant — the
      // pace paragraph is per-trip, so a client drawing its own copy would
      // show one number over a row that holds another.
      expect(src).toContain('planReadyBodyParagraphs(msg.content)');
      // The words themselves must appear in NEITHER client.
      expect(src).not.toContain('Trip is planned');
      expect(src).not.toContain('Come back to me if you want');
      expect(src).not.toContain('of driving');
    });

    it(`${label} ChatPanel makes the list view a control and inserts it idempotently`, () => {
      const src = read(path);
      expect(src).toContain('onOpenList');
      // A heal re-applies the same payload; two confirmations is worse than none.
      expect(src).toMatch(/some\(\(m\) => m\.kind === ["']plan_ready["']\)/);
    });
  }
});
