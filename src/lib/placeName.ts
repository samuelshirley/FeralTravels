/**
 * The name a resolved place should carry on a leg.
 *
 * `resolve_place` already returns both halves — Google's `displayName`
 * ("Monument Valley") and its `formattedAddress` ("Monument Valley, UT 84536,
 * USA") — so nothing new is fetched here and no field mask changes (the mask
 * decides the Places SKU; see repos/usage.ts). What was missing is a single
 * SHORT, QUALIFIED string, because leaving Penny to pick meant she picked: bare
 * "Monument Valley" reads as a guess in a trip that also visits Utah, and the
 * full address puts a postcode in the itinerary.
 *
 * Deliberately conservative. It qualifies only when it can do so confidently and
 * otherwise returns the label untouched — a wrong qualifier is worse than none,
 * and the label alone is exactly where we were before.
 */

/** "UT 84536" → "UT"; "84536" → "" (a postcode is not a qualifier). */
function stripPostcode(part: string): string {
  return part.replace(/\s*\b\d[\d\s-]*$/, '').trim();
}

/**
 * A short place name qualified by its region: "Marfa, TX", "Girona, Spain".
 *
 * @param label Google's displayName — the place as a person says it.
 * @param formattedAddress Google's formattedAddress, when there is one.
 */
export function qualifiedPlaceName(
  label: string | null | undefined,
  formattedAddress?: string | null
): string | null {
  const name = label?.trim();
  if (!name) return null;
  const address = formattedAddress?.trim();
  if (!address) return name;

  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return name;

  // In a 3+ part address the last part is the country and the one before it is
  // the state/region, which is the useful qualifier ("Marfa, TX 79843, USA").
  // In a 2-part address there is no state, so the country is the qualifier
  // ("Girona, Spain").
  const raw = parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1];
  const qualifier = stripPostcode(raw);

  // Nothing usable, or it would only repeat what the name already says.
  if (!qualifier) return name;
  if (qualifier.toLowerCase() === name.toLowerCase()) return name;
  if (name.toLowerCase().endsWith(`, ${qualifier.toLowerCase()}`)) return name;

  return `${name}, ${qualifier}`;
}
