/**
 * Both ChatPanels offer the onboarding date step's `Pick a date` calendar, and
 * both calendars take their date maths from ONE module.
 *
 * Until 2026-09-22 only the web drew it: native showed the three chips and
 * nothing else, so on iOS the only way to a real calendar day was typing one.
 * `mobile/` has no unit test runner, so — like `onboardingPhaseGuard.test.ts` —
 * this reads both sources, comments stripped, and holds them to one shape:
 *
 *   - the `onboarding-pick-date` chip renders inside the tap-to-answer chips
 *     block, gated on the `trip_date` key — so the `kind: 'text'` "not sure
 *     yet" follow-up, which has no options, gets no calendar on either platform;
 *   - the calendar sits inline in that block (not a Modal), shuts when the
 *     question changes, and submits the picked day through the ordinary
 *     onboarding answer path;
 *   - neither platform reaches for an OS date picker (`<input type="date">`,
 *     `showPicker()`, `DateTimePicker`), which the theme cannot style and
 *     neither e2e driver can see;
 *   - both calendars import the grid from `calendarGrid`, and nobody keeps a
 *     private month grid — two implementations of "which day is this" are how
 *     one platform ends up a day off.
 *
 * Mutation-checked; what was reintroduced and what went red is in
 * docs/decisions.md under H19.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

/** Source with comments removed, so a comment naming the old picker is not a match. */
function code(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PANELS = [
  { rel: 'src/components/ChatPanel.tsx', submit: 'submitOnboardingPost' },
  { rel: 'mobile/components/ChatPanel.tsx', submit: 'submitOnboardingAnswer' },
];

const CALENDARS = [
  { rel: 'src/components/CalendarPopover.tsx', shared: '@/lib/calendarGrid' },
  { rel: 'mobile/components/CalendarPopover.tsx', shared: '@/shared/lib/calendarGrid' },
];

/**
 * The tap-to-answer chips block: from its `isTapToAnswerKind(...) && options`
 * gate to the vehicle card that follows it.
 */
function tapToAnswerBlock(src: string, rel: string): string {
  const open = src.search(/\{isTapToAnswerKind\(onboardingQuestion\.kind\) && onboardingQuestion\.options/);
  expect(open, `${rel}: the tap-to-answer chips block is gone — update this guard`).toBeGreaterThan(-1);
  const close = src.search(/\{onboardingQuestion\.kind === ["']vehicle["']/);
  expect(close, `${rel}: the vehicle card no longer follows the chips block`).toBeGreaterThan(open);
  return src.slice(open, close);
}

/** Every way to open the OS's own date picker instead of drawing one. */
const OS_PICKERS: [RegExp, string][] = [
  [/type=\{?["']date["']\}?/, '<input type="date">'],
  [/showPicker/, 'showPicker()'],
  [/DateTimePicker/, 'DateTimePicker'],
  [/datetimepicker/i, '@react-native-community/datetimepicker'],
  [/DatePickerIOS/, 'DatePickerIOS'],
];

/** Date maths a calendar must take from the shared module, not define. */
const PRIVATE_MATHS: [RegExp, string][] = [
  [/function monthGrid\b|(const|let|var) monthGrid\b/, 'its own monthGrid'],
  [/getDay\(\)\s*\+\s*6/, 'Monday-first `getDay() + 6` arithmetic'],
  [/function toIso\b|(const|let|var) toIso\b/, 'its own toIso'],
  [/toISOString\(\)/, 'toISOString(), which is UTC'],
  [/Intl\.DateTimeFormat/, 'its own date formatting'],
];

describe.each(PANELS)('$rel', ({ rel, submit }) => {
  const src = code(rel);
  const block = tapToAnswerBlock(src, rel);

  it('renders the Pick a date chip inside the tap-to-answer block, gated on trip_date', () => {
    const at = block.search(/(data-testid|testID)=["']onboarding-pick-date["']/);
    expect(at, `${rel}: no onboarding-pick-date chip in the tap-to-answer block`).toBeGreaterThan(-1);
    const gate = block.lastIndexOf('onboardingQuestion.key === ', at);
    expect(gate, `${rel}: the Pick a date chip is not gated on a question key`).toBeGreaterThan(-1);
    expect(block.slice(gate, gate + 40), `${rel}: the Pick a date chip is not gated on trip_date`).toMatch(
      /^onboardingQuestion\.key === ["']trip_date["']/,
    );
    expect(block.slice(gate, at), `${rel}: the chip is not disabled while onboarding is busy`).toMatch(
      /disabled=\{onboardingComposerBusy\}/,
    );
  });

  it('draws the calendar inline in that block, on trip_date, while open', () => {
    expect(block, `${rel}: CalendarPopover is not rendered in the tap-to-answer block`).toMatch(
      /onboardingQuestion\.key === ["']trip_date["'] && datePickerOpen (&&|\?) \(?\s*(<View[^>]*>\s*)?<CalendarPopover/,
    );
    expect(src, `${rel}: the calendar must not float in a Modal`).not.toMatch(/<Modal[\s\S]{0,400}<CalendarPopover/);
  });

  it('submits the picked day through the ordinary onboarding answer path, and closes', () => {
    const pick = block.match(/onPick=\{\(iso\) => \{([\s\S]*?)\}\}/);
    expect(pick, `${rel}: CalendarPopover has no onPick handler`).not.toBeNull();
    const body = (pick as RegExpMatchArray)[1];
    expect(body, `${rel}: picking a day does not close the calendar`).toMatch(/setDatePickerOpen\(false\)/);
    expect(body, `${rel}: the picked day does not go through ${submit}`).toMatch(
      new RegExp(`${submit}\\(onboardingQuestion\\.key, iso\\)`),
    );
  });

  it('starts every new question with the calendar shut', () => {
    expect(src).toMatch(/const activeQuestionLabel = onboardingQuestion\?\.label;/);
    expect(src).toMatch(/useEffect\(\(\) => setDatePickerOpen\(false\), \[activeQuestionLabel\]\);/);
  });

  it('uses the drawn calendar, not an OS date picker, and keeps no month grid', () => {
    expect(src).toMatch(/import CalendarPopover from ["']@\/components\/CalendarPopover["']/);
    for (const [re, name] of OS_PICKERS) {
      expect(src, `${rel} reaches for ${name}`).not.toMatch(re);
    }
    for (const [re, name] of PRIVATE_MATHS.slice(0, 2)) {
      expect(src, `${rel} defines ${name}`).not.toMatch(re);
    }
  });
});

describe.each(CALENDARS)('$rel', ({ rel, shared }) => {
  const src = code(rel);

  it('imports the grid, the local day and the labels from the shared module', () => {
    const escaped = shared.replace(/[/.]/g, '\\$&');
    const imp = src.match(new RegExp(`import \\{([^}]*)\\} from ["']${escaped}["']`));
    expect(imp, `${rel} does not import from ${shared}`).not.toBeNull();
    const names = (imp as RegExpMatchArray)[1];
    for (const name of ['monthGrid', 'localIso', 'monthTitle', 'dayLabel', 'stepMonth']) {
      expect(names, `${rel} does not take ${name} from ${shared}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('keeps no date maths of its own', () => {
    for (const [re, name] of PRIVATE_MATHS) {
      expect(src, `${rel} re-implements the calendar's date maths: ${name}`).not.toMatch(re);
    }
  });

  it('draws the calendar itself, not an OS date picker', () => {
    for (const [re, name] of OS_PICKERS) {
      expect(src, `${rel} reaches for ${name}`).not.toMatch(re);
    }
  });

  it('carries the same test ids on both platforms', () => {
    for (const id of ['onboarding-date-popover', 'onboarding-date-prev', 'onboarding-date-next', 'onboarding-date-day']) {
      expect(src, `${rel} is missing the ${id} test id`).toMatch(new RegExp(`["']${id}["']`));
    }
  });
});

describe('mobile/package.json', () => {
  it('has no native date-picker dependency', () => {
    const pkg = readFileSync(join(root, 'mobile/package.json'), 'utf8');
    expect(pkg, 'a native date picker is a prebuild and opens the OS calendar').not.toMatch(/datetimepicker|date-picker/i);
  });
});
