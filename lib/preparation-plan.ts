/** A read-only decision over current, normalized domain state. No work is executed here. */
export interface PreparationStage {
  id: string;
  state: string;
  attempts: number;
}

export interface PreparationPlanInput {
  lead: { decision: string; applicationStage: string | null; verified: boolean };
  attemptState?: 'pending' | 'uncertain' | 'confirmed';
  activeBrief: boolean;
  pendingBrief: boolean;
  assessment?: PreparationStage;
  selection?: PreparationStage;
  material?: PreparationStage & { visual?: string };
  draftApproved: boolean;
  materialBlocker?: string;
  evaluation?: PreparationStage & { passed?: boolean };
  recruiter?: PreparationStage;
}

export type PreparationAction =
  | 'reconcile_submission' | 'complete' | 'skipped' | 'review_search_brief'
  | 'verify_posting' | 'assess' | 'choose_job' | 'select_claims' | 'build_materials'
  | 'wait_for_render' | 'repair_materials' | 'needs_attention' | 'review_materials'
  | 'evaluate_resume' | 'wait_for_evaluation' | 'review_recruiter'
  | 'approve_draft' | 'ready_for_user_submission';

export interface PreparationToolHint {
  name: 'job_hunt_get_work_packet' | 'job_hunt_build_materials' | 'job_hunt_review_materials' | 'job_hunt_evaluate_resume' | 'job_hunt_recruiter_packet';
  stage?: 'assessment' | 'selection';
  repair?: true;
}

export interface PreparationPlan {
  nextAction: PreparationAction;
  reason: string;
  /** The next preparation step can proceed without a new user decision. */
  canResume: boolean;
  /** A user decision or approval is needed before preparation can proceed. */
  approvalRequired: boolean;
  automaticSubmission: false;
  /** A bounded operation hint, never executable arguments or a submission tool. */
  toolHint?: PreparationToolHint;
}

function result(nextAction: PreparationAction, reason: string, canResume = false,
  approvalRequired = false, toolHint?: PreparationToolHint): PreparationPlan {
  return { nextAction, reason, canResume, approvalRequired, automaticSubmission: false,
    ...(toolHint ? { toolHint } : {}) };
}

function repairAvailable(attempts: number): boolean {
  return Number.isInteger(attempts) && attempts >= 0 && attempts < 2;
}

function stagePlan(stage: PreparationStage | undefined, kind: 'assessment' | 'selection'): PreparationPlan | undefined {
  const action = kind === 'assessment' ? 'assess' : 'select_claims';
  const hint: PreparationToolHint = { name: 'job_hunt_get_work_packet', stage: kind };
  if (!stage || stage.state === 'stale') {
    return result(action, `A current ${kind} is required; read a bounded work packet.`, true, false, hint);
  }
  if (stage.state === 'complete') return undefined;
  if (stage.state === 'pending' && repairAvailable(stage.attempts)) {
    return result(action, `Resume the saved ${kind} packet within its existing attempt limit.`, true, false, hint);
  }
  return result('needs_attention', `The ${kind} requires user attention; do not retry it automatically.`, false, true);
}

/**
 * The caller selects current input-version stages and the currently bound material.
 * Historical records must not be passed as current merely because they are newest.
 * Pending/uncertain attempts take precedence even over applied/pass and stale work.
 */
export function planPreparation(input: PreparationPlanInput): PreparationPlan {
  if (input.attemptState === 'pending' || input.attemptState === 'uncertain') {
    return result('reconcile_submission', 'Reconcile the existing submission attempt and its receipt before any preparation.', false, true);
  }
  if (input.attemptState === 'confirmed' || ['applied', 'interviewing', 'offer', 'closed'].includes(input.lead.applicationStage ?? '')) {
    return result('complete', 'This application is already submitted or beyond preparation; no preparation is needed.');
  }
  if (input.lead.decision === 'pass') return result('skipped', 'The user passed on this job.');
  if (input.pendingBrief && !input.activeBrief) {
    return result('review_search_brief', 'Review and approve the first search brief before using its criteria.', false, true);
  }
  if (!input.lead.verified) {
    return result('verify_posting', 'Verify the original posting before preparing application materials.', true);
  }
  const assessment = stagePlan(input.assessment, 'assessment');
  if (assessment) return assessment;
  if (input.lead.decision !== 'keep') {
    return result('choose_job', 'The user must choose this job before claim selection and material preparation.', false, true);
  }
  const selection = stagePlan(input.selection, 'selection');
  if (selection) return selection;
  if (input.materialBlocker) return result('needs_attention', input.materialBlocker, false, true);
  const material = input.material;
  if (!material || material.state === 'stale') {
    return result('build_materials', 'Build or reuse materials for the current selection.', true, false,
      { name: 'job_hunt_build_materials' });
  }
  if (material.state === 'pending') {
    return result('wait_for_render', 'A saved material render is in progress; do not start another build.');
  }
  if (material.state === 'needs_attention' || (material.state === 'current' && material.visual === 'failed')) {
    if (repairAvailable(material.attempts)) {
      return result('repair_materials', 'One targeted material repair remains within the existing attempt limit.', true, false,
        { name: 'job_hunt_build_materials', repair: true });
    }
    return result('needs_attention', 'Material repair is exhausted or its attempt count is invalid; user attention is required.', false, true);
  }
  if (material.state !== 'current') {
    return result('needs_attention', 'The material state is not recognized; inspect it before continuing.', false, true);
  }
  if (material.visual !== 'passed') {
    return result('review_materials', 'Inspect the actual rendered files before recording their visual review.', true, false,
      { name: 'job_hunt_review_materials' });
  }
  const evaluation = input.evaluation;
  if (!evaluation || evaluation.state === 'stale') return result('evaluate_resume', 'Run deterministic checks against the exact saved résumé.', true, false, { name: 'job_hunt_evaluate_resume' });
  if (evaluation.state === 'pending') return result('wait_for_evaluation', 'A saved evaluation is in progress; do not duplicate it.');
  if (evaluation.state !== 'complete' || evaluation.passed !== true) return result('needs_attention', 'Résumé evaluation failed or is incomplete. Inspect its findings before continuing.', false, true);
  if (!input.recruiter || input.recruiter.state === 'stale' || (input.recruiter.state === 'pending' && repairAvailable(input.recruiter.attempts)))
    return result('review_recruiter', 'Record an evidence-cited advisory recruiter review of the evaluated artifact.', true, false, { name: 'job_hunt_recruiter_packet' });
  if (input.recruiter.state !== 'complete') return result('needs_attention', 'Advisory review needs attention; it has no authority to approve or reject an application.', false, true);
  if (!input.draftApproved) {
    return result('approve_draft', 'The user must approve the current draft and its bound materials.', false, true);
  }
  return result('ready_for_user_submission', 'Preparation is complete. The user may submit; this planner never submits.');
}
