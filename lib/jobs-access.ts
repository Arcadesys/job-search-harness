/** Server-side authorization policy for the private job workspace. */
export function configuredGithubAccountIds(value = process.env.JOBS_GITHUB_ACCOUNT_IDS): Set<string> {
  return new Set((value ?? '').split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id)));
}

export function canAccessJobs(accountId: string | null | undefined, allowlist = configuredGithubAccountIds()): boolean {
  return Boolean(accountId && /^\d+$/.test(accountId) && allowlist.has(accountId));
}

export function privateJobsPath(pathname: string): boolean {
  return pathname === '/jobs' || pathname.startsWith('/jobs/')
    || pathname === '/api/jobs' || pathname.startsWith('/api/jobs/');
}
