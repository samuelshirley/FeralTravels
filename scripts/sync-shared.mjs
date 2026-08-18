// Mirrors the DOM-free domain modules from the Next app into mobile/shared/.
// Canonical source is src/lib + src/types — never edit mobile/shared/ by hand.
// `npm run check:shared` (vitest) fails if the mirror drifts.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const SHARED_FILES = [
  ['src/types/trip.ts', 'mobile/shared/types/trip.ts'],
  ['src/lib/units.ts', 'mobile/shared/lib/units.ts'],
  ['src/lib/maps.ts', 'mobile/shared/lib/maps.ts'],
  ['src/lib/coords.ts', 'mobile/shared/lib/coords.ts'],
  ['src/lib/dates.ts', 'mobile/shared/lib/dates.ts'],
  ['src/lib/dayModel.ts', 'mobile/shared/lib/dayModel.ts'],
  ['src/lib/legSegmentGrouping.ts', 'mobile/shared/lib/legSegmentGrouping.ts'],
  ['src/lib/fuelPlanErrorSemantics.ts', 'mobile/shared/lib/fuelPlanErrorSemantics.ts'],
  ['src/lib/vehicleProfile.ts', 'mobile/shared/lib/vehicleProfile.ts'],
  ['src/lib/vehicleNumericCoercion.ts', 'mobile/shared/lib/vehicleNumericCoercion.ts'],
  ['src/lib/validation.ts', 'mobile/shared/lib/validation.ts'],
  ['src/lib/polyline.ts', 'mobile/shared/lib/polyline.ts'],
  ['src/lib/mapClustering.ts', 'mobile/shared/lib/mapClustering.ts'],
  ['src/lib/useNextStop.ts', 'mobile/shared/lib/useNextStop.ts'],
  ['src/lib/sillyErrors.ts', 'mobile/shared/lib/sillyErrors.ts'],
  ['src/lib/models.ts', 'mobile/shared/lib/models.ts'],
];
// The mirror keeps `@/` specifiers working by rewriting them to relative paths.
export function transform(source, destRel) {
  const depth = destRel.startsWith('mobile/shared/lib/') ? '..' : '..';
  return source
    .replace(/from '@\/types\//g, `from '${depth}/types/`)
    .replace(/from '@\/lib\//g, `from '${depth}/lib/`)
    .replace(/^'use client';\n/m, '');
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [src, dest] of SHARED_FILES) {
    if (!existsSync(src)) { console.error(`missing ${src}`); process.exit(1); }
    mkdirSync(dirname(dest), { recursive: true });
    const out = transform(readFileSync(src, 'utf8'), dest);
    require('node:fs').writeFileSync(dest, out);
    console.log(`synced ${src} -> ${dest}`);
  }
}
