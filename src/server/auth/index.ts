import 'server-only';
import NextAuth, { type DefaultSession } from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { Resend as ResendClient } from 'resend';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/server/db/client';
import { users, accounts, sessions, verificationTokens, vehicles } from '@/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { syncAdminFlagOnSignIn } from './admin';
import { renderMagicEmail } from './magic-email';

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
      // for a magic link (or the reverse), Auth.js would otherwise refuse to
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
    Resend({
      apiKey: process.env.AUTH_RESEND_KEY,
      from: process.env.AUTH_EMAIL_FROM || 'onboarding@resend.dev',
      // Wrap the Resend send call so we can: (a) brand the email,
      // (b) catch + log the Resend API error so users see a real message
      // instead of an opaque 500, and (c) surface common configuration
      // pitfalls (test sender locked to account-owner email, etc.).
      async sendVerificationRequest({ identifier: to, url, provider }) {
        const apiKey = (provider as { apiKey?: string }).apiKey ?? process.env.AUTH_RESEND_KEY;
        const from = (provider as { from?: string }).from ?? process.env.AUTH_EMAIL_FROM ?? 'onboarding@resend.dev';
        if (!apiKey) {
          throw new Error('Email sign-in is not configured (missing AUTH_RESEND_KEY).');
        }
        const resend = new ResendClient(apiKey);
        const subject = 'Sign in to Feral Travels';
        const result = await resend.emails.send({
          from,
          to,
          subject,
          html: renderMagicEmail({ url, to }),
          text: `Sign in to Feral Travels: ${url}\n\nIf you didn't request this, you can ignore this email.`,
        });
        if (result.error) {
          // Resend's most common pitfall: `onboarding@resend.dev` can only
          // send to the account-owner's email. Translate that into a clear
          // operator message in the server log; the user sees a generic
          // "couldn't send" banner via the /login error page mapping.
          const msg = result.error.message || 'Unknown Resend error';
          console.error('[auth] Resend send failed', { to, from, error: result.error });
          throw new Error(`EmailSendFailed: ${msg}`);
        }
      },
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
