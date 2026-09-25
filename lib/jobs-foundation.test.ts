import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { canAccessJobs, configuredGithubAccountIds, privateJobsPath } from './jobs-access';
import { baselineResumeClaims, saveResumeTruth, seedResumeTruth } from './resume-truth';
import { isPrivateAnalyticsPath, outgoingEvent, safePath } from './analytics-policy';

test('jobs access requires a numeric GitHub account ID in the configured allowlist', () => {
  const allowlist = configuredGithubAccountIds(' 172521150, invalid,0042,, ');
  assert.equal(canAccessJobs('172521150', allowlist), true);
  assert.equal(canAccessJobs('42', allowlist), false);
  assert.equal(canAccessJobs('not-an-id', allowlist), false);
  assert.equal(canAccessJobs(undefined, allowlist), false);
  assert.equal(configuredGithubAccountIds(undefined).size, 0);
});

test('private jobs paths include nested pages and APIs', () => {
  assert.equal(privateJobsPath('/jobs'), true);
  assert.equal(privateJobsPath('/jobs/applications'), true);
  assert.equal(privateJobsPath('/api/jobs/resume-truth'), true);
  assert.equal(privateJobsPath('/resume'), false);
  assert.equal(isPrivateAnalyticsPath('/api/jobs/resume-truth'), true);
});

test('each private workspace view checks the GitHub account before reading records', async () => {
  const paths = ['leads/page.tsx', 'truths/page.tsx', 'settings/page.tsx', 'review/page.tsx', '[id]/page.tsx'];
  for (const path of paths) {
    const source = await readFile(new URL(`../app/jobs/${path}`, import.meta.url), 'utf8');
    assert.match(source, /await requireJobsAccount\(\)|await authorizedJobsAccount\(\)/, path);
  }
});

test('baseline claims retain source notes and start unreviewed', () => {
  const claims = baselineResumeClaims();
  assert.ok(claims.length > 40);
  assert.ok(claims.every((claim) => claim.reviewStatus === 'unreviewed' && claim.sourceNote.includes('lib/resume.ts')));
  assert.ok(claims.some((claim) => claim.id === 'experience.1.claim.1'));
});

test('seed inserts only missing claims and appends their initial versions', async () => {
  const statements: string[] = [];
  const fake = (async (strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return [];
  }) as unknown as NeonQueryFunction<false, false>;
  await seedResumeTruth(fake);
  assert.match(statements[0], /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(statements[0], /INSERT INTO resume_truth_versions/);
  assert.match(statements[0], /RETURNING id, claim, source_note, review_status/);
});

test('saving a claim upserts the current value and appends a version atomically', async () => {
  let statement = '';
  const fake = (async (strings: TemplateStringsArray) => {
    statement = strings.join('?');
    return [];
  }) as unknown as NeonQueryFunction<false, false>;
  await saveResumeTruth({ id: 'summary', claim: 'Updated', sourceNote: 'User reviewed', reviewStatus: 'reviewed' }, fake);
  assert.match(statement, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(statement, /INSERT INTO resume_truth_versions[\s\S]*SELECT id, claim, source_note, review_status FROM saved/);
});

test('analytics path sanitizer and event filter do not expose jobs paths or events', () => {
  assert.equal(safePath('/jobs'), '/other');
  assert.equal(safePath('/jobs/applications/private-name'), '/other');
  assert.equal(outgoingEvent({ event: '$pageview', uuid: 'id', timestamp: new Date(), properties: { pathname: '/jobs/private', token: 'x' } }, 'x'), null);
});
