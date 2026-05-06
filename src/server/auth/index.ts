import 'server-only';
import NextAuth, { type DefaultSession } from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/server/db/client';
import { users, accounts, sessions, verificationTokens, vehicles } from '@/server/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { syncAdminFlagOnSignIn } from './admin';
import { verifyOtpCode } from './otp';
import {
  isAuthTestBackdoorConfigured,
} from './test-backdoor';
import Credentials from 'next-auth/providers/credentials';

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

    // OTP email sign-in: the /login page sends a 6-digit code via Resend,
    // the user enters it on /login/verify, and this provider validates it.
    // On success it finds or creates the user row just like the old magic-link
    // flow, so existing accounts are preserved.
    Credentials({
      id: 'email-otp',
      name: 'Email OTP',
      credentials: {
        email: { label: 'Email', type: 'email' },
        code: { label: 'Code', type: 'text' },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? '').trim().toLowerCase();
        const code = String(credentials?.code ?? '').trim();
        if (!email || !code) return null;

        const valid = await verifyOtpCode(email, code);
        if (!valid) return null;

        // Find or create the user row. Mirrors the test-backdoor pattern so
        // the same session/vehicle bootstrap logic applies.
        const existing = await db
          .select({ id: users.id, email: users.email, name: users.name, emailVerified: users.emailVerified })
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1);

        let userId: string;
        let name: string | null;

        if (existing.length > 0) {
          userId = existing[0].id;
          name = existing[0].name;
          // Mark email as verified if it isn't yet (e.g. account created via
          // Google but user is now signing in with OTP for the first time).
          if (!existing[0].emailVerified) {
            await db
              .update(users)
              .set({ emailVerified: new Date() })
              .where(eq(users.id, userId));
          }
        } else {
          const [row] = await db
            .insert(users)
            .values({
              email,
              emailVerified: new Date(),
            })
            .returning({ id: users.id, name: users.name });
          userId = row.id;
          name = row.name;

          // Bootstrap a default vehicle for new users.
          const hasV = await db
            .select({ id: vehicles.id })
            .from(vehicles)
            .where(eq(vehicles.userId, userId))
            .limit(1);
          if (hasV.length === 0) {
            await db.insert(vehicles).values({
              userId,
              name: 'My Vehicle',
              isDefault: true,
            });
          }
          await syncAdminFlagOnSignIn(email).catch(() => {});
        }

        return { id: userId, email, name: name ?? email };
      },
    }),

    ...(isAuthTestBackdoorConfigured()
      ? [
          Credentials({
            id: 'auth-test-backdoor',
            name: 'Auth test backdoor',
            credentials: {
              email: { label: 'Email', type: 'email' },
              token: { label: 'Token', type: 'password' },
            },
            async authorize(credentials) {
              if (!isAuthTestBackdoorConfigured()) return null;
              const expected = process.env.AUTH_TEST_BACKDOOR_EMAIL!.trim().toLowerCase();
              const email = String(credentials?.email ?? '').trim().toLowerCase();
              if (!email || email !== expected) return null;
              const secret = process.env.AUTH_TEST_BACKDOOR_SECRET?.trim();
              if (secret && String(credentials?.token ?? '') !== secret) return null;

              const existing = await db
                .select({ id: users.id, email: users.email, name: users.name })
                .from(users)
                .where(sql`lower(${users.email}) = ${email}`)
                .limit(1);

              let userId: string;
              let name: string | null;

              if (existing.length > 0) {
                userId = existing[0].id;
                name = existing[0].name;
              } else {
                const [row] = await db
                  .insert(users)
                  .values({
                    email,
                    emailVerified: new Date(),
                    name: 'Test user (backdoor)',
                  })
                  .returning({ id: users.id, name: users.name });
                userId = row.id;
                name = row.name;

                const hasV = await db
                  .select({ id: vehicles.id })
                  .from(vehicles)
                  .where(eq(vehicles.userId, userId))
                  .limit(1);
                if (hasV.length === 0) {
                  await db.insert(vehicles).values({
                    userId,
                    name: 'My Vehicle',
                    isDefault: true,
                  });
                }
                await syncAdminFlagOnSignIn(email).catch(() => {});
              }

              return { id: userId, email, name: name ?? 'Test user' };
            },
          }),
        ]
      : []),
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
