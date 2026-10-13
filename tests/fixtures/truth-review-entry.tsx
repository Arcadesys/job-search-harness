import React from 'react';
import { createRoot } from 'react-dom/client';
import TruthEditor from '../../services/jobdesk/ui/truth-editor';
import JobsShell from '../../services/jobdesk/ui/jobs-shell';
import type { ReviewClaim } from '../../lib/resume-truth-review';

fetch('/api/jobs/resume-truth').then((response) => response.json()).then(({ claims }: { claims: ReviewClaim[] }) => {
  createRoot(document.getElementById('root')!).render(<JobsShell active="truths" truthReview><TruthEditor claims={claims} /></JobsShell>);
});
