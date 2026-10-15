import { runResumeOutputEvaluation } from './evals/resume-output';
async function main() {
const cases = await runResumeOutputEvaluation();
const summary = {
  schemaVersion: 1, fixtureCount: cases.length, passed: cases.filter((c) => c.report.passed).length,
  failed: cases.filter((c) => !c.report.passed).length,
  networkCalls: 0, modelCalls: 0, providerCost: 0,
  cases: cases.map(({ id, report, shortlistBaseline }) => ({ id, ...report, shortlistBaseline })),
  note: 'Hand-labelled selections test output integrity. Shortlist baseline is lexical top-eight evidence coverage, not model performance. No recruiter judgment or approval was performed.',
};
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;

}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "Evaluation failed"); process.exitCode = 1; });
