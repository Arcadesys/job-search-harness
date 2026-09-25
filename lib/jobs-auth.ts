import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { canAccessJobs } from '@/lib/jobs-access';

export async function requireJobsAccount(): Promise<string> {
  const session = await auth();
  const accountId = session?.user?.githubAccountId;
  if (!canAccessJobs(accountId)) redirect('/api/auth/signin?callbackUrl=%2Fjobs');
  return accountId!;
}

export async function authorizedJobsAccount(): Promise<string | null> {
  const session = await auth();
  const accountId = session?.user?.githubAccountId;
  return canAccessJobs(accountId) ? accountId! : null;
}
