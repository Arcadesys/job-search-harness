import React from 'react';
import { createRoot } from 'react-dom/client';
import TruthEditor from '../../app/jobs/truth-editor';
import JobsShell from '../../app/jobs/jobs-shell';
import type { ReviewClaim } from '../../lib/resume-truth-review';

fetch('/api/jobs/resume-truth').then((response) => response.json()).then(({ claims }: { claims: ReviewClaim[] }) => {
  createRoot(document.getElementById('root')!).render(<JobsShell active="truths" truthReview><TruthEditor claims={claims} /></JobsShell>);
});
