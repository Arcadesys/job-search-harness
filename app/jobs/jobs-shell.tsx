import Link from 'next/link';

type View = 'today' | 'leads' | 'truths' | 'review' | 'settings';
const navigation: { id: View; label: string; href: string }[] = [
  { id: 'today', label: 'Today', href: '/jobs' },
  { id: 'leads', label: 'Leads', href: '/jobs/leads' },
  { id: 'truths', label: 'Résumé truths', href: '/jobs/truths' },
  { id: 'review', label: 'Weekly review', href: '/jobs/review' },
  { id: 'settings', label: 'Search settings', href: '/jobs/settings' },
];
export default function JobsShell({ active, children }: { active: View; children: React.ReactNode }) {
  return <div className="jobsWorkspace jobsApp">
    <a className="jobsSkip" href="#jobs-content">Skip to content</a>
    <aside className="jobsSidebar" aria-label="Private job workspace navigation">
      <div className="jobsBrand"><span className="jobsBrandMark" aria-hidden="true">◆</span><div><strong>Job Desk</strong><small>Private workspace</small></div></div>
      <nav aria-label="Job Desk"><ul>{navigation.map((item) => <li key={item.id}><Link href={item.href} aria-current={active === item.id ? 'page' : undefined}>{item.label}</Link></li>)}</ul></nav>
      <p className="jobsSidebarNote">Your applications and résumé truths stay private.</p>
    </aside>
    <div className="jobsMainColumn">
      <div className="jobsTopbar"><span>Job Desk</span><span className="jobsPrivateBadge">Private · GitHub sign-in</span></div>
      <main id="jobs-content" className="jobsContent">{children}</main>
    </div>
  </div>;
}
