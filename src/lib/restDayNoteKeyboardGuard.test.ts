/**
 * The native base-day note box must scroll above the keyboard.
 *
 * `mobile/` has no test runner (CI's unit job installs no `mobile/node_modules`,
 * and `noMobileImportGuard` forbids `src/` importing from it), so this reads the
 * components as TEXT — the same treatment `planningClipResumeGuard.test.ts`
 * gives the planning clip.
 *
 * WHY IT EXISTS. The trip screen has ONE `KeyboardAvoidingView`, at its root
 * (`mobile/app/trips/[tripId].tsx`). It shrinks the panes when the keyboard
 * opens, but the Itinerary `FlatList` never scrolls a focused `TextInput` into
 * view by itself — so a base day near the bottom of the list would open its
 * "+ Add note to this day" box behind the keyboard (read off the layout; not
 * reproduced on a simulator when this was written). The fix: LegCard reports
 * the box's focus, and Itinerary, once `keyboardDidShow` has fired (the
 * viewport has shrunk by then), scrolls that row's bottom — where the box is —
 * to the bottom of the viewport. A second KeyboardAvoidingView inside either
 * component is the wrong fix (CLAUDE.md: KAV lives at the screen root).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const LEG_CARD = path.join(process.cwd(), 'mobile/components/LegCard.tsx');
const ITINERARY = path.join(process.cwd(), 'mobile/components/Itinerary.tsx');

/** Strip block + line comments so a rule can't be satisfied by prose about it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('native base-day note box scrolls above the keyboard', () => {
  it('LegCard wires the note TextInput onFocus to onNoteEditorFocus', () => {
    const src = code(LEG_CARD);
    expect(src).toMatch(/onNoteEditorFocus\?:\s*\(\)\s*=>\s*void/);
    // The note box is the TextInput bound to noteDraft.
    const input = src.match(/<TextInput\b(?:(?!\/>)[\s\S])*?value=\{noteDraft\}(?:(?!\/>)[\s\S])*?\/>/);
    expect(input, 'note TextInput not found').not.toBeNull();
    expect(input![0]).toMatch(/onFocus=\{onNoteEditorFocus\}/);
  });

  it('Itinerary passes onNoteEditorFocus to LegCard', () => {
    const card = code(ITINERARY).match(/<LegCard\b[\s\S]*?\/>/);
    expect(card, 'LegCard element not found').not.toBeNull();
    expect(card![0]).toMatch(/onNoteEditorFocus=\{/);
  });

  it('Itinerary scrolls with viewPosition: 1 after keyboardDidShow', () => {
    const src = code(ITINERARY);
    expect(src).toMatch(/Keyboard\.addListener\(\s*["']keyboardDidShow["']/);
    const handler = src.split('scrollNoteEditorIntoView = ')[1] ?? '';
    expect(handler).toMatch(/scrollToIndex\(\{[^}]*viewPosition:\s*1\b/);
    expect(handler).toContain('keyboardDidShow');
  });

  it('Itinerary removes the keyboard subscription on unmount', () => {
    const src = code(ITINERARY);
    expect(src).toMatch(/noteKeyboardSub\.current\?\.remove\(\)/);
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*cancelNoteScroll,\s*\[\]\)/);
  });

  it('neither LegCard nor Itinerary adds its own KeyboardAvoidingView', () => {
    expect(code(LEG_CARD)).not.toContain('KeyboardAvoidingView');
    expect(code(ITINERARY)).not.toContain('KeyboardAvoidingView');
  });
});
