/**
 * The map's marker language: CIRCLES ARE DAYS, SQUARES ARE STOPS.
 *
 * Sam, 2026-10-22: "we have the little square dots and the round dots. I don't
 * know which one is which." The day dots carried no number, and a cluster of
 * stops was a numbered CIRCLE, so the one number on the map meant "how many
 * stops" while looking like a day. The grouping and labels are executed in
 * mapDayMarkers.test.ts; this holds the rendering to them.
 *
 * Read as TEXT, never imported (noMobileImportGuard.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const map = readFileSync(path.join(process.cwd(), 'mobile/components/TripMap.tsx'), 'utf8');
const styleBlock = (name: string) =>
  map.match(new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},`))?.[1] ?? '';

describe('circles are days, squares are stops', () => {
  it('day markers come from the shared grouping and show their day label', () => {
    expect(map).toMatch(/dayStartMarkers\(legs\)/);
    expect(map).toMatch(/>\s*\{marker\.label\}\s*<\/Text>/);
    // The old per-leg bare dot is gone: one leg = one unlabelled circle.
    expect(map).not.toMatch(/key=\{`leg:\$\{leg\.id\}`\}/);
  });

  it('a fuel stop shows the fuel pump and a user stop the pin', () => {
    expect(map).toMatch(/\{isFuel \? \(\s*<FuelIcon[\s\S]*?\) : \(\s*<PlaceIcon/);
  });

  it('a cluster of stops is square-cornered, never a circle', () => {
    expect(map).not.toMatch(/styles\.cluster,\s*\{[^}]*borderRadius: size \/ 2/);
    const radius = Number(styleBlock('cluster').match(/borderRadius: (\d+)/)?.[1]);
    expect(radius).toBeGreaterThan(0);
    expect(radius).toBeLessThan(10);
  });

  it('the destination is a finish flag standing beside its point, not a dot covering day 1', () => {
    expect(map).toMatch(/<FinishFlagIcon/);
    expect(map).toMatch(/anchor=\{\{ x: 0\.12, y: 0\.92 \}\}/);
  });
});
