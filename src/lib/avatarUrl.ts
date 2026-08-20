/**
 * What counts as a storable profile picture.
 *
 * The only avatar this app ever holds is the `picture` claim off a Google ID
 * token. That claim is a URL chosen by a third party and handed to us by a
 * client, so it gets the same treatment as every other input that crosses the
 * trust boundary: it must match ONE narrow, pre-declared shape or it is
 * dropped. Nothing free-form is persisted. (See "Lockdown invariants" in
 * CLAUDE.md.)
 *
 * The shape is deliberately tighter than "a valid URL":
 *
 *  - **https only.** The URL is rendered as an <img> / RN <Image> src on both
 *    platforms; an http one would be a mixed-content block at best.
 *  - **Google's own avatar CDN only.** Without a host allowlist, a forged ID
 *    token (or a future provider change) could park an arbitrary URL in our
 *    database that every viewer's browser then fetches — a tracking pixel, or
 *    a 404 on someone else's bandwidth. Google serves account photos from
 *    `*.googleusercontent.com` (lh3, lh4, lh5, lh6 …); nothing else is
 *    accepted.
 *  - **No credentials, no port.** Both are signals that something is off, and
 *    neither ever appears on a real Google avatar URL.
 *
 * A rejection is not an error: it returns null and the UI falls back to the
 * generic glyph. That is also the failure mode if Google ever moves its
 * avatars off googleusercontent.com — photos quietly stop appearing for new
 * sign-ins rather than anything breaking, and this allowlist is the one place
 * to widen.
 *
 * Sign in with Apple never yields a picture at all: the Apple ID token has no
 * `picture` claim, so Apple-only users always get the glyph. That is a
 * property of Apple's token, not a gap here.
 */

/** Long enough for a real Google avatar URL, short enough to bound the column. */
const MAX_LENGTH = 512;

/** Google account photos live here; the numeric `lh*` prefix varies. */
const ALLOWED_HOST_SUFFIX = '.googleusercontent.com';

export function sanitizeAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  if (!url.hostname.toLowerCase().endsWith(ALLOWED_HOST_SUFFIX)) return null;

  return trimmed;
}
