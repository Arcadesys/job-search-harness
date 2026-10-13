import type { Sql } from './job-storage';
import { listResumeTruth, type TruthClaim } from '@/lib/resume-truth';
import { estimateCost, type AssessmentProvider } from './drafting-assessment';

export const MONTHLY_AI_BUDGET_USD = 8.5;

export function supportedClaimIds(ids: string[], claims: TruthClaim[]): string[] {
  const reviewed = new Set(claims.filter((c) => c.reviewStatus === 'reviewed').map((c) => c.id));
  return [...new Set(ids)].filter((id) => reviewed.has(id));
}

export function renderTruthGroundedDraft(claims: TruthClaim[], title: string, organization: string): { resumeVariant: string; outreach: string } {
  const selected = claims.filter((claim) => claim.reviewStatus === 'reviewed');
  const evidence = selected.slice(0, 3).map((claim) => `• ${claim.claim} [${claim.id}]`).join('\n');
  return {
    resumeVariant: selected.map((claim) => `• ${claim.claim} [${claim.id}]`).join('\n'),
    outreach: `Hello,\n\nI’m interested in the ${title} role at ${organization || 'your organization'}. Relevant experience:\n${evidence || 'I would welcome the chance to discuss the role.'}\n\nThank you for your time.`,
  };
}

export async function getDraftingLead(id: string, sql: Sql) {
  const rows = await sql`SELECT id,source_url AS "sourceUrl",title,organization,location,source,verification_status AS "verificationStatus",posting_text AS "postingText",posting_source_note AS "postingSourceNote" FROM job_leads WHERE id=${id}`;
  return rows[0] ?? null;
}

export async function saveOriginalPosting(id: string, text: string, note: string, sql: Sql): Promise<void> {
  const content = text.trim();
  const sourceNote = note.trim();
  if (content.length < 200 || content.length > 30000) throw new Error('Paste at least 200 characters of the original posting (up to 30,000).');
  if (sourceNote.length < 8 || sourceNote.length > 500) throw new Error('Add a source note confirming where this original posting text came from.');
  await sql`UPDATE job_leads SET posting_text=${content},posting_source_note=${sourceNote},verification_status='verified',last_checked_at=now(),updated_at=now() WHERE id=${id}`;
}

export async function currentAiUsage(sql: Sql) {
  const rows = await sql`SELECT estimated_usd AS "estimatedUsd",input_tokens AS "inputTokens",output_tokens AS "outputTokens",unknown_cost_requests AS "unknownCostRequests",request_count AS "requestCount",budget_usd AS "budgetUsd" FROM job_ai_usage WHERE usage_month=date_trunc('month',now())::date`;
  return rows[0] ?? { estimatedUsd: 0, inputTokens: 0, outputTokens: 0, unknownCostRequests: 0, requestCount: 0, budgetUsd: MONTHLY_AI_BUDGET_USD };
}

export async function listDraftingHistory(leadId: string, sql: Sql) {
  const [assessments, drafts] = await Promise.all([
    sql`SELECT id,status,assessment,model,input_tokens AS "inputTokens",output_tokens AS "outputTokens",estimated_usd AS "estimatedUsd",created_at AS "createdAt" FROM job_fit_assessments WHERE lead_id=${leadId} ORDER BY created_at DESC LIMIT 10`,
    sql`SELECT id,resume_variant AS "resumeVariant",outreach,claim_ids AS "claimIds",truth_snapshot AS "truthSnapshot",created_at AS "createdAt",updated_at AS "updatedAt" FROM job_application_drafts WHERE lead_id=${leadId}`,
  ]);
  return { assessments, draft: drafts[0] ?? null };
}

/** Atomically reserves the monthly cap. A missing provider counter is charged at the cap. */
async function reserveBudget(sql: Sql): Promise<boolean> {
  const reserve = 0.01;
  const rows = await sql`INSERT INTO job_ai_usage (usage_month,estimated_usd,budget_usd,request_count)
    VALUES (date_trunc('month',now())::date,${reserve},${MONTHLY_AI_BUDGET_USD},1)
    ON CONFLICT (usage_month) DO UPDATE SET estimated_usd=job_ai_usage.estimated_usd+${reserve},request_count=job_ai_usage.request_count+1,updated_at=now()
    WHERE job_ai_usage.estimated_usd+${reserve} <= job_ai_usage.budget_usd AND job_ai_usage.unknown_cost_requests=0
    RETURNING usage_month`;
  return rows.length > 0;
}

/** provider is null when drafting in the cockpit is turned off; the user's AI
 * assistant can still prepare drafts through the manual-draft path. */
export async function assessAndDraft(leadId: string, sql: Sql, provider: AssessmentProvider | null) {
  const block = async (reason: string) => {
    await sql`INSERT INTO job_fit_assessments (lead_id,status,assessment) VALUES (${leadId},'blocked',${JSON.stringify({ reason })}::jsonb)`;
    return { blocked: true as const, reason };
  };
  const lead = await getDraftingLead(leadId, sql);
  if (!lead) throw new Error('Lead not found.');
  if (lead.verificationStatus !== 'verified' || !lead.postingText || !lead.postingSourceNote) {
    return block('Original posting text and source note are required. Search snippets do not qualify.');
  }
  const claims = (await listResumeTruth(sql)).filter((claim) => claim.reviewStatus === 'reviewed');
  if (!claims.length) return block('Review at least one resume claim before requesting an assessment.');
  if (!provider) return block('Drafting in the cockpit is off. Ask your AI assistant to prepare the draft, or choose a provider and add its API key in Settings.');
  if (!await reserveBudget(sql)) throw new Error('The monthly AI budget has been reached or a provider usage counter is unknown.');

  try {
    const result = await provider.assess({
      job: { title: lead.title, organization: lead.organization, location: lead.location, sourceUrl: lead.sourceUrl, sourceNote: lead.postingSourceNote, originalPosting: lead.postingText },
      reviewedClaims: claims.map(({ id, claim, sourceNote }) => ({ id, claim, sourceNote })),
    });
    const { inputTokens, outputTokens } = result;
    const estimated = estimateCost(result.model, inputTokens, outputTokens);
    const data = (result.data && typeof result.data === 'object' ? result.data : {}) as Record<string, any>;
    const ids = supportedClaimIds(Array.isArray(data.usedClaimIds) ? data.usedClaimIds : [], claims);
    data.usedClaimIds = ids;
    if (!ids.length) {
      const reason = 'The assessment identified no supported reviewed claim for this role. Review the posting and truth bank before drafting.';
      await sql`INSERT INTO job_fit_assessments (lead_id,status,assessment,model,input_tokens,output_tokens,estimated_usd)
        VALUES (${leadId},'blocked',${JSON.stringify({ reason })}::jsonb,${result.model},${inputTokens},${outputTokens},${estimated})`;
      const storedEstimate = estimated ?? MONTHLY_AI_BUDGET_USD;
      await sql`UPDATE job_ai_usage SET estimated_usd=greatest(0,estimated_usd-0.01+${storedEstimate}),input_tokens=input_tokens+${inputTokens ?? 0},output_tokens=output_tokens+${outputTokens ?? 0},unknown_cost_requests=unknown_cost_requests+${estimated === null ? 1 : 0},updated_at=now() WHERE usage_month=date_trunc('month',now())::date`;
      return { blocked: true as const, reason };
    }
    data.strengths = Array.isArray(data.strengths) ? data.strengths.map((item: { text?: string; claimIds?: string[] }) => {
      const claimIds = supportedClaimIds(Array.isArray(item.claimIds) ? item.claimIds : [], claims);
      const citedClaims = claims.filter((claim) => claimIds.includes(claim.id));
      return { text: citedClaims.map((claim) => claim.claim).join(' '), claimIds };
    }).filter((item: { text: string; claimIds: string[] }) => item.text && item.claimIds.length) : [];
    const snapshot = claims.filter((claim) => ids.includes(claim.id));
    // Draft materials are assembled from exact approved claim text. The model cannot add résumé facts.
    const renderedDraft = renderTruthGroundedDraft(snapshot, String(lead.title), String(lead.organization ?? ''));
    data.resumeVariant = renderedDraft.resumeVariant;
    data.outreach = renderedDraft.outreach;
    await sql`INSERT INTO job_fit_assessments (lead_id,status,assessment,model,input_tokens,output_tokens,estimated_usd)
      VALUES (${leadId},'ready',${JSON.stringify(data)}::jsonb,${result.model},${inputTokens},${outputTokens},${estimated})`;
    await sql`INSERT INTO job_application_drafts (lead_id,resume_variant,outreach,claim_ids,truth_snapshot)
      VALUES (${leadId},${data.resumeVariant},${data.outreach},${ids},${JSON.stringify(snapshot)}::jsonb)
      ON CONFLICT (lead_id) DO UPDATE SET resume_variant=EXCLUDED.resume_variant,outreach=EXCLUDED.outreach,claim_ids=EXCLUDED.claim_ids,truth_snapshot=EXCLUDED.truth_snapshot,updated_at=now()`;
    const reserve = 0.01;
    const storedEstimate = estimated ?? MONTHLY_AI_BUDGET_USD;
    await sql`UPDATE job_ai_usage SET estimated_usd=greatest(0,estimated_usd-${reserve}+${storedEstimate}),input_tokens=input_tokens+${inputTokens ?? 0},output_tokens=output_tokens+${outputTokens ?? 0},unknown_cost_requests=unknown_cost_requests+${estimated === null ? 1 : 0},updated_at=now() WHERE usage_month=date_trunc('month',now())::date`;
    return { blocked: false as const, data, estimatedUsd: estimated };
  } catch (error) {
    // An unmeasured or failed provider call closes the budget to prevent repeated unaccounted requests.
    await sql`UPDATE job_ai_usage SET estimated_usd=budget_usd,unknown_cost_requests=unknown_cost_requests+1,updated_at=now() WHERE usage_month=date_trunc('month',now())::date`;
    throw error;
  }
}

export async function saveDraftEdits(leadId: string, resumeVariant: string, outreach: string, sql: Sql) {
  if (resumeVariant.length > 12000 || outreach.length > 3000) throw new Error('Draft is too long.');
  await sql`UPDATE job_application_drafts SET resume_variant=${resumeVariant},outreach=${outreach},updated_at=now() WHERE lead_id=${leadId}`;
}
