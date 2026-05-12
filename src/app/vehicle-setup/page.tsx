import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Legacy vehicle-setup page — remediation now happens inline in the chat
 * composer on the trip workspace. Redirect to /trips which will handle it.
 */
export default function VehicleSetupPage() {
  redirect('/trips');
}
