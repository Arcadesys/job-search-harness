import { evaluateArtifact, recruiterPacket, saveRecruiterReview, readArtifactReviews } from './artifact-review';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parameterizedSql, type Sql } from '../../lib/job-storage';
import * as truths from '../../lib/resume-truth';
import * as discovery from '../../lib/job-discovery';
import * as drafting from '../../lib/job-drafting';
import * as queue from '../../lib/job-queue';
import * as review from '../../lib/jobs-review';
import { methodSchemas, rpcSchema } from './contract';
import * as leases from './queue';
import { createReviewPacket } from './artifacts';
import { bootstrap, privateBootstrap } from './bootstrap';
import type { JobdeskStore } from './store';
import { readSubmissionDraft } from './submission-draft';
import { JobdeskError } from './errors';
import { saveManualDraft } from './manual-draft';
import { draftingModel, readSettings, readTimeZone, saveSettings } from '../../lib/jobdesk-settings';
import { openaiProvider } from '../../lib/drafting-openai';
import { anthropicProvider } from '../../lib/drafting-anthropic';
import { apiKeyFor, apiKeyStatus, saveApiKey } from './secrets';
import * as workflow from '../../lib/job-workflow';
import { runCollection, collectionStatus } from '../../lib/job-collection';
import * as briefs from '../../lib/search-brief-store';
import { preparationPlan } from './preparation';
import { buildMaterials, reviewMaterials } from './materials';
import * as cockpit from './cockpit';
import { assistantStatus, connectAssistant } from './assistants';

export const LOCAL_OWNER = 'local-user';

/** Import messages are written for the person importing; let them through. */
async function userFacing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new JobdeskError('IMPORT_REJECTED', error instanceof Error ? error.message : 'Import failed.');
  }
}
function operation<S extends z.ZodType>(
  schema: S,
  handler: (args: z.infer<S>, sql: Sql) => Promise<unknown>,
) {
  return (args: unknown, sql: Sql) => handler(schema.parse(args), sql);
}

export async function initializeService(store: JobdeskStore) {
  await store.run(async (sql) => {
    await bootstrap(sql, await privateBootstrap(store.root));
    await sql`WITH interrupted AS (UPDATE jobdesk_submission_attempts SET state='uncertain',note='Database owner restarted; reconcile before further action.',updated_at=now()
      WHERE state='pending' RETURNING item_id)
      UPDATE job_application_batch_items i SET status='blocked',lease_worker=NULL,lease_expires_at=NULL,note='Submission uncertain after restart.'
        FROM interrupted WHERE i.id=interrupted.item_id AND i.status<>'submitted'`;
    await sql`UPDATE job_search_runs SET status='failed',error_message='Jobdesk restarted during scan; retry manually.',completed_at=now() WHERE status='running'`;
    await sql`UPDATE job_collection_runs SET state='partial',errors=errors || '["Owner restarted; resume saved pending targets."]'::jsonb,updated_at=now() WHERE state='running'`;
    await sql`UPDATE job_work_stages SET state='needs_attention',error='Owner restarted during evaluation; retry explicitly.' WHERE stage='resume_evaluation' AND state='pending'`;
    await sql`UPDATE job_material_manifests SET state='needs_attention',error='Owner restarted during rendering; one targeted repair is available.' WHERE state='pending'`;
    await sql`WITH interrupted AS (UPDATE jobdesk_model_runs SET state='interrupted' WHERE state='pending' RETURNING usage_month)
      UPDATE job_ai_usage SET estimated_usd=budget_usd,unknown_cost_requests=unknown_cost_requests+1
      WHERE usage_month IN (SELECT usage_month FROM interrupted)`;
  });
}

export function createService(store: JobdeskStore, options: { trustedUserActions?: boolean } = {}) {
  const schemas = methodSchemas;
  /** null when the user has not turned on drafting or has no key for the chosen provider. */
  const assessmentProvider = async (sql: Sql) => {
    const { drafting } = await readSettings(sql);
    if (drafting.provider === 'none') return null;
    const key = await apiKeyFor(store.root, drafting.provider);
    if (!key) return null;
    const model = draftingModel(drafting);
    return drafting.provider === 'openai' ? openaiProvider(key, model) : anthropicProvider(key, model);
  };
  const operations = {
    'brief.read': operation(schemas['brief.read'], (_, sql) => briefs.readBriefState(sql)),
    'brief.addMessage': operation(schemas['brief.addMessage'], ([input], sql) => briefs.appendBriefMessage(input, sql)),
    'brief.propose': operation(schemas['brief.propose'], ([input], sql) => briefs.saveBriefProposal(input, sql)),
    'brief.cancelDraft': operation(schemas['brief.cancelDraft'], ([input], sql) => briefs.cancelBriefDraft(input, sql)),
    'brief.approve': operation(schemas['brief.approve'], async ([input], sql) => {
      const result = await briefs.activateBrief(input, sql);
      if (!result.reused) {
        const leads = await sql`SELECT id FROM job_leads`;
        for (const lead of leads) await workflow.refreshWorkflow(lead.id, sql);
      }
      return result;
    }),
    'reviews.read': operation(schemas['reviews.read'], ([input], sql) => readArtifactReviews(input.leadId, sql, store.root)),
    'recruiter.packet': operation(schemas['recruiter.packet'], ([input], sql) => recruiterPacket(input, sql, store.root)),
    'recruiter.save': operation(schemas['recruiter.save'], ([input], sql) => saveRecruiterReview(input, sql, store.root)),
    'preparation.plan': operation(schemas['preparation.plan'], ([input], sql) => preparationPlan(input.leadId, sql, store.root)),
    'collection.run': operation(schemas['collection.run'], () => { throw new Error('Collection must run outside the store queue.'); }),
    'workflow.build': operation(schemas['workflow.build'], () => { throw new Error('Rendering must run outside the store queue.'); }),
    'collection.status': operation(schemas['collection.status'], (_, sql) => collectionStatus(sql)),
    'workflow.settings': operation(schemas['workflow.settings'], (_, sql) => workflow.workflowSettings(sql)),
    'workflow.configure': operation(schemas['workflow.configure'], async ([settings], sql) => {
      const saved = await workflow.saveWorkflowSettings(settings, sql);
      const leads = await sql`SELECT id FROM job_leads`;
      for (const lead of leads) { await workflow.refreshWorkflow(lead.id, sql); await workflow.applyExplicitFilters(lead.id, sql); }
      return saved;
    }),
    'workflow.packet': operation(schemas['workflow.packet'], ([input], sql) => workflow.getWorkPacket(input.leadId, input.stage, sql, input.revision)),
    'workflow.save': operation(schemas['workflow.save'], ([input], sql) => workflow.saveWorkResult(input.packetId, input.inputHash, input.result, sql)),
    'workflow.claims': operation(schemas['workflow.claims'], ([input], sql) => workflow.lookupClaims(input, sql)),
    'workflow.sources': operation(schemas['workflow.sources'], async ([ids], sql) => {
      const claims = await truths.listResumeTruth(sql);
      return { claims: ids.map((id) => { const claim = claims.find((c) => c.id === id && c.reviewStatus === 'reviewed');
        if (!claim) throw new JobdeskError('WORKFLOW_REJECTED', 'Claim missing or not reviewed.');
        return { id, sourceNote: claim.sourceNote, version: claim.version }; }) };
    }),
    'workflow.posting': operation(schemas['workflow.posting'], ([input], sql) => workflow.readPosting(input.leadId, input.offset, input.postingHash, sql)),
    'workflow.savePosting': operation(schemas['workflow.savePosting'], async ([input], sql) => {
      await drafting.saveOriginalPosting(input.leadId, input.text, input.sourceNote, sql, 'assistant');
      return { saved: true, verifiedBy: 'assistant', userVerificationClaimed: false };
    }),
    'workflow.status': operation(schemas['workflow.status'], ([input], sql) => workflow.workflowStatus(input.leadId, sql)),
    'workflow.jobs': operation(schemas['workflow.jobs'], ([input], sql) => workflow.listWorkflowJobs(input, sql)),
    'workflow.review': operation(schemas['workflow.review'], ([input], sql) => reviewMaterials(input, sql, store.root)),
    'exclusions.list': operation(schemas['exclusions.list'], (args, sql) => workflow.listExclusions(sql, args[0]?.offset ?? 0)),
    'exclusions.restore': operation(schemas['exclusions.restore'], ([id], sql) => workflow.restoreExclusion(id, sql)),
    health: operation(schemas.health, async (_, sql) => ({
      ok: true,
      runtime: 'PGlite 0.5.8',
      migrations: await sql`SELECT version FROM jobdesk_migrations ORDER BY version`,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    })),
    'truth.list': operation(schemas['truth.list'], (_, sql) => truths.listResumeTruth(sql)),
    'truth.versions': operation(schemas['truth.versions'], ([id], sql) =>
      truths.listResumeTruthVersions(id, sql),
    ),
    'truth.review': operation(schemas['truth.review'], ({ 0: input }, sql) =>
      truths.reviewResumeTruth(input.changes, sql),
    ),
    'truth.addProject': operation(schemas['truth.addProject'], ([input], sql) =>
      truths.addProjectTruth(input, sql),
    ),
    'truth.importResume': operation(schemas['truth.importResume'], ([input], sql) =>
      userFacing(() => truths.importResume(input, sql)),
    ),
    'truth.importText': operation(schemas['truth.importText'], ([text, note], sql) =>
      userFacing(() => truths.importResumeText(text, note, sql)),
    ),
    'leads.list': operation(schemas['leads.list'], (_, sql) => discovery.listLeads(sql)),
    'leads.add': operation(schemas['leads.add'], ([input], sql) =>
      discovery.saveManualLead(input, sql),
    ),
    'leads.update': operation(schemas['leads.update'], ([input], sql) =>
      discovery.updateLead(input, sql),
    ),
    'leads.import': operation(schemas['leads.import'], ([input], sql) =>
      discovery.ingestLinkedInEmailLeads(input, sql),
    ),
    'search.settings': operation(schemas['search.settings'], async (_, sql) => ({
      queries: await discovery.listSearchQueries(sql),
      status: await discovery.listSearchStatus(sql),
      reports:
        await sql`SELECT id,organization,external_job_id AS "externalJobId",state,reported_on AS "reportedOn",source_note AS "sourceNote" FROM jobdesk_user_reports ORDER BY id`,
    })),
    'search.save': operation(schemas['search.save'], ([input], sql) =>
      discovery.saveSearchQueries(input, sql),
    ),
    'search.run': operation(schemas['search.run'], (_, sql) => discovery.runDailySearch({ sql })),
    'draft.read': operation(schemas['draft.read'], async ([id], sql) => ({
      lead: await drafting.getDraftingLead(id, sql),
      history: await drafting.listDraftingHistory(id, sql),
      approval: (
        await sql`SELECT review_status AS "reviewStatus",updated_at::text AS version,material_manifest_id AS "materialManifestId" FROM job_application_drafts WHERE lead_id=${id}`
      )[0],
      usage: await drafting.currentAiUsage(sql),
    })),
    'draft.posting': operation(schemas['draft.posting'], ([id, text, note], sql) =>
      drafting.saveOriginalPosting(id, text, note, sql),
    ),
    'draft.assess': operation(schemas['draft.assess'], async ([id], sql) => {
      const [bound] = await sql`SELECT material_manifest_id FROM job_application_drafts WHERE lead_id=${id}`;
      if (bound?.material_manifest_id) throw new JobdeskError('WORKFLOW_REJECTED', 'Use a current selection packet to revise these prepared materials.');
      const runId = randomUUID();
      await sql`UPDATE job_application_drafts SET review_status='review_required' WHERE lead_id=${id}`;
      await sql`UPDATE jobdesk_artifacts SET approval_state='superseded' WHERE lead_id=${id}`;
      await sql`INSERT INTO jobdesk_model_runs(id,usage_month,state) VALUES(${runId},date_trunc('month',now())::date,'pending')`;
      try {
        return await drafting.assessAndDraft(id, sql, await assessmentProvider(sql));
      } finally {
        await sql`UPDATE jobdesk_model_runs SET state='finished' WHERE id=${runId}`;
      }
    }),
    'draft.edit': operation(schemas['draft.edit'], async ([id, resume, outreach], sql) => {
      await drafting.saveDraftEdits(id, resume, outreach, sql);
      await sql`UPDATE job_application_drafts SET review_status='review_required' WHERE lead_id=${id}`;
      await sql`UPDATE jobdesk_artifacts SET approval_state='superseded' WHERE lead_id=${id}`;
    }),
    'draft.saveManual': operation(schemas['draft.saveManual'], ([input], sql) => saveManualDraft(input, sql)),
    'draft.approve': operation(schemas['draft.approve'], async ([id, version], sql) => {
      const [current] = await sql`SELECT lead_id,material_manifest_id FROM job_application_drafts WHERE lead_id=${id}`;
      if (current) await workflow.assertCurrentMaterial(current, sql, store.root);
      const rows = await sql`UPDATE job_application_drafts d SET review_status='approved'
        WHERE lead_id=${id} AND updated_at::text=${version} AND jsonb_array_length(d.truth_snapshot)>0 AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(d.truth_snapshot) s LEFT JOIN resume_truth_claims c ON c.id=s->>'id'
          WHERE c.id IS NULL OR c.review_status<>'reviewed' OR c.claim IS DISTINCT FROM s->>'claim' OR c.source_note IS DISTINCT FROM s->>'sourceNote'
            OR c.updated_at::text IS DISTINCT FROM s->>'version'
        ) RETURNING id`;
      if (!rows[0]) throw new Error('Draft changed or its truth snapshot needs renewed review.');
      if (current?.material_manifest_id) await sql`UPDATE jobdesk_artifacts SET approval_state='approved' WHERE id IN
        (SELECT (x->>'id')::uuid FROM job_material_manifests m,jsonb_array_elements(m.artifacts) x WHERE m.id=${current.material_manifest_id})`;
      return { approved: true };
    }),
    'draft.pdf': operation(schemas['draft.pdf'], ([id], sql) =>
      createReviewPacket(store.root, id, sql),
    ),
    'batches.list': operation(schemas['batches.list'], async (_, sql) => {
      const batches = await queue.listApplicationBatches(LOCAL_OWNER, sql);
      return { selectedBatchId: batches.find((batch) => batch.isSelected)?.id ?? null, batches };
    }),
    'batches.create': operation(schemas['batches.create'], async ([ids], sql) => {
      const blocked = await sql`SELECT l.id FROM job_leads l WHERE l.id=ANY(${ids}) AND (
        EXISTS(SELECT 1 FROM jobdesk_user_reports r WHERE r.state='user_reported_submitted' AND r.external_job_id<>'' AND position(lower(r.external_job_id) in lower(l.source_url))>0)
        OR EXISTS(SELECT 1 FROM job_application_batch_items i JOIN jobdesk_submission_attempts a ON a.item_id=i.id
          WHERE i.lead_id=l.id AND a.state IN ('pending','uncertain','confirmed')))`;
      if (blocked.length)
        throw new Error(
          'A selected role was already reported submitted or requires reconciliation.',
        );
      return queue.createApplicationBatch(LOCAL_OWNER, ids, sql);
    }),
    'batches.select': operation(schemas['batches.select'], ([id], sql) =>
      queue.selectApplicationBatch(LOCAL_OWNER, id, sql),
    ),
    'batches.items': operation(schemas['batches.items'], async ([id], sql) => ({
      items: await queue.listApplicationBatchItems(LOCAL_OWNER, id, sql),
    })),
    'items.read': operation(schemas['items.read'], async ([id], sql) => {
      const item = await queue.readApplicationBatchItem(LOCAL_OWNER, id, sql);
      const draft = await readSubmissionDraft(LOCAL_OWNER, id, sql);
      return {
        item: item && { ...item, draftVersion: draft?.draftVersion ?? null,
          draftHash: draft?.draftHash ?? null, draftReviewStatus: draft?.draftReviewStatus ?? null },
        attempts:
          await sql`SELECT id,state,note,worker_id AS "workerId",lease_generation::text AS generation,draft_version AS "draftVersion",draft_hash AS "draftHash",created_at AS "createdAt" FROM jobdesk_submission_attempts WHERE item_id=${id} AND owner_id=${LOCAL_OWNER} ORDER BY created_at DESC`,
      };
    }),
    'items.claim': operation(schemas['items.claim'], async ([input], sql) => {
      const claimed = await leases.claimItem(LOCAL_OWNER, input, sql);
      const draft = await readSubmissionDraft(LOCAL_OWNER, input.itemId, sql);
      return { ...claimed, draftVersion: draft?.draftVersion ?? null,
        draftHash: draft?.draftHash ?? null, draftReviewStatus: draft?.draftReviewStatus ?? null };
    }),
    'items.renew': operation(schemas['items.renew'], ([input], sql) =>
      leases.renewLease(LOCAL_OWNER, input, sql),
    ),
    'items.status': operation(schemas['items.status'], ([input], sql) =>
      leases.leaseStatus(LOCAL_OWNER, input, sql),
    ),
    'items.requeue': operation(schemas['items.requeue'], async ([id, note], sql) => {
      const rows =
        await sql`UPDATE job_application_batch_items i SET status='queued',note=${note},lease_worker=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE i.id=${id} AND i.owner_id=${LOCAL_OWNER} AND i.status IN ('blocked','skipped')
          AND EXISTS(SELECT 1 FROM job_leads l WHERE l.id=i.lead_id AND l.application_stage IS DISTINCT FROM 'applied')
          AND NOT EXISTS(SELECT 1 FROM jobdesk_submission_attempts a WHERE a.item_id=i.id AND a.state IN ('pending','uncertain','confirmed')) RETURNING id`;
      if (!rows[0]) throw new Error('Item is unavailable or requires submission reconciliation.');
      return rows[0];
    }),
    'submission.begin': operation(schemas['submission.begin'], async ([input], sql) => {
      const [material] = await sql`SELECT d.lead_id,d.material_manifest_id FROM job_application_drafts d JOIN job_application_batch_items i ON i.lead_id=d.lead_id WHERE i.id=${input.itemId}`;
      if (material) await workflow.assertCurrentMaterial(material, sql, store.root);
      const draft = await readSubmissionDraft(LOCAL_OWNER, input.itemId, sql);
      if (!draft || draft.draftReviewStatus !== 'approved' || !draft.snapshotCurrent ||
        draft.draftVersion !== input.draftVersion || draft.draftHash !== input.draftHash)
        throw new JobdeskError('STALE_DRAFT',
          'Draft changed or needs review. Read the current approved draft and refill the employer form before starting submission.');
      const lease = { itemId: input.itemId, workerId: input.workerId, generation: input.generation };
      return leases.beginSubmission(LOCAL_OWNER, lease, draft, sql);
    }),
    'submission.uncertain': operation(schemas['submission.uncertain'], ([id, note], sql) =>
      leases.markUncertain(LOCAL_OWNER, id, note, sql),
    ),
    'submission.notSubmitted': operation(
      schemas['submission.notSubmitted'],
      ([id, evidence], sql) => leases.reconcileNotSubmitted(LOCAL_OWNER, id, evidence, sql),
    ),
    'submission.record': operation(schemas['submission.record'], async ([input], sql) => {
      const attempts =
        await sql`SELECT id FROM jobdesk_submission_attempts WHERE item_id=${input.itemId} AND owner_id=${LOCAL_OWNER}
        AND state IN ('pending','uncertain','confirmed') ORDER BY created_at DESC LIMIT 1`;
      const attemptId = input.attemptId ?? attempts[0]?.id;
      if (!attemptId) throw new Error('A durable submission attempt is required.');
      return leases.confirmSubmission(LOCAL_OWNER, { ...input, attemptId }, sql);
    }),
    'review.read': operation(schemas['review.read'], async (_, sql) => {
      const timeZone = await readTimeZone(sql);
      return {
      weeks: await review.listWeeklyReview(review.getReviewWeeks(review.localDate(new Date(), timeZone)), sql, timeZone),
      leads: await review.listReviewLeads(sql),
      outcomes: await review.listSiteOutcomes(sql),
      reports: await sql`SELECT * FROM jobdesk_user_reports ORDER BY id`,
      };
    }),
    'review.event': operation(schemas['review.event'], async ([input], sql) =>
      review.recordReviewEvent(input, sql, await readTimeZone(sql)),
    ),
    'review.complete': operation(schemas['review.complete'], ([date], sql) =>
      review.markReviewWeekComplete(date, sql),
    ),
    'review.outcome': operation(schemas['review.outcome'], async ([input], sql) =>
      review.recordSiteOutcome(input, sql, await readTimeZone(sql)),
    ),
    'settings.read': operation(schemas['settings.read'], async (_, sql) => ({
      ...(await readSettings(sql)), apiKeys: await apiKeyStatus(store.root),
    })),
    'settings.saveApiKey': operation(schemas['settings.saveApiKey'], async ([provider, key]) => {
      await userFacing(() => saveApiKey(store.root, provider, key));
      return { saved: Boolean(key.trim()) };
    }),
    'settings.save': operation(schemas['settings.save'], ([input], sql) => saveSettings(input, sql)),
    'review.removeOutcome': operation(schemas['review.removeOutcome'], ([id], sql) =>
      review.removeSiteOutcome(id, sql),
    ),
    'cockpit.live': operation(schemas['cockpit.live'], (_, sql) => cockpit.liveState(sql)),
    'cockpit.pipeline': operation(schemas['cockpit.pipeline'], (_, sql) => cockpit.pipeline(sql)),
    'cockpit.lead': operation(schemas['cockpit.lead'], ([id], sql) => cockpit.leadView(id, sql)),
    'cockpit.reconcile': operation(schemas['cockpit.reconcile'], (_, sql) => cockpit.reconciliation(sql)),
    'assistant.status': operation(schemas['assistant.status'], () => assistantStatus()),
    'assistant.connect': operation(schemas['assistant.connect'], ([id, options]) => connectAssistant(id, {}, undefined, options)),
  };
  return async (message: unknown) => {
    const { method, args } = rpcSchema.parse(message);
    if (['brief.addMessage', 'brief.approve', 'brief.cancelDraft'].includes(method) && !options.trustedUserActions)
      throw new JobdeskError('WORKFLOW_REJECTED', 'This operation requires an explicit authenticated cockpit action.');
    if (method === 'evaluation.run') return evaluateArtifact(schemas['evaluation.run'].parse(args)[0], store);
    if (method === 'collection.run') return runCollection(schemas['collection.run'].parse(args)[0], store);
    if (method === 'workflow.build') { const [input] = schemas['workflow.build'].parse(args); return buildMaterials(input.leadId, store, input.repair); }
    if (method === 'search.run') {
      schemas['search.run'].parse(args);
      // Legacy callers retain daily-run semantics; each DB statement is queued,
      // while the external feed fetch leaves the owner available.
      return discovery.runDailySearch({ sql: (strings, ...values) => store.run((sql) => sql(strings, ...values)) });
    }
    if (method === 'backup') {
      schemas.backup.parse(args);
      return store.backup();
    }
    if (method === 'browser.open' || method === 'owner.shutdown')
      throw new Error('This operation requires the owner process connection.');
    const handler = operations[method];
    return store.run((sql) =>
      ['reviews.read', 'recruiter.packet', 'recruiter.save', 'brief.addMessage', 'brief.propose', 'brief.approve', 'brief.cancelDraft', 'preparation.plan', 'truth.addProject', 'truth.importResume', 'truth.importText', 'search.save', 'submission.record', 'draft.edit', 'draft.saveManual', 'draft.approve', 'submission.begin', 'submission.notSubmitted', 'workflow.packet', 'workflow.save', 'workflow.configure', 'exclusions.restore', 'workflow.review'].includes(method)
        ? store.db.transaction((tx) => handler(args, parameterizedSql(tx)))
        : handler(args, sql),
    );
  };
}
