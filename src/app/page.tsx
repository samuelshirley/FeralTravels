import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';

export default async function RootPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  redirect('/trips');
}
