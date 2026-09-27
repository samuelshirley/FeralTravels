import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { requireWebAccess } from '@/server/auth/webAccess';

export default async function SignInPage() {
  // What `/` did until 2026-09-24, when `/` became the public landing page.
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28), and
  // `requireWebAccess()` here IS the gate: the root middleware.ts is never
  // compiled (Next looks for it beside src/app, in src/), so nothing turns a
  // cookieless browser away before this line. Guarded by
  // webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  redirect('/trips');
}
