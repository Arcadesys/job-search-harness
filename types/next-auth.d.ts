import 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & { githubAccountId?: string };
  }
}

import type { DefaultSession } from 'next-auth';
