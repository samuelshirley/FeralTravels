import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { requireWebAccess } from '@/server/auth/webAccess';

export default async function RootPage() {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Middleware turns away browsers with no session; this is the half that
  // needs a database to tell whose session it is. Guarded by
  // webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  redirect('/trips');
}
