'use server';

import { revalidatePath } from 'next/cache';
import { requireJobsAccount } from '@/lib/jobs-auth';
import { runDailySearch, saveManualLead, saveSearchQueries, updateLead } from '@/lib/job-discovery';
import { createApplicationBatch, issueMcpToken as createMcpToken, revokeMcpToken as revokeToken, selectApplicationBatch } from '@/lib/job-queue';

const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export async function addJobLead(form: FormData) {
  await requireJobsAccount();
  await saveManualLead({ url: value(form, 'url'), title: value(form, 'title'), organization: value(form, 'organization'), location: value(form, 'location'), notes: value(form, 'notes') });
  revalidatePath('/jobs');
  revalidatePath('/jobs/leads');
}

export async function updateJobLead(form: FormData) {
  await requireJobsAccount();
  await updateLead({
    id: value(form, 'id'), decision: value(form, 'decision'), stage: value(form, 'stage'), verification: value(form, 'verification'),
    nextAction: value(form, 'nextAction'), nextActionDate: value(form, 'nextActionDate'), notes: value(form, 'notes'),
  });
  revalidatePath('/jobs');
  revalidatePath('/jobs/leads');
}

export type BatchActionState = { message: string; error?: boolean; batchId?: string };
export async function createJobBatch(_state: BatchActionState, form: FormData): Promise<BatchActionState> {
  const ownerId = await requireJobsAccount();
  try {
    const result = await createApplicationBatch(ownerId, form.getAll('leadId').map((item) => String(item)));
    revalidatePath('/jobs/leads');
    return { message: `Selected batch ${result.id} with ${result.count} pursued ${result.count === 1 ? 'lead' : 'leads'}.`, batchId: result.id };
  } catch (error) {
    return { message: error instanceof Error ? error.message : 'Unable to create application batch.', error: true };
  }
}

export async function selectJobBatch(form: FormData) {
  const ownerId = await requireJobsAccount();
  const batchId = String(form.get('batchId') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('Invalid batch.');
  const selected = await selectApplicationBatch(ownerId, batchId);
  if (!selected) throw new Error('Batch not found.');
  revalidatePath('/jobs/leads');
}

export type McpTokenActionState = { token?: string; message?: string; error?: boolean };
export async function issueJobsMcpToken(_state: McpTokenActionState, form: FormData): Promise<McpTokenActionState> {
  const ownerId = await requireJobsAccount();
  try {
    const created = await createMcpToken(ownerId, String(form.get('label') ?? ''));
    revalidatePath('/jobs/settings');
    return { token: created.token, message: 'Copy this token now. It will not be shown again.' };
  } catch {
    return { message: 'Unable to issue an MCP token.', error: true };
  }
}

export async function revokeJobsMcpToken(form: FormData) {
  const ownerId = await requireJobsAccount();
  await revokeToken(ownerId, String(form.get('id') ?? ''));
  revalidatePath('/jobs/settings');
}

export async function editSearchQueries(form: FormData) {
  await requireJobsAccount();
  const ids = ['ai-chicago', 'ai-remote', 'fde-chicago', 'fde-remote', 'product-chicago', 'product-remote'];
  await saveSearchQueries(ids.map((id) => ({ id, query: value(form, `query:${id}`), feedUrl: value(form, `feed:${id}`), enabled: form.get(`enabled:${id}`) === 'on' })));
  revalidatePath('/jobs');
  revalidatePath('/jobs/settings');
}

export async function runJobSearchNow() {
  await requireJobsAccount();
  await runDailySearch();
  revalidatePath('/jobs');
  revalidatePath('/jobs/settings');
}
