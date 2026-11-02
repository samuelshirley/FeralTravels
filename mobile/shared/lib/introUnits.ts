import type { UnitsPref } from '../lib/units';

/**
 * The units the first-launch intro draws its distances in.
 *
 * The intro runs before sign-in, so there is no stored preference and the
 * app's UnitsProvider defaults to metric. A driver in the US seeing "342 km"
 * on the first screen they ever see would be the wrong first impression, so
 * the intro reads the device locale's REGION — the only signal available
 * without a native dependency — and picks imperial for the three countries
 * that still drive in miles by default (US, Liberia, Myanmar). Everything else
 * is metric, which is also the answer when the region cannot be read.
 *
 * Mobile passes `Intl.NumberFormat().resolvedOptions().locale` (Hermes). The
 * parse is BCP 47: a `-u-…-rg-xxzzzz` region override wins, then the first
 * 2-letter or 3-digit subtag after the language (a 4-letter script subtag is
 * skipped). Mirrored to mobile/shared by scripts/sync-shared.mjs.
 */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

export function localeRegion(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const tags = locale.replace(/_/g, '-').split('-').filter(Boolean);
  // Unicode extension: `-u-` followed by key/value pairs; `rg` is the region override.
  const u = tags.findIndex((t) => t.toLowerCase() === 'u');
  if (u >= 0) {
    for (let i = u + 1; i < tags.length - 1; i++) {
      if (tags[i].length === 1) break; // the next singleton starts another extension
      if (tags[i].toLowerCase() === 'rg' && /^[a-z]{2}z{4}$/i.test(tags[i + 1])) {
        return tags[i + 1].slice(0, 2).toUpperCase();
      }
    }
  }
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i];
    if (t.length === 1) break; // an extension or private-use singleton: no region before it
    if (/^[a-z]{2}$/i.test(t) || /^\d{3}$/.test(t)) return t.toUpperCase();
  }
  return null;
}

export function introUnitsForLocale(locale: string | null | undefined): UnitsPref {
  const region = localeRegion(locale);
  return region != null && IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
}
