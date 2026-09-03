import { useEffect, useState } from "react";
import { getIdentity, type Identity } from "@/lib/api";
import { getSignedInEmail } from "@/lib/auth";

/**
 * Who is signed in, for the account button and menu.
 *
 * Two sources, in this order, because they fail differently:
 *
 *  1. The address in the keychain, written at sign-in. Available instantly
 *     and offline, so the menu never opens blank while a request is in
 *     flight — but it is only ever an address, and it is whatever was true at
 *     sign-in.
 *  2. `GET /api/me/identity`. Carries the display name and the Google profile
 *     photo, which the device has no other way to learn: the app holds a
 *     bearer token, not a server-rendered session, which is why the avatar
 *     here used to be a pair of initials while the web showed the photo. It
 *     also means a user signed in on an older build gets their photo without
 *     signing out, and a photo changed at Google turns up on next launch.
 *
 * A failed fetch is not an error state: the keychain address stands and the
 * button falls back to the generic glyph. Nothing here is worth interrupting
 * the user over.
 */
export function useIdentity(): Identity {
  const [identity, setIdentity] = useState<Identity>({
    // `id` stays null until the server answers, deliberately. It is the string
    // RevenueCat is configured with, and the keychain has no copy of it — a
    // guess here would be worse than nothing. `mobile/lib/purchases.ts` reads
    // the route directly rather than this hook for exactly that reason.
    id: null,
    email: null,
    name: null,
    image: null,
  });

  useEffect(() => {
    let cancelled = false;

    void getSignedInEmail().then((email) => {
      // Only fills the gap — never overwrites a server answer that already
      // landed, which can happen on a warm cache.
      if (!cancelled && email) {
        setIdentity((prev) => (prev.email ? prev : { ...prev, email }));
      }
    });

    void getIdentity()
      .then((remote) => {
        if (cancelled) return;
        setIdentity((prev) => ({
          id: remote.id,
          email: remote.email ?? prev.email,
          name: remote.name,
          image: remote.image,
        }));
      })
      .catch(() => {
        // Offline, or the token expired and the next screen will handle it.
        // The keychain address above is enough to render the menu.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}

/**
 * The signed-in address alone, for callers that want nothing else.
 *
 * Kept as a thin wrapper over useIdentity so there is ONE fetch policy: an
 * earlier version read only the keychain, which is why the app could show an
 * address it had no name or photo to go with.
 */
export function useSignedInEmail(): string | null {
  return useIdentity().email;
}
