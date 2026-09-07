/**
 * The native delete-account dialog keeps the two properties the web dialog is
 * tested for in `DeleteAccountSection.test.tsx`: the phrase to type is set in
 * the SEMIBOLD face (the one the armed Delete label uses), and the disarmed
 * Delete button carries no danger colour at all.
 *
 * `mobile/` has no test runner, so this reads the component as TEXT the way
 * `privacyManifest.test.ts` reads app.config.js. It is narrow on purpose: it
 * pins the two style entries the 2026-09-07 review named — `labelStrong` at
 * `font.medium` read as body text (people typed "delete"), and a disarmed
 * button in a danger tint with danger text read as a button ignoring the tap.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(__dirname, '..', '..', 'mobile', 'components', 'DeleteAccountSection.tsx'),
  'utf8'
);

/** The body of one `name: { … }` entry inside the StyleSheet. */
function styleEntry(name: string): string {
  const m = source.match(new RegExp(`\\n\\s*${name}:\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no style entry named ${name} in the native DeleteAccountSection`);
  return m[1];
}

describe('native DeleteAccountSection — emphasis and the disarmed button', () => {
  it('renders the phrase through labelStrong', () => {
    expect(source).toMatch(/<Text style=\{styles\.labelStrong\}>\{DELETE_CONFIRM_PHRASE\}<\/Text>/);
  });

  it('labelStrong is the semibold face — the same one the armed Delete label uses', () => {
    expect(styleEntry('labelStrong')).toMatch(/fontFamily:\s*font\.semibold/);
    expect(styleEntry('dangerBtnText')).toMatch(/fontFamily:\s*font\.semibold/);
  });

  it('the disarmed button has no danger colour: transparent fill, neutral border, subtle label', () => {
    const fill = styleEntry('dangerBtnDisabled');
    expect(fill).toMatch(/backgroundColor:\s*"transparent"/);
    expect(fill).toMatch(/borderColor:\s*theme\.border\b/);
    expect(fill).not.toMatch(/danger/i);

    const label = styleEntry('dangerBtnTextDisabled');
    expect(label).toMatch(/color:\s*theme\.subtle\b/);
    expect(label).not.toMatch(/danger/i);
  });

  it('both disarmed styles are actually applied when not armed', () => {
    expect(source).toMatch(/\(!armed \|\| deleting\) && styles\.dangerBtnDisabled/);
    expect(source).toMatch(/\(!armed \|\| deleting\) && styles\.dangerBtnTextDisabled/);
  });
});
