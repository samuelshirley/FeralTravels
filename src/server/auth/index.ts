import 'server-only';
import NextAuth, { type DefaultSession } from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/server/db/client';
import { users, accounts, sessions, verificationTokens, vehicles } from '@/server/db/schema';
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
    }),
    Resend({
      apiKey: process.env.AUTH_RESEND_KEY,
      from: process.env.AUTH_EMAIL_FROM || 'onboarding@resend.dev',
    }),
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
      const existing = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.userId, user.id)).limit(1);
      if (existing.length === 0) {
        await db.insert(vehicles).values({
          userId: user.id,
          name: 'My Vehicle',
          isDefault: true,
        });
      }
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
      // already been verified through some other flow (e.g. magic link).
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
