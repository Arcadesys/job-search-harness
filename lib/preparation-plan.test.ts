import test from 'node:test';
import assert from 'node:assert/strict';
import { planPreparation, type PreparationPlanInput, type PreparationAction } from './preparation-plan';

const complete = (id: string) => ({ id, state: 'complete', attempts: 1 });
const ready = (): PreparationPlanInput => ({
  lead: { decision: 'keep', applicationStage: 'ready', verified: true },
  activeBrief: true, pendingBrief: false,
  assessment: complete('assessment'), selection: complete('selection'),
  material: { id: 'material', state: 'current', attempts: 1, visual: 'passed' },
  evaluation: { ...complete('evaluation'), passed: true }, recruiter: complete('recruiter'),
  draftApproved: true,
});

function expectAction(input: PreparationPlanInput, action: PreparationAction) {
  const plan = planPreparation(input);
  assert.equal(plan.nextAction, action);
  assert.equal(plan.automaticSubmission, false);
  assert.ok(plan.reason.length > 0);
  return plan;
}

test('submission reconciliation outranks terminal states and every preparation gate', () => {
  for (const attemptState of ['pending', 'uncertain'] as const) {
    const input = ready();
    Object.assign(input, { attemptState, activeBrief: false, pendingBrief: true, assessment: undefined });
    input.lead = { decision: 'pass', applicationStage: 'applied', verified: false };
    const plan = expectAction(input, 'reconcile_submission');
    assert.equal(plan.canResume, false);
    assert.equal(plan.approvalRequired, true);
    assert.equal(plan.toolHint, undefined);
  }
});

test('confirmed submissions and already-applied leads are terminal, including passed leads', () => {
  for (const attemptState of [undefined, 'confirmed'] as const) {
    const input = ready();
    input.attemptState = attemptState;
    input.lead = { decision: 'pass', applicationStage: attemptState ? null : 'applied', verified: false };
    input.pendingBrief = true;
    input.activeBrief = false;
    assert.equal(expectAction(input, 'complete').canResume, false);
  }
});

test('pass skips missing brief, verification, and missing work', () => {
  const input = ready();
  input.lead.decision = 'pass';
  input.lead.verified = false;
  input.assessment = undefined;
  input.activeBrief = false;
  input.pendingBrief = true;
  expectAction(input, 'skipped');
});

test('first brief requires approval, new pending version leaves active brief usable, legacy no-brief remains usable', () => {
  for (const activeBrief of [false, true]) for (const pendingBrief of [false, true]) {
    const input = { ...ready(), activeBrief, pendingBrief };
    input.lead.verified = false;
    const plan = expectAction(input, pendingBrief && !activeBrief ? 'review_search_brief' : 'verify_posting');
    assert.equal(plan.approvalRequired, pendingBrief && !activeBrief);
  }
});

test('posting verification precedes assessment, selection, material work and old approval', () => {
  const input = ready();
  input.lead.verified = false;
  input.assessment = undefined;
  input.material = { id: 'old', state: 'needs_attention', attempts: 1 };
  expectAction(input, 'verify_posting');
});

for (const kind of ['assessment', 'selection'] as const) {
  test(`${kind} resumes bounded pending work, refreshes stale work, and stops on attention or exhausted attempts`, () => {
    const cases = [
      { state: undefined, attempts: 0, blocked: false },
      { state: 'stale', attempts: 2, blocked: false },
      { state: 'pending', attempts: 0, blocked: false },
      { state: 'pending', attempts: 1, blocked: false },
      { state: 'pending', attempts: 2, blocked: true },
      { state: 'pending', attempts: -1, blocked: true },
      { state: 'pending', attempts: NaN, blocked: true },
      { state: 'needs_attention', attempts: 0, blocked: true },
      { state: 'needs_attention', attempts: 2, blocked: true },
      { state: 'unknown', attempts: 0, blocked: true },
    ];
    for (const row of cases) {
      const input = ready();
      input[kind] = row.state === undefined ? undefined : { id: kind, state: row.state, attempts: row.attempts };
      const plan = expectAction(input, row.blocked ? 'needs_attention' : kind === 'assessment' ? 'assess' : 'select_claims');
      assert.equal(plan.canResume, !row.blocked);
      assert.equal(plan.approvalRequired, row.blocked);
      assert.deepEqual(plan.toolHint, row.blocked ? undefined : { name: 'job_hunt_get_work_packet', stage: kind });
    }
  });
}

test('assessment precedes user job choice, which precedes selection', () => {
  const input = ready();
  input.lead.decision = 'review';
  input.assessment = undefined;
  input.selection = undefined;
  expectAction(input, 'assess');
  input.assessment = complete('assessment');
  assert.equal(expectAction(input, 'choose_job').approvalRequired, true);
  input.lead.decision = 'keep';
  expectAction(input, 'select_claims');
});

test('stage invalidation outranks otherwise ready materials without mutating artifacts', () => {
  const input = ready();
  const savedMaterial = structuredClone(input.material);
  input.assessment!.state = 'stale';
  expectAction(input, 'assess');
  input.assessment!.state = 'complete';
  input.selection!.state = 'stale';
  expectAction(input, 'select_claims');
  assert.deepEqual(input.material, savedMaterial);
});

test('missing and stale materials build; pending render never starts duplicate work', () => {
  for (const state of [undefined, 'stale', 'pending']) {
    const input = ready();
    input.material = state ? { id: 'material', state, attempts: 1 } : undefined;
    const plan = expectAction(input, state === 'pending' ? 'wait_for_render' : 'build_materials');
    assert.equal(plan.canResume, state !== 'pending');
    assert.deepEqual(plan.toolHint, state === 'pending' ? undefined : { name: 'job_hunt_build_materials' });
  }
});

test('material repair has a hard two-attempt limit and rejects malformed counters', () => {
  for (const attempts of [0, 1, 2, 3, -1, 0.5, NaN, Infinity]) {
    for (const state of ['needs_attention', 'current']) {
      const input = ready();
      input.material = { id: 'material', state, attempts, visual: 'failed' };
      const repair = attempts === 0 || attempts === 1;
      const plan = expectAction(input, repair ? 'repair_materials' : 'needs_attention');
      assert.equal(plan.canResume, repair);
      assert.deepEqual(plan.toolHint, repair ? { name: 'job_hunt_build_materials', repair: true } : undefined);
    }
  }
});

test('unknown material state fails closed instead of accepting historical draft approval', () => {
  const input = ready();
  input.material!.state = 'unknown';
  expectAction(input, 'needs_attention');
});

test('rendered inspection precedes draft approval and never treats inspection as submission approval', () => {
  const input = ready();
  for (const visual of [undefined, 'pending', 'not_reviewed', 'unknown']) {
    input.material!.visual = visual;
    const plan = expectAction(input, 'review_materials');
    assert.equal(plan.approvalRequired, false);
    assert.deepEqual(plan.toolHint, { name: 'job_hunt_review_materials' });
  }
  input.material!.visual = 'passed';
  input.draftApproved = false;
  assert.equal(expectAction(input, 'approve_draft').approvalRequired, true);
  input.draftApproved = true;
  const plan = expectAction(input, 'ready_for_user_submission');
  assert.equal(plan.canResume, false);
  assert.equal(plan.toolHint, undefined);
});

test('planner is deterministic, read-only, isolated across jobs and independent of prior invocations', () => {
  const a = ready();
  const before = structuredClone(a);
  Object.freeze(a.lead);
  Object.freeze(a.assessment);
  Object.freeze(a.selection);
  Object.freeze(a.material);
  Object.freeze(a.evaluation);
  Object.freeze(a.recruiter);
  Object.freeze(a);
  const expected = planPreparation(a);
  const b = ready();
  b.attemptState = 'uncertain';
  for (let index = 0; index < 20; index++) {
    expectAction(b, 'reconcile_submission');
    assert.deepEqual(planPreparation(a), expected);
  }
  assert.deepEqual(a, before);
  const changedResult = planPreparation(a);
  changedResult.reason = 'caller-owned';
  assert.deepEqual(planPreparation(a), expected);
});

for (const applicationStage of ['applied', 'interviewing', 'offer', 'closed']) {
  test(`${applicationStage} is terminal before brief, verification and preparation, but after reconciliation`, () => {
    const input = ready();
    input.lead = { decision: 'pass', applicationStage, verified: false };
    input.activeBrief = false;
    input.pendingBrief = true;
    input.assessment = undefined;
    input.selection = undefined;
    input.material = undefined;
    input.draftApproved = false;
    const plan = expectAction(input, 'complete');
    assert.equal(plan.canResume, false);
    assert.equal(plan.approvalRequired, false);
    assert.equal(plan.toolHint, undefined);
    for (const attemptState of ['pending', 'uncertain'] as const) {
      input.attemptState = attemptState;
      expectAction(input, 'reconcile_submission');
    }
  });
}


test('missing and stale evaluations run only after visual inspection, despite prior draft approval', () => {
  for (const evaluation of [undefined, { id: 'evaluation', state: 'stale', attempts: 2, passed: true }]) {
    const input = { ...ready(), evaluation };
    input.material!.visual = 'pending';
    expectAction(input, 'review_materials');
    input.material!.visual = 'passed';
    const plan = expectAction(input, 'evaluate_resume');
    assert.equal(plan.canResume, true);
    assert.equal(plan.approvalRequired, false);
    assert.deepEqual(plan.toolHint, { name: 'job_hunt_evaluate_resume' });
  }
});

test('pending evaluation waits without duplicating work or advancing advisory review', () => {
  for (const attempts of [0, 1, 2]) {
    const input = ready();
    input.evaluation = { id: 'evaluation', state: 'pending', attempts, passed: true };
    input.recruiter = undefined;
    const plan = expectAction(input, 'wait_for_evaluation');
    assert.equal(plan.canResume, false);
    assert.equal(plan.approvalRequired, false);
    assert.equal(plan.toolHint, undefined);
  }
});

test('failed, incomplete and unrecognized evaluations fail closed before advisory and user approval', () => {
  for (const state of ['complete', 'needs_attention', 'unknown']) {
    for (const passed of [undefined, false, true]) {
      if (state === 'complete' && passed === true) continue;
      const input = ready();
      input.evaluation = { id: 'evaluation', state, attempts: 1, passed };
      input.recruiter = undefined;
      const plan = expectAction(input, 'needs_attention');
      assert.equal(plan.canResume, false);
      assert.equal(plan.approvalRequired, true);
      assert.equal(plan.toolHint, undefined);
    }
  }
});

test('advisory review resumes missing, stale and bounded pending work; exhausted and invalid states stop', () => {
  const cases = [
    { state: undefined, attempts: 0, resumable: true },
    { state: 'stale', attempts: 2, resumable: true },
    { state: 'pending', attempts: 0, resumable: true },
    { state: 'pending', attempts: 1, resumable: true },
    ...[2, 3, -1, 0.5, NaN, Infinity].map((attempts) => ({ state: 'pending', attempts, resumable: false })),
    { state: 'needs_attention', attempts: 0, resumable: false },
    { state: 'unknown', attempts: 0, resumable: false },
  ];
  for (const row of cases) {
    const input = ready();
    input.recruiter = row.state ? { id: 'recruiter', state: row.state, attempts: row.attempts } : undefined;
    const plan = expectAction(input, row.resumable ? 'review_recruiter' : 'needs_attention');
    assert.equal(plan.canResume, row.resumable);
    assert.equal(plan.approvalRequired, !row.resumable);
    assert.deepEqual(plan.toolHint, row.resumable ? { name: 'job_hunt_recruiter_packet' } : undefined);
  }
});

test('passing evaluation and completed advisory review cannot supply human draft approval', () => {
  const input = ready();
  input.draftApproved = false;
  input.recruiter = undefined;
  expectAction(input, 'review_recruiter');
  input.recruiter = complete('recruiter');
  const approval = expectAction(input, 'approve_draft');
  assert.equal(approval.approvalRequired, true);
  assert.equal(approval.canResume, false);
  assert.equal(approval.toolHint, undefined);
  input.draftApproved = true;
  expectAction(input, 'ready_for_user_submission');
});

test('submission reconciliation, terminal states and human choices outrank missing artifact reviews', () => {
  const input = ready();
  input.evaluation = undefined;
  input.recruiter = undefined;
  input.draftApproved = false;
  for (const attemptState of ['pending', 'uncertain'] as const) {
    input.attemptState = attemptState;
    expectAction(input, 'reconcile_submission');
  }
  input.attemptState = 'confirmed';
  expectAction(input, 'complete');
  input.attemptState = undefined;
  input.lead.decision = 'pass';
  expectAction(input, 'skipped');
  input.lead.decision = 'review';
  assert.equal(expectAction(input, 'choose_job').approvalRequired, true);
  input.pendingBrief = true;
  input.activeBrief = false;
  assert.equal(expectAction(input, 'review_search_brief').approvalRequired, true);
});
