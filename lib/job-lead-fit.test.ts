import assert from 'node:assert/strict';
import test from 'node:test';
import { leadFitPreview } from './job-lead-fit';

const lead = { title: 'AI Product Engineer', source: 'linkedin-email', sourceUrl: 'https://linkedin.com/jobs/view/4459916726', verificationStatus: 'unverified' };

test('email lead preview names a reviewed fact and marks title-only inference as preliminary', () => {
  const preview = leadFitPreview(lead, [
    { id: 'experience.1.claim.7', claim: 'Built Claude skills and Langfuse evaluation prompts', reviewStatus: 'reviewed' },
    { id: 'experience.1.claim.5', claim: 'Built an MCP-enabled operating artifact', reviewStatus: 'unreviewed' },
  ]);
  assert.equal(preview?.claimId, 'experience.1.claim.7');
  assert.match(preview?.reason ?? '', /hands-on AI building.*Built Claude skills/);
  assert.match(preview?.caution ?? '', /Preliminary title-based match only/);
});

test('email lead preview never uses unreviewed facts or implies an unsupported fit', () => {
  const preview = leadFitPreview(lead, [{ id: 'experience.1.claim.7', claim: 'Private unreviewed fact', reviewStatus: 'unreviewed' }]);
  assert.equal(preview?.claimId, undefined);
  assert.doesNotMatch(preview?.reason ?? '', /Private unreviewed fact/);
  assert.match(preview?.reason ?? '', /does not yet provide enough reviewed evidence/);
});

test('non-email leads do not get an email-fit preview', () => {
  assert.equal(leadFitPreview({ ...lead, source: 'google-alerts:ai-remote' }, []), null);
});
