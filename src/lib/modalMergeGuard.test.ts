import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * A native modal's wrapper Pressables must not swallow their contents.
 *
 * A Pressable is an accessibility element, and iOS MERGES an accessibility
 * element's whole subtree into one node. The pattern every sheet and dialog in
 * mobile/ uses — a backdrop Pressable that closes on tap, holding a sheet
 * Pressable whose `onPress={() => {}}` swallows taps inside it — therefore
 * publishes ONE element for the entire modal unless both carry
 * `accessible={false}`. Nothing inside exists as far as the accessibility tree
 * is concerned: not the buttons, not the inputs, not the text.
 *
 * It has shipped three times. The trips-list account menu (Maestro: "Element
 * not found" against a menu fully open in the screenshot), the trip header's
 * menu, and on 2026-09-27 the purchase sheet — found by paywall.yaml, whose
 * screen-hierarchy dump held ONE node, "Feral Travels", over a sheet showing
 * both prices: a VoiceOver user could not pick a plan, restore a purchase or
 * close it. The same sweep found the Contact Support sheet and the trip-card
 * delete dialog merged the same way.
 *
 * Touch handling is unaffected by `accessible={false}`; it only stops the merge.
 * A self-closing Pressable (a scrim with no children, like the paywall
 * overlay's) merges nothing and is exempt.
 *
 * Source-text, like the other native guards: mobile/ has no test runner.
 */
const ROOT = path.resolve(__dirname, '../..');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(rel));
    else if (entry.name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

/** Every `<Pressable …>` opening tag: its props text, and whether it self-closes. */
export function pressableTags(source: string): Array<{ line: number; props: string; selfClosing: boolean }> {
  const tags: Array<{ line: number; props: string; selfClosing: boolean }> = [];
  for (const m of source.matchAll(/<Pressable\b/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 0;
    // Props hold arrow functions (`() => …`), so the tag ends at the first `>`
    // OUTSIDE braces, not the first `>`.
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const props = source.slice((m.index ?? 0) + m[0].length, i);
    tags.push({
      line: source.slice(0, m.index).split('\n').length,
      props,
      selfClosing: props.trimEnd().endsWith('/'),
    });
  }
  return tags;
}

/** A wrapper whose job is to catch taps around or inside a sheet. */
export function isModalWrapper(props: string): boolean {
  const swallows = /onPress=\{\(\)\s*=>\s*\{\s*\}\}/.test(props);
  const backdrop = /styles\.\w*[bB]ackdrop\b/.test(props);
  return swallows || backdrop;
}

export function mergingWrappers(source: string): number[] {
  return pressableTags(source)
    .filter((t) => !t.selfClosing && isModalWrapper(t.props) && !/accessible=\{false\}/.test(t.props))
    .map((t) => t.line);
}

describe('native modal wrappers do not merge their contents', () => {
  const files = [...tsxFiles('mobile/app'), ...tsxFiles('mobile/components')];

  it('finds the wrappers at all (the guard is not vacuous)', () => {
    const wrappers = files.flatMap((f) =>
      pressableTags(fs.readFileSync(path.join(ROOT, f), 'utf8')).filter(
        (t) => !t.selfClosing && isModalWrapper(t.props)
      )
    );
    // The purchase sheet, support sheet, trip-card dialog and the two menus.
    expect(wrappers.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)('%s: every backdrop / tap-swallowing Pressable says accessible={false}', (file) => {
    const lines = mergingWrappers(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    expect(
      lines,
      `${file}: line(s) ${lines.join(', ')} wrap content in a Pressable without accessible={false} — ` +
        'iOS merges everything inside into one element, and VoiceOver and Maestro lose every control in it.'
    ).toEqual([]);
  });

  it('reads a tag whose props hold an arrow function to its real end', () => {
    const src = `<Pressable style={styles.backdrop} onPress={() => { if (!busy) close(); }}>\n<Text>x</Text></Pressable>`;
    expect(mergingWrappers(src)).toEqual([1]);
    expect(mergingWrappers(src.replace('onPress=', 'accessible={false} onPress='))).toEqual([]);
  });

  it('a self-closing scrim merges nothing and is exempt', () => {
    expect(mergingWrappers(`<Pressable style={styles.scrim} onPress={() => {}} />`)).toEqual([]);
  });
});
