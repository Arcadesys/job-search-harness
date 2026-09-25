'use server';

import { revalidatePath } from 'next/cache';
import { requireJobsAccount } from '@/lib/jobs-auth';
import { runDailySearch, saveManualLead, saveSearchQueries, updateLead } from '@/lib/job-discovery';

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
