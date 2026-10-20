/**
 * Both chat panels ask for the third-party-AI agreement before anything they
 * send can reach Penny (App Review 5.1.2(i)), and both understand the
 * server's 403 `ai_consent_required`.
 *
 * The native panel has no test runner here, so this pins it at source level
 * — the same trade `onboardingPhaseGuard` makes. The web panel is also
 * covered by behaviour (ChatPanel.aiConsent.test.tsx), and the logic both run
 * by aiConsent.test.ts; the native sheet is driven for real by the Maestro
 * flows (mobile/maestro/ai-consent-agree.yaml, ai-consent-not-now.yaml).
 *
 * Every client of an error code needs copy for it — the rule
 * nativeErrorCopyGuard enforces for sign-in. Here the copy is shared
 * (src/lib/aiConsent.ts) and the server builds its error from the same
 * constant, so the code cannot drift between the three.
 *
 * Mutation-checked when written: removing the `ensure()` line from each
 * choke point in either panel, or the 403 branch, turned this red.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** From `start` to the next line that begins a sibling declaration at the same indent. */
function block(src: string, start: RegExp, label: string): string {
  const m = start.exec(src);
  expect(m, `${label}: not found`).not.toBeNull();
  const from = m!.index;
  const indent = /^[ \t]*/.exec(src.slice(src.lastIndexOf('\n', from) + 1))![0];
  const rest = src.slice(from + m![0].length);
  const end = rest.search(new RegExp(`\\n${indent}(const |async function |function |// ──)`));
  return src.slice(from, from + m![0].length + (end === -1 ? rest.length : end));
}

const ENSURE = /if \(!\(await aiConsent\.ensure\(\)\)\) return;/;

function before(body: string, first: RegExp, second: RegExp, label: string) {
  const a = body.search(first);
  const b = body.search(second);
  expect(a, `${label}: no aiConsent.ensure() gate`).toBeGreaterThan(-1);
  expect(b, `${label}: the call it should guard (${second}) is gone — update this guard`).toBeGreaterThan(-1);
  expect(a, `${label}: ${second} can run before the user agreed`).toBeLessThan(b);
}

const PANELS = [
  {
    file: 'src/components/ChatPanel.tsx',
    engine: /const sendChatMessage = async \(/,
    engineSend: /fetch\('\/api\/trip\/replan'/,
    setup: /async function submitOnboardingPost\(/,
    setupSend: /apiFetch<OnboardingAnswerResult>\(/,
    composer: /const sendMessage = async \(\) => \{/,
    composerClear: /setInput\(''\);\n\s*setImages\(\[\]\);/,
    sheet: '<AiConsentDialog',
  },
  {
    file: 'mobile/components/ChatPanel.tsx',
    engine: /= async \(\n\s*trimmed,\n\s*attachedImages = \[\],/,
    engineSend: /startTurnStream\(\{/,
    setup: /const submitOnboardingAnswer = async \(/,
    setupSend: /api\.answerOnboarding\(/,
    composer: /const sendMessage = async \(\) => \{/,
    composerClear: /setInput\(""\);\n\s*setImages\(\[\]\);/,
    sheet: '<AiConsentSheet',
  },
];

for (const p of PANELS) {
  describe(`${p.file} asks before Penny`, () => {
    const src = read(p.file);

    it('the send engine (composer, queue, Continue, handoff) waits for the agreement', () => {
      before(block(src, p.engine, 'send engine'), ENSURE, p.engineSend, `${p.file} send engine`);
    });

    it('every setup answer — typed, picked or the vehicle card — waits for it', () => {
      before(block(src, p.setup, 'setup submit'), ENSURE, p.setupSend, `${p.file} setup submit`);
    });

    it('the composer asks before clearing what was typed', () => {
      before(block(src, p.composer, 'composer'), ENSURE, p.composerClear, `${p.file} composer`);
    });

    it('a suggestion chip asks before it fills the composer', () => {
      const chips = src.slice(src.indexOf('onboardingQuestion.prompts.map('));
      const tap = chips.slice(0, chips.indexOf('</'));
      before(tap, ENSURE, /setInput\(prompt\)/, `${p.file} suggestion chip`);
    });

    it("branches on the server's 403 ai_consent_required, on Penny and on setup", () => {
      const hits = [...src.matchAll(/status === 403 &&[\s\S]{0,120}AI_CONSENT_REQUIRED_CODE/g)];
      expect(hits.length, `${p.file}: expected the replan and the setup 403 branches`).toBe(2);
      expect(src).toMatch(/aiConsent\.requiredByServer\(\)/);
    });

    it('renders the sheet, the declined line and its way back, from the shared copy', () => {
      expect(src).toContain(p.sheet);
      expect(src).toContain('ai-consent-declined');
      expect(src).toContain('ai-consent-review');
      expect(src).toContain('AI_CONSENT_COPY.declinedLine');
      expect(src).toContain('AI_CONSENT_COPY.declinedAction');
    });
  });
}

describe('one definition of the code and the copy', () => {
  it('the server refuses with the shared code', () => {
    const errors = read('src/server/auth/errors.ts');
    expect(errors).toMatch(/super\(403, AI_CONSENT_REQUIRED_MESSAGE, \{ code: AI_CONSENT_REQUIRED_CODE \}\)/);
  });

  it('both sheets render the shared title, body, privacy link and buttons', () => {
    for (const file of ['mobile/components/AiConsentSheet.tsx', 'src/components/AiConsentDialog.tsx']) {
      const src = read(file);
      for (const key of ['title', 'body', 'privacyLink', 'agree', 'notNow']) {
        expect(src, `${file} does not render AI_CONSENT_COPY.${key}`).toContain(`AI_CONSENT_COPY.${key}`);
      }
      expect(src).toContain('PRIVACY_POLICY_PATH');
      for (const id of ['ai-consent-sheet', 'ai-consent-agree', 'ai-consent-not-now', 'ai-consent-privacy', 'ai-consent-error']) {
        expect(src, `${file} lost testID ${id}`).toContain(id);
      }
    }
  });
});
