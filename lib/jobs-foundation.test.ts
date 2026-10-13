import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from './job-storage';
import { baselineResumeClaims, saveResumeTruth, seedResumeTruth } from './resume-truth';

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
  }) as unknown as Sql;
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
  }) as unknown as Sql;
  await saveResumeTruth({ id: 'summary', claim: 'Updated', sourceNote: 'User reviewed', reviewStatus: 'reviewed' }, fake);
  assert.match(statement, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(statement, /INSERT INTO resume_truth_versions[\s\S]*SELECT id, claim, source_note, review_status FROM saved/);
});

