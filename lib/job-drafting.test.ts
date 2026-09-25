import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateLunaCost, MONTHLY_AI_BUDGET_USD, renderTruthGroundedDraft, supportedClaimIds } from './job-drafting';

test('draft citations can reference reviewed truth claims only', () => {
  const claims = [
    { id: 'approved', claim: 'Fact', sourceNote: 'Source', reviewStatus: 'reviewed' as const },
    { id: 'pending', claim: 'Maybe', sourceNote: 'Source', reviewStatus: 'unreviewed' as const },
  ];
  assert.deepEqual(supportedClaimIds(['approved', 'pending', 'invented', 'approved'], claims), ['approved']);
});

test('generated application copy contains exact reviewed claim text only', () => {
  const claims = [
    { id: 'approved', claim: 'Built accessible review tooling.', sourceNote: 'Portfolio', reviewStatus: 'reviewed' as const },
    { id: 'pending', claim: 'Managed a team of 20.', sourceNote: 'Unverified', reviewStatus: 'unreviewed' as const },
  ];
  const draft = renderTruthGroundedDraft(claims, 'Engineer', 'Acme');
  assert.match(draft.resumeVariant, /Built accessible review tooling\. \[approved\]/);
  assert.doesNotMatch(draft.resumeVariant, /team of 20/);
  assert.match(draft.outreach, /Built accessible review tooling\. \[approved\]/);
  assert.doesNotMatch(draft.outreach, /team of 20/);
});

test('GPT-6 Luna estimate uses current standard text input and output rates', () => {
  assert.equal(estimateLunaCost(1_000_000, 1_000_000), 0.6);
  assert.equal(MONTHLY_AI_BUDGET_USD, 8.5);
});
