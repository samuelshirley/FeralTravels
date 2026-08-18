import { useEffect, useState } from "react";
import { getSignedInEmail } from "@/lib/auth";

/**
 * The signed-in user's email address.
 *
 * GET /api/me is deliberately PII-free (units_pref + timezone only), and the
 * app has no server session to read a name out of the way the web does. The
 * address the user typed at sign-in is therefore the only identity available,
 * so it is kept in the keychain alongside the token and read back here.
 *
 * Returns null for a Google/Apple sign-in until that path stores the address
 * it got back from the provider exchange.
 */
export function useSignedInEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSignedInEmail().then((e) => {
      if (!cancelled) setEmail(e);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return email;
}

/** Initials for the account button: "sam@x.com" -> "S". */
export function initialsFor(email: string | null): string {
  return (email || "?")
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s: string) => s[0]?.toUpperCase() ?? "")
    .join("");
}
