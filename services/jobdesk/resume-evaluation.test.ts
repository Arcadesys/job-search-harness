import assert from 'node:assert/strict';
import test from 'node:test';
import { runResumeOutputEvaluation } from '../../scripts/evals/resume-output';

const fixtures = runResumeOutputEvaluation();

test('saved employer PDFs match independent goldens and preserve all labelled evidence without granting approval', async () => {
  const cases = await fixtures;
  assert.equal(cases.length, 3);
  for (const { id, report } of cases) {
    assert.equal(report.passed, true, `${id}: ${JSON.stringify(report.issues)}`);
    assert.equal(report.coverage.coverage, 1);
    assert.equal(report.falseExclusion, false);
  }
  const gaps = cases.reduce((sum, c) => sum + c.report.coverage.unsupportedRequirements, 0);
  assert.equal(gaps, 2, 'unproven credentials remain gaps, not generated résumé claims');
});
