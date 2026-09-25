import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Private job workspace',
  robots: { index: false, follow: false, googleBot: { index: false, follow: false, noimageindex: true } },
};

export default function JobsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
