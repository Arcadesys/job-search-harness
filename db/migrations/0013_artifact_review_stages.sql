ALTER TABLE job_work_stages DROP CONSTRAINT job_work_stages_stage_check;
ALTER TABLE job_work_stages ADD CONSTRAINT job_work_stages_stage_check
  CHECK(stage IN ('assessment','selection','resume_evaluation','recruiter_review'));
