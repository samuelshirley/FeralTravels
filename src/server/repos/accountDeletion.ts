import 'server-only';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import {
  accounts,
  chatHistory,
  deletedUsers,
  emailOtpCodes,
  oauthTokenUses,
  trips,
  usageEvents,
  users,
  vehicles,
  verificationTokens,
} from '@/server/db/schema';
import { decryptEmail, encryptEmail, hashEmail } from '@/server/deletedUserCrypto';
import { NotFoundError } from '@/server/auth/errors';

export interface AccountDeletionSummary {
  tripCount: number;
  vehicleCount: number;
  chatMessageCount: number;
  signInProviders: string[];
}

/**
 * Hard-delete a user and everything belonging to them, then leave a tombstone.
 *
 * The heavy lifting is done by Postgres, not by this function. Every table that
 * hangs off a user does so through an `ON DELETE CASCADE` foreign key — directly
 * (accounts, sessions, vehicles, trips, viewport time, announcement dismissals,
 * penny turns) or transitively through `trips` (legs, routes, stops, tasks, pois,
 * costs, links, gpx trails, chat history). So deleting the `users` row is what
 * actually erases the account, and a new child table added later inherits this
 * behaviour for free as long as it carries the same cascade.
 *
 * Two categories need explicit help, and both are the reason this is not simply
 * a one-line delete:
 *
 *  1. Rows keyed by EMAIL rather than user id — `email_otp_codes`,
 *     `oauth_token_uses`, `verificationTokens`. Postgres has no idea these belong
 *     to the user, so a cascade leaves them behind holding the address of someone
 *     who just asked to be forgotten.
 *  2. `usage_events`, which is `ON DELETE SET NULL` on purpose. AI spend, model
 *     costs and the admin error log survive, anonymised, because wiping them
 *     would put holes in cost history that has nothing to do with the person.
 *     Anonymised is NOT automatic though: a few providers write free text into
 *     `error_message` — `penny:user-idea` stores the user's own sentence, and
 *     `penny:contiguity-gap` stores place names lifted out of their itinerary.
 *     Nulling `user_id` would leave those readable in /admin/errors forever, so
 *     the text is cleared explicitly and only the numbers survive.
 *
 * Everything runs in one transaction, so a failure part-way leaves the account
 * fully intact rather than half-erased.
 */
export async function deleteUserAccount(
  userId: string,
  deletedBy: 'self' | 'admin' = 'self'
): Promise<AccountDeletionSummary> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new NotFoundError('Account not found.');

    // Every writer stores the address lowercased, but `users.email` itself is
    // NOT guaranteed to be — the NextAuth adapter inserts the provider's
    // `profile.email` verbatim. Comparing the raw value against the email-keyed
    // tables would silently leave behind the very rows this function exists to
    // remove, so normalize once and compare with lower() on both sides.
    const normalizedEmail = user.email ? user.email.trim().toLowerCase() : null;

    // Counts are read before the delete for the obvious reason, and they are
    // the only thing we keep about what the person actually built. "Signed up,
    // planned one trip, left" and "planned nine trips over four months, left"
    // are very different churn stories and neither needs any personal data.
    // Sequential, not Promise.all: a drizzle/postgres-js transaction runs on one
    // reserved connection, and firing concurrent queries down it is asking for
    // trouble in the one place in the app where a half-executed statement list
    // would be worst. Four small counts cost nothing.
    const [tripRows] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(trips)
      .where(eq(trips.userId, userId));
    const [vehicleRows] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(vehicles)
      .where(eq(vehicles.userId, userId));
    const [chatRows] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(chatHistory)
      .innerJoin(trips, eq(chatHistory.tripId, trips.id))
      .where(eq(trips.userId, userId));
    const accountRows = await tx
      .select({ provider: accounts.provider })
      .from(accounts)
      .where(eq(accounts.userId, userId));

    // `accounts` rows are written only by the NextAuth adapter, i.e. the WEB
    // OAuth flow. The native flow (/api/mobile/oauth/exchange) mints a user and
    // a session without one, so an absent row does not mean "emailed code" — it
    // would have labelled every iOS Google/Apple user as `otp`, which is exactly
    // the cohort this table is being built to watch. `oauth_token_uses` is the
    // native path's own record, keyed by email, so it distinguishes the two even
    // though it does not name the provider.
    const providers = Array.from(new Set(accountRows.map((r) => r.provider)));
    let signInProviders = providers;
    if (signInProviders.length === 0 && normalizedEmail) {
      const [native] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(oauthTokenUses)
        .where(sql`lower(${oauthTokenUses.email}) = ${normalizedEmail}`);
      signInProviders = (native?.count ?? 0) > 0 ? ['native-oauth'] : ['otp'];
    }

    const summary: AccountDeletionSummary = {
      tripCount: tripRows?.count ?? 0,
      vehicleCount: vehicleRows?.count ?? 0,
      chatMessageCount: chatRows?.count ?? 0,
      signInProviders,
    };

    if (normalizedEmail) {
      await tx.insert(deletedUsers).values({
        emailHash: hashEmail(normalizedEmail),
        // Null when no key is configured. Never a reason to abort: losing the
        // readable address costs us a churn detail, refusing the deletion costs
        // the user their legal right to leave.
        emailEncrypted: encryptEmail(normalizedEmail),
        signInProviders: signInProviders.join(','),
        accountCreatedAt: user.createdAt ?? null,
        tripCount: summary.tripCount,
        vehicleCount: summary.vehicleCount,
        chatMessageCount: summary.chatMessageCount,
        deletedBy,
      });

      // The email-keyed strays. Each of these holds the raw address, so they
      // have to go by address — nothing links them to the user id.
      await tx.delete(emailOtpCodes).where(sql`lower(${emailOtpCodes.email}) = ${normalizedEmail}`);
      await tx.delete(oauthTokenUses).where(sql`lower(${oauthTokenUses.email}) = ${normalizedEmail}`);
      await tx
        .delete(verificationTokens)
        .where(sql`lower(${verificationTokens.identifier}) = ${normalizedEmail}`);
    }

    // Scrub the free text out of the usage rows that are about to be orphaned.
    // The cost columns are what the admin dashboard actually needs; the message
    // is the only part that can carry something the person wrote or a place they
    // drove to, and a null user_id does not make a sentence anonymous.
    await tx
      .update(usageEvents)
      .set({ errorMessage: null })
      .where(and(eq(usageEvents.userId, userId), isNotNull(usageEvents.errorMessage)));

    // The one statement that actually erases the account. Everything with a
    // cascading foreign key goes with it.
    await tx.delete(users).where(eq(users.id, userId));

    return summary;
  });
}

export interface DeletedAccountRow {
  id: number;
  /** Decrypted address, or null when the key is missing or the row predates it. */
  email: string | null;
  emailHash: string;
  signInProviders: string[];
  accountCreatedAt: Date | null;
  deletedAt: Date;
  tripCount: number;
  vehicleCount: number;
  chatMessageCount: number;
  deletedBy: string;
}

/**
 * Admin-only read of the tombstones, newest first. Decryption happens here
 * rather than in the page so the key never travels further than it must.
 */
export async function listDeletedAccounts(limit = 200): Promise<DeletedAccountRow[]> {
  const rows = await db
    .select()
    .from(deletedUsers)
    .orderBy(desc(deletedUsers.deletedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    email: decryptEmail(r.emailEncrypted),
    emailHash: r.emailHash,
    signInProviders: r.signInProviders ? r.signInProviders.split(',') : [],
    accountCreatedAt: r.accountCreatedAt,
    deletedAt: r.deletedAt,
    tripCount: r.tripCount,
    vehicleCount: r.vehicleCount,
    chatMessageCount: r.chatMessageCount,
    deletedBy: r.deletedBy,
  }));
}

/**
 * "Did this address ever have an account?" — the question the hash column
 * exists to answer, and the one that still works when no encryption key is set.
 */
export async function wasEmailDeleted(email: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deletedUsers)
    .where(eq(deletedUsers.emailHash, hashEmail(email)));
  return row?.count ?? 0;
}
