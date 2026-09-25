import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { canAccessJobs } from '@/lib/jobs-access';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: 'jwt' },
  callbacks: {
    // GitHub's stable numeric account ID is checked on every OAuth sign-in.
    async signIn({ account }) {
      return account?.provider === 'github' && canAccessJobs(account.providerAccountId);
    },
    async jwt({ token, account }) {
      if (account?.provider === 'github') token.githubAccountId = account.providerAccountId;
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.githubAccountId === 'string') {
        session.user.githubAccountId = token.githubAccountId;
      }
      return session;
    },
  },
});
