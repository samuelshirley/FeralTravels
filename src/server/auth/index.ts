import 'server-only';
import NextAuth, { type DefaultSession } from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/server/db/client';
import { users, accounts, sessions, verificationTokens } from '@/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { syncAdminFlagOnSignIn } from './admin';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

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

    // OTP email sign-in is handled directly by signInWithOtp() in
    // src/server/auth/otp.ts — it verifies the code, finds/creates the user,
    // creates a database session, and sets the cookie. We bypass Auth.js's
    // Credentials provider because it doesn't support database sessions.
    // NOTE: Google + OTP are the ONLY sign-in paths. There is deliberately no
    // test/bypass provider — a guard test in src/lib/ enforces this.
  ],
  callbacks: {
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

      // Trusted-OAuth email verification: Google (and any OIDC provider) ships
      // an `email_verified` claim on the ID token. When that claim is true we
      // can safely mark the local `emailVerified` column, which our admin
      // guard requires. Without this, Google OAuth users never pass the
      // "emailVerified IS NOT NULL" check. We only touch rows that haven't
      // already been verified through some other flow (e.g. OTP sign-in).
      try {
        const trustedOAuthProviders = new Set(['google']);
        if (
          user?.email &&
          account?.provider &&
          trustedOAuthProviders.has(account.provider) &&
          profile?.email_verified === true
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
