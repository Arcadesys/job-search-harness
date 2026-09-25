'use server';

import { revalidatePath } from 'next/cache';
import { requireJobsAccount } from '@/lib/jobs-auth';
import { markReviewWeekComplete, recordReviewEvent } from '@/lib/jobs-review';

const value = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

export async function addReviewEvent(form: FormData) {
  await requireJobsAccount();
  await recordReviewEvent({ leadId: value(form, 'leadId'), type: value(form, 'type'), date: value(form, 'date'), note: value(form, 'note') });
  revalidatePath('/jobs/review');
}

export async function completeReviewWeek(form: FormData) {
  await requireJobsAccount();
  await markReviewWeekComplete(value(form, 'weekStart'));
  revalidatePath('/jobs/review');
}
