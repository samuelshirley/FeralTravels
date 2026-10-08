/**
 * The identifying words of a place name, for the two server-side checks that
 * have to ask "is this the same place?" without a model call:
 *
 *  - `intentDrift.ts` — did a place named in an earlier `extract_trip_intent`
 *    survive into the latest one? ("Ordesa y Monte Perdido" and
 *    "Ordesa y Monte Perdido (Torla-Ordesa)" are the same place.)
 *  - `stopAttribution.ts` — did the user ever name the place Penny is saving
 *    as `source: "user"`?
 *
 * Deliberately simple: lowercase, accents folded, punctuation to spaces, and
 * the words that describe a KIND of place ("national", "park", "desert") or a
 * country dropped, because those match across different places. What is left
 * is the proper-noun part — "picos", "europa" — which is what a person means
 * when they say a place.
 */

/** Words that say what sort of place it is, not which one. */
const GENERIC_WORDS = new Set([
  // English
  'the', 'and', 'of', 'at', 'in', 'on', 'near', 'via', 'to', 'from',
  'national', 'natural', 'state', 'regional', 'park', 'parks', 'reserve', 'area',
  'desert', 'mountain', 'mountains', 'mount', 'lake', 'lakes', 'river', 'valley',
  'canyon', 'forest', 'beach', 'coast', 'island', 'islands', 'peak', 'pass',
  'road', 'route', 'trail', 'loop', 'track', 'city', 'town', 'village', 'old',
  'centre', 'center', 'visitor', 'north', 'south', 'east', 'west', 'upper', 'lower',
  'spain', 'france', 'italy', 'portugal', 'germany', 'usa', 'united', 'states',
  // Spanish / Catalan / French / Italian connectives and kinds
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'i', 'e', 'les', 'le', 'du', 'des',
  'di', 'da', 'parque', 'nacional', 'parc', 'desierto', 'sierra',
  'monte', 'montes', 'lago', 'rio', 'valle', 'playa', 'puerto', 'col', 'colle',
]);

/** Lowercase, accents folded, anything that is not a letter or digit to a space. */
export function normalisePlaceText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The identifying words of a place name (3+ letters, not a generic word). */
export function placeTokens(name: string): string[] {
  const seen = new Set<string>();
  for (const word of normalisePlaceText(name).split(' ')) {
    if (word.length < 3 || GENERIC_WORDS.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

/**
 * True when `candidate` names the same place as `name`: at least half of
 * `name`'s identifying words appear in `candidate` (and at least one). A name
 * that is ALL generic words ("National Park") matches nothing — there is no
 * way to tell it from any other.
 */
export function namesSamePlace(name: string, candidate: string): boolean {
  const want = placeTokens(name);
  if (want.length === 0) return false;
  const have = new Set(placeTokens(candidate));
  const overlap = want.filter((w) => have.has(w)).length;
  return overlap > 0 && overlap * 2 >= want.length;
}

/**
 * True when free `text` (a chat message, a reply) mentions the place: at least
 * half of its identifying words appear anywhere in the text.
 */
export function textMentionsPlace(text: string, name: string): boolean {
  return namesSamePlace(name, text);
}
