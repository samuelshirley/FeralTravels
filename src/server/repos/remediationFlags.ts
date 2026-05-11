import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users } from '@/server/db/schema';
import { vehicleIsCompleteForRemediation } from '@/lib/vehicleProfile';
import { listVehiclesForUser } from '@/server/repos/vehicles';

/**
 * Reads current nag flag — used when SSR trips page.
 */
export async function userNeedsVehicleProfileRemediation(userId: string): Promise<boolean> {
  const rows = await db
    .select({ flag: users.needsVehicleProfileRemediation })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.flag ?? false;
}

/**
 * Sets `needs_vehicle_profile_remediation` from owned vehicles — call after PATCH vehicle etc.
 *
 * Users with zero vehicles can't open trip workspace meaningfully but keep flag false.
 */
export async function recalculateUserRemediationFlag(userId: string): Promise<boolean> {
  const list = await listVehiclesForUser(userId);
  const incomplete = list.some((v) => !vehicleIsCompleteForRemediation(v as Record<string, unknown>));
  await db
    .update(users)
    .set({ needsVehicleProfileRemediation: incomplete })
    .where(eq(users.id, userId));
  return incomplete;
}
