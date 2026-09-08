import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TAP_TO_ANSWER_KINDS,
  cityFromPlace,
  intentPlaceholder,
  isTapToAnswerKind,
  locksComposer,
} from './onboardingForm';

const root = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('tap-to-answer kinds', () => {
  it('select and chips are answered by tapping; nothing else is', () => {
    expect([...TAP_TO_ANSWER_KINDS]).toEqual(['select', 'chips']);
    expect(isTapToAnswerKind('select')).toBe(true);
    expect(isTapToAnswerKind('chips')).toBe(true);
    expect(isTapToAnswerKind('text')).toBe(false);
    expect(isTapToAnswerKind('vehicle')).toBe(false);
    expect(isTapToAnswerKind('handoff')).toBe(false);
  });

  it('chips keeps the composer live; select and vehicle lock it', () => {
    expect(locksComposer('chips')).toBe(false);
    expect(locksComposer('select')).toBe(true);
    expect(locksComposer('vehicle')).toBe(true);
  });

  /*
   * THE STRUCTURAL GUARD. The date step drew three chips that did nothing
   * because the renderer listed `select || chips` while the tap handler bailed
   * on `!== 'select'`. Both surfaces now read the shared predicate, on web and
   * on native — and this fails if either ever spells the list out again. A
   * kind that renders chips is a kind the handler accepts, by construction.
   */
  for (const [label, path] of [
    ['web', 'src/components/ChatPanel.tsx'],
    ['native', 'mobile/components/ChatPanel.tsx'],
  ] as const) {
    it(`${label} ChatPanel: the tap handler and the chip renderer read the same predicate`, () => {
      const src = read(path);
      const pick = src.slice(src.indexOf('submitOnboardingPick'), src.indexOf('submitOnboardingTextAnswer'));
      expect(pick).toContain('isTapToAnswerKind(q.kind)');
      expect(pick).not.toMatch(/kind !== ['"]select['"]/);
      // The renderer: chips are drawn for exactly the tappable kinds.
      expect(src).toContain('isTapToAnswerKind(onboardingQuestion.kind)');
      expect(src).not.toMatch(/kind === ['"]select['"] \|\|\s*onboardingQuestion\??\.kind === ['"]chips['"]/);
    });
  }
});

describe('location seeding', () => {
  it('takes the town out of a "town, country" label', () => {
    expect(cityFromPlace('Girona, Spain')).toBe('Girona');
    expect(cityFromPlace('Tromsø')).toBe('Tromsø');
    expect(cityFromPlace(null)).toBeNull();
    expect(cityFromPlace(' , Spain')).toBeNull();
  });

  it('seeds the first-message placeholder, and falls back to "Where to?"', () => {
    expect(intentPlaceholder('Girona')).toEqual({ city: 'Girona', rest: ' to …' });
    expect(intentPlaceholder(null)).toEqual({ city: null, rest: 'Where to?' });
  });
});

// ── Answered steps ─────────────────────────────────────────────────────────
//
// The transcript used to render an answered step as two flat bubbles — the
// question, then the text of the answer — because `chat_history` stored only
// `content` and the options existed solely on the live onboarding response.
// These three functions are how an answered step redraws itself as the widget
// it was. All three are shared, and the reason is the same one that put
// TAP_TO_ANSWER_KINDS here: the SERVER writes the meta, and each CLIENT builds
// the same meta optimistically before any reload, so three callers spell out
// one rule.

import {
  answeredChips,
  buildFormMeta,
  clientRecordsAnsweredStep,
  collapseOnboardingSteps,
  type AnsweredQuestionShape,
} from './onboardingForm';
import type { ChatFormMeta } from '@/types/trip';

const DATE_Q: AnsweredQuestionShape = {
  label: 'When are you setting off?',
  kind: 'chips',
  options: [
    { value: 'next Saturday', label: 'Next Saturday' },
    { value: 'in a month', label: 'In a month' },
    { value: 'not sure yet', label: 'Not sure yet' },
  ],
};

describe('buildFormMeta', () => {
  it('matches a tapped chip by its value', () => {
    const meta = buildFormMeta(DATE_Q, 'In a month', 'in a month');
    expect(meta.selected).toBe('in a month');
    expect(meta.question).toBe('When are you setting off?');
    expect(meta.options).toHaveLength(3);
  });

  it('matches by LABEL too — a chips step keeps the composer live, so the driver can type the chip', () => {
    const meta = buildFormMeta(DATE_Q, 'Next Saturday', 'Next Saturday');
    expect(meta.selected).toBe('next Saturday');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(buildFormMeta(DATE_Q, '  NOT SURE YET ', '  NOT SURE YET ').selected).toBe(
      'not sure yet'
    );
  });

  it('leaves selected null for an answer no chip expresses', () => {
    // The real reported case: a date picked from the calendar sheet.
    const meta = buildFormMeta(DATE_Q, 'Thu 8 Oct', '2026-10-08');
    expect(meta.selected).toBeNull();
    expect(meta.answerLabel).toBe('Thu 8 Oct');
  });

  it('resolves a display label that is not itself an option', () => {
    // trip_pace stores hours but shows "8 h a day", which matches no chip
    // label — the submitted value is what identifies the chip.
    const pace: AnsweredQuestionShape = {
      label: 'How long do you want to drive each day?',
      kind: 'chips',
      options: [
        { value: '4', label: '4 h' },
        { value: '6', label: '6 h' },
        { value: '8', label: '8 h' },
      ],
    };
    expect(buildFormMeta(pace, '8 h a day', 8).selected).toBe('8');
  });

  it('the SUBMITTED VALUE wins when it and the label point at different options', () => {
    /*
     * Deliberately crossed, because the precedence is a rule and a rule with
     * no test is a comment. Nothing in the app ships options shaped like this
     * — which is exactly why the earlier version of this test proved nothing:
     * on every real question the value and the label resolve to the same chip,
     * so reversing the precedence left it green. What the driver ACTUALLY did
     * is submit a value; the label is how it was rendered afterwards.
     */
    const crossed: AnsweredQuestionShape = {
      label: 'q',
      kind: 'chips',
      options: [
        { value: 'alpha', label: 'beta' },
        { value: 'beta', label: 'alpha' },
      ],
    };
    expect(buildFormMeta(crossed, 'alpha', 'beta').selected).toBe('beta');
  });

  it('records a step that offered no options at all', () => {
    const meta = buildFormMeta({ label: 'Where are we going?', kind: 'handoff' }, 'Austin', 'Austin');
    expect(meta.options).toEqual([]);
    expect(meta.selected).toBeNull();
  });
});

describe('answeredChips', () => {
  const meta = (over: Partial<ChatFormMeta>): ChatFormMeta => ({
    question: 'q',
    kind: 'chips',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    selected: null,
    answerLabel: '',
    ...over,
  });

  it('lights exactly the chosen chip', () => {
    const chips = answeredChips(meta({ selected: 'b', answerLabel: 'B' }));
    expect(chips.map((c) => c.selected)).toEqual([false, true]);
    expect(chips).toHaveLength(2);
  });

  it('appends a typed answer as its own lit chip', () => {
    const chips = answeredChips(meta({ selected: null, answerLabel: 'Thu 8 Oct' }));
    expect(chips).toHaveLength(3);
    expect(chips[2]).toMatchObject({ label: 'Thu 8 Oct', selected: true });
    expect(chips.filter((c) => c.selected)).toHaveLength(1);
  });

  it('never lights two chips', () => {
    const chips = answeredChips(meta({ selected: 'a', answerLabel: 'A' }));
    expect(chips.filter((c) => c.selected)).toHaveLength(1);
  });

  it('adds nothing for an empty answer on an unmatched step', () => {
    expect(answeredChips(meta({ selected: null, answerLabel: '   ' }))).toHaveLength(2);
  });
});

describe('clientRecordsAnsweredStep', () => {
  it('lets the server own the composite vehicle card', () => {
    // One client answer ("Duncan · 500 km") over TWO server steps. A
    // client-built widget would show range chips under that pill and then turn
    // into two different steps on reload.
    expect(clientRecordsAnsweredStep('vehicle')).toBe(false);
  });

  it('records every other kind', () => {
    for (const k of ['text', 'number', 'integer', 'select', 'chips', 'handoff'] as const) {
      expect(clientRecordsAnsweredStep(k)).toBe(true);
    }
  });
});

describe('collapseOnboardingSteps', () => {
  type Row = { id: string; kind: string; content: string; form_meta?: ChatFormMeta | null };
  const q = (id: string, content: string): Row => ({ id, kind: 'form_question', content });
  /** An answered step. Carries options, because a step with none is deliberately
   *  NOT collapsed — see the "offered NO options" case below. */
  const a = (id: string, question: string, answerLabel: string): Row => ({
    id,
    kind: 'form_answer',
    content: answerLabel,
    form_meta: {
      question,
      kind: 'chips',
      options: [{ value: 'x', label: 'X' }],
      selected: null,
      answerLabel,
    },
  });

  it('drops the question row its answer row carries', () => {
    const out = collapseOnboardingSteps([q('q1', 'When?'), a('a1', 'When?', 'Thu 8 Oct')]);
    expect(out.map((r) => r.id)).toEqual(['a1']);
  });

  it('keeps everything else in place, in order', () => {
    const rows: Row[] = [
      q('q1', 'When?'),
      a('a1', 'When?', 'Thu 8 Oct'),
      { id: 'ack', kind: 'ai', content: 'Great — Thu 8 Oct it is.' },
      q('q2', 'How long?'),
      a('a2', 'How long?', '8 h a day'),
    ];
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['a1', 'ack', 'a2']);
  });

  it('leaves an UNANSWERED question standing — that is the live step', () => {
    const rows: Row[] = [q('q1', 'When?'), a('a1', 'When?', 'Thu 8 Oct'), q('q2', 'How long?')];
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['a1', 'q2']);
  });

  it('pairs each answer with its own question when a label repeats', () => {
    // A range_help detour returns to a question already asked once.
    const rows: Row[] = [
      q('q1', 'How far on a tank?'),
      a('a1', 'How far on a tank?', 'no idea'),
      q('q2', 'How far on a tank?'),
      a('a2', 'How far on a tank?', '500 km'),
    ];
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('claims the NEAREST earlier question, not the first one that matches', () => {
    /*
     * The distinguishing case, and the only one there is: MORE earlier
     * questions carrying a label than there are answers for it. With one
     * answer and two questions the two search directions drop different rows,
     * and every other arrangement they agree on — which is why searching
     * forward passed the test above.
     *
     * Nearest is right because the row that stands in for the step must be the
     * question the driver was actually looking at when they answered. Dropping
     * the older one leaves the STALE question bubble on screen above the
     * widget, and the widget itself standing where it never was.
     */
    const rows: Row[] = [q('older', 'When?'), q('shown', 'When?'), a('a1', 'When?', 'Thu 8 Oct')];
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['older', 'a1']);
  });

  it('never claims one question row for two answers', () => {
    const rows: Row[] = [q('q1', 'When?'), a('a1', 'When?', 'x'), a('a2', 'When?', 'y')];
    // a2 finds no unclaimed question of its own, so nothing extra is dropped.
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('never drops a question that comes AFTER its answer', () => {
    const rows: Row[] = [a('a1', 'When?', 'x'), q('q1', 'When?')];
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['a1', 'q1']);
  });

  it('leaves a step that offered NO options as two plain bubbles', () => {
    /*
     * The opening trip description is free text. Collapsed, it renders as one
     * enormous pill under its own question — worse than the question-then-
     * answer bubbles it replaced, and there is no widget to redraw anyway.
     */
    const rows: Row[] = [
      q('q1', 'Where are we going?'),
      {
        id: 'a1',
        kind: 'form_answer',
        content: 'I want to see all the national parks in the American west',
        form_meta: {
          question: 'Where are we going?',
          kind: 'handoff',
          options: [],
          selected: null,
          answerLabel: 'I want to see all the national parks in the American west',
        },
      },
    ];
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['q1', 'a1']);
  });

  it('leaves pre-migration rows exactly as they are', () => {
    // Every row written before form_meta existed has none. An old trip must
    // keep rendering as the two plain bubbles it always did.
    const rows: Row[] = [
      q('q1', 'When?'),
      { id: 'a1', kind: 'form_answer', content: 'Thu 8 Oct', form_meta: null },
    ];
    expect(collapseOnboardingSteps(rows)).toBe(rows);
    expect(collapseOnboardingSteps(rows).map((r) => r.id)).toEqual(['q1', 'a1']);
  });
});

/*
 * THE SAME STRUCTURAL GUARD, one row further down. The answered step is drawn
 * by two renderers that cannot share markup — a `<span>` with inline styles and
 * a `<View>` with a StyleSheet — so what has to be shared is the DECISION: fold
 * the pair of rows into one, and light exactly one chip. If either ChatPanel
 * starts working that out for itself, the two will disagree about which chip is
 * lit for a typed answer, and only on one platform.
 */
describe('answered steps are drawn from the shared decision, on both platforms', () => {
  for (const [label, path] of [
    ['web', 'src/components/ChatPanel.tsx'],
    ['native', 'mobile/components/ChatPanel.tsx'],
  ] as const) {
    it(`${label} ChatPanel collapses the pair and renders the shared chips`, () => {
      const src = read(path);
      expect(src).toContain('collapseOnboardingSteps(');
      expect(src).toContain('answeredChips(');
      // The transcript is built from the COLLAPSED rows — building it from the
      // raw ones leaves the question bubble sitting above its own widget.
      expect(src).toMatch(/buildTranscript\(\s*collapseOnboardingSteps\(/);
      // And the optimistic row carries the same meta the server persists, so
      // the step does not change shape on reload.
      // Renamed via the client-side wrapper that skips the composite vehicle
      // card (`clientRecordsAnsweredStep`) — the point is unchanged: the
      // optimistic row carries the same meta the server persists.
      expect(src).toContain('answeredStepMeta(askedQuestion');
      expect(src).toContain('clientRecordsAnsweredStep(');
    });
  }

  it('the answered chips are inert — a record, not a control', () => {
    // Web: a <span>, never a <button>. Native: a <View>, never a Pressable.
    // An answered step that could be tapped would submit an answer to a
    // question that has already advanced.
    const web = read('src/components/ChatPanel.tsx');
    const webBlock = web.slice(
      web.indexOf("if (msg.kind === 'form_answer' && msg.form_meta)"),
      web.indexOf("const isQueued = msg.deliveryStatus === 'queued';")
    );
    expect(webBlock.length).toBeGreaterThan(0);
    expect(webBlock).not.toContain('<button');
    expect(webBlock).not.toContain('onClick');

    const native = read('mobile/components/ChatPanel.tsx');
    const nativeBlock = native.slice(
      native.indexOf('if (msg.kind === "form_answer" && msg.form_meta)'),
      native.indexOf('const isUser = msg.role === "user";')
    );
    expect(nativeBlock.length).toBeGreaterThan(0);
    expect(nativeBlock).not.toContain('<Pressable');
    expect(nativeBlock).not.toContain('onPress');
  });
});
