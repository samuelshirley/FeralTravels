import { redirect } from 'next/navigation';
import { requireWebAccess } from '@/server/auth/webAccess';

export const dynamic = 'force-dynamic';

/**
 * Legacy vehicle-setup page — remediation now happens inline in the chat
 * composer on the trip workspace. Redirect to /trips which will handle it.
 */
export default async function VehicleSetupPage() {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Middleware turns away browsers with no session; this is the half that
  // needs a database to tell whose session it is. Guarded by
  // webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  redirect('/trips');
}
