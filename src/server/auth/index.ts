import 'server-only';
import NextAuth, { type DefaultSession } from 'next-auth';
import Google from 'next-auth/providers/google';
import Apple from 'next-auth/providers/apple';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/server/db/client';
import { users, accounts, sessions, verificationTokens } from '@/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { syncAdminFlagOnSignIn } from './admin';
import { sanitizeAvatarUrl } from '@/lib/avatarUrl';
import { isProviderEmailProven } from './emailVerification';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

/**
 * Sign in with Apple on the WEB is opt-in on configuration, not on a flag.
 *
 * Unlike Google, Apple's "client secret" is not a static string: it is a JWT
 * you sign with a .p8 key, and Apple caps its lifetime at SIX MONTHS. When it
 * expires, Apple sign-in starts failing with an opaque `invalid_client` and
 * nothing in this repo changes. Generate a fresh one with
 * `npx tsx scripts/generate-apple-client-secret.ts` and update AUTH_APPLE_SECRET.
 *
 * Until both vars exist, the provider is not registered and the login page
 * does not render the button — the same "no dead buttons" rule the iOS screen
 * follows. Note this is the WEB flow only: the iOS app's native Sign in with
 * Apple does not go through Auth.js at all, it posts its identity token to
 * /api/mobile/oauth/exchange.
 */
export const isAppleSignInConfigured = Boolean(
  process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'database' },
  trustHost: true,
  pages: { signIn: '/login' },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // If someone first signed in with Google and later uses the same email
      // for an OTP code (or the reverse), Auth.js would otherwise refuse to
      // merge accounts (OAuthAccountNotLinked) and they'd get a second user
      // row — vehicles and trips would appear "missing". Google verifies
      // email on the ID token; linking is appropriate here.
      // https://authjs.dev/concepts/oauth#allowdangerousemailaccountlinking-option
      allowDangerousEmailAccountLinking: true,
      // Always show the Google account picker, even for users who only have
      // one account signed in. Without this, Google skips the picker on
      // repeat sign-ins which makes the app feel like it picked an account
      // for the user instead of letting them choose. People often have
      // multiple Google accounts (work + personal); forcing the picker is
      // worth the one extra click.
      authorization: { params: { prompt: 'select_account' } },
    }),

    // Apple. Spread rather than a ternary inside the array so the provider is
    // ABSENT (not present-and-broken) when unconfigured — Auth.js will happily
    // register a provider with undefined credentials and only fail at redirect.
    ...(isAppleSignInConfigured
      ? [
          Apple({
            clientId: process.env.AUTH_APPLE_ID,
            clientSecret: process.env.AUTH_APPLE_SECRET,
            // Same reasoning as Google above: Apple verifies the address on
            // the identity token, so linking it to an existing user with that
            // email is correct — and refusing to would hand the user a second
            // account with none of their trips in it.
            //
            // CAVEAT worth knowing before you support-ticket it: a user who
            // picks "Hide My Email" arrives as
            // <opaque>@privaterelay.appleid.com, which is a DIFFERENT address
            // from their real one. There is nothing to link it to, so that is
            // a separate account by design, not a bug.
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),

    // OTP email sign-in is handled directly by signInWithOtp() in
    // src/server/auth/otp.ts — it verifies the code, finds/creates the user,
    // creates a database session, and sets the cookie. We bypass Auth.js's
    // Credentials provider because it doesn't support database sessions.
    // NOTE: Google, Apple (when configured) and OTP are the ONLY sign-in
    // paths. There is deliberately no test/bypass provider — a guard test in
    // src/lib/ enforces this.
  ],
  callbacks: {
    /**
     * The web counterpart of the check in oauthIdentity.ts.
     *
     * Both Google and Apple are registered with
     * `allowDangerousEmailAccountLinking: true`, which links an OAuth identity
     * onto whatever local user already holds that email. That is the right
     * behaviour for a PROVEN address and account takeover for an unproven one,
     * so the proof has to be enforced at the door. `events.signIn` cannot do
     * it — an event fires after the decision and its return value is ignored;
     * it only decides whether to stamp users.emailVerified. This callback is
     * the only place a sign-in can actually be refused.
     *
     * The rule itself lives in `emailVerification.ts` and is shared with the
     * native path: an explicitly unverified address is refused, an absent
     * claim is refused, and the sole exception is Apple's Hide My Email alias,
     * a domain Apple owns and routes. `emailVerification.test.ts` covers it —
     * including the property that this callback and `oauthIdentity.ts` answer
     * identically, which a comment alone never guaranteed.
     */
    signIn({ account, profile }) {
      const provider = account?.provider;
      if (provider !== 'google' && provider !== 'apple') return true;

      // The SAME predicate the native exchange uses — imported, not restated,
      // because two copies of this rule is how the two paths come to disagree
      // about who is allowed in.
      const email = typeof profile?.email === 'string' ? profile.email : '';
      return isProviderEmailProven(provider, profile?.email_verified, email);
    },
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (!user.id) return;
      // Set admin flag on first creation if email is on the hardcoded allowlist.
      await syncAdminFlagOnSignIn(user.email).catch(() => {});
    },
    async signIn({ user, account, profile }) {
      // Re-sync silently on every sign-in: protects against a row being
      // tampered with manually, and ensures admin status is reflected even on
      // users created before the flag was added.
      await syncAdminFlagOnSignIn(user?.email).catch(() => {});

      /**
       * Refresh the stored avatar on every Google sign-in.
       *
       * The Drizzle adapter only writes `image` when it CREATES the user, so
       * without this: a user who signed in by emailed code first and linked
       * Google later never got a photo at all, and anyone who changed their
       * photo at Google kept the old URL until it 404'd. Mirrors what
       * createSessionForEmail does on the native path, so web and iOS agree
       * about what the account looks like.
       *
       * The URL goes through the host allowlist first — `profile.picture` is
       * a third-party string even on a verified token.
       */
      try {
        if (user?.email && account?.provider === 'google') {
          const avatar = sanitizeAvatarUrl((profile as { picture?: unknown } | undefined)?.picture);
          if (avatar) {
            await db
              .update(users)
              .set({ image: avatar })
              .where(eq(users.email, user.email.toLowerCase()));
          }
        }
      } catch {
        // Non-fatal bookkeeping: a failed avatar refresh must never block a
        // sign-in. The previous photo (or the glyph) stands until next time.
      }

      // Trusted-OAuth email verification: Google (and any OIDC provider) ships
      // an `email_verified` claim on the ID token. When that claim is true we
      // can safely mark the local `emailVerified` column, which our admin
      // guard requires. Without this, Google OAuth users never pass the
      // "emailVerified IS NOT NULL" check. We only touch rows that haven't
      // already been verified through some other flow (e.g. OTP sign-in).
      try {
        const trustedOAuthProviders = new Set(['google', 'apple']);
        // Apple sends this claim as the STRING "true"; Google sends a boolean.
        // Auth.js types it as boolean, so read it widened — a strict
        // `=== true` check would silently skip every Apple user, leaving
        // emailVerified null and the admin guard failing for them.
        const emailVerifiedClaim = profile?.email_verified as boolean | string | undefined;
        if (
          user?.email &&
          account?.provider &&
          trustedOAuthProviders.has(account.provider) &&
          (emailVerifiedClaim === true || emailVerifiedClaim === 'true')
        ) {
          await db
            .update(users)
            .set({ emailVerified: new Date() })
            .where(and(eq(users.email, user.email.toLowerCase()), isNull(users.emailVerified)));
        }
      } catch {
        // Non-fatal: sign-in should still succeed even if this bookkeeping
        // fails; admin access just won't flip on until the next sign-in.
      }
    },
  },
});
