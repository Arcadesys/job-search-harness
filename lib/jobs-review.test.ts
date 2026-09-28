import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { centralDate, getReviewWeeks, JOB_REVIEW_TIME_ZONE, listWeeklyReview, markReviewWeekComplete, recordReviewEvent, recordSiteOutcome, removeSiteOutcome } from './jobs-review';

type FakeSql = NeonQueryFunction<false, false>;
function tagged(fn: (text: string, values: unknown[]) => Promise<unknown[]>): FakeSql {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => fn(strings.join(' ? '), values)) as FakeSql;
}

test('weekly window uses Central date and Monday through Sunday periods', () => {
  assert.equal(JOB_REVIEW_TIME_ZONE, 'America/Chicago');
  assert.equal(centralDate(new Date('2026-09-25T05:30:00Z')), '2026-09-25');
  assert.equal(centralDate(new Date('2026-09-25T04:30:00Z')), '2026-09-24');
  assert.deepEqual(getReviewWeeks('2026-09-25', 3), ['2026-09-07', '2026-09-14', '2026-09-21']);
  assert.throws(() => getReviewWeeks('2026-99-99'), /Invalid review window/);
});

test('weekly counts use dated lead records and explicit outcome events with review completeness', async () => {
  let statement = '';
  let payload = '';
  const fake = tagged(async (text, values) => { statement = text; payload = String(values[0]); return []; });
  await listWeeklyReview(['2026-09-14', '2026-09-21'], fake);
  assert.deepEqual(JSON.parse(payload).map((week: { week_start: string }) => week.week_start), ['2026-09-14', '2026-09-21']);
  assert.match(statement, /date_trunc\('week', discovered_at AT TIME ZONE\s+\?/);
  assert.match(statement, /count\(\*\) FILTER \(WHERE event_type='reply'\)/);
  assert.match(statement, /FROM job_application_receipts GROUP BY 1/);
  assert.match(statement, /coalesce\(a\.applications,0\)::int AS applications/);
  assert.doesNotMatch(statement, /FILTER \(WHERE event_type='application'\)/);
  assert.match(statement, /LEFT JOIN job_review_weeks/);
  assert.match(statement, /FROM work_site_outcomes GROUP BY 1/);
  assert.match(statement, /coalesce\(s\.hiring_inquiries,0\)::int AS "hiringInquiries"/);
  assert.match(statement, /coalesce\(s\.conversations_booked,0\)::int AS "conversationsBooked"/);
  assert.match(statement, /reviewed_at AS "reviewedAt"/);
});

test('confirmed site outcomes are private, dated, evidence-linked, and de-duplicated', async () => {
  let statement = '';
  let values: unknown[] = [];
  const fake = tagged(async (text, args) => { statement = text; values = args; return []; });
  await recordSiteOutcome({ type: 'hiring_inquiry', date: '2026-09-24', evidenceRef: ' LinkedIn message Sep 24 ' }, fake);
  assert.match(statement, /INSERT INTO work_site_outcomes/);
  assert.match(statement, /ON CONFLICT \(outcome_type, evidence_ref\) DO UPDATE/);
  assert.ok(values.includes('LinkedIn message Sep 24'));
  await assert.rejects(() => recordSiteOutcome({ type: 'contact_click', date: '2026-09-24', evidenceRef: 'click' }, fake), /supported outcome/);
  await assert.rejects(() => recordSiteOutcome({ type: 'conversation_booked', date: '2999-01-01', evidenceRef: 'calendar' }, fake), /valid date/);
  await assert.rejects(() => recordSiteOutcome({ type: 'conversation_booked', date: '2026-09-24', evidenceRef: ' ' }, fake), /evidence reference/);
  await removeSiteOutcome('12', fake);
  assert.match(statement, /DELETE FROM work_site_outcomes WHERE id=/);
  await assert.rejects(() => removeSiteOutcome('12 OR 1=1', fake), /Invalid outcome/);
});

test('dated activity records are explicit, constrained, tied to a lead, and idempotent for same-day double submits', async () => {
  let statement = '';
  let values: unknown[] = [];
  const fake = tagged(async (text, args) => { statement = text; values = args; return [{ id: 12 }]; });
  await recordReviewEvent({ leadId: 'lead-a', type: 'interview', date: '2026-09-24', note: 'Round 1' }, fake);
  assert.match(statement, /SELECT id,\s*\?\s*,\s*\?\s*,\s*\?/);
  assert.match(statement, /FROM job_leads WHERE id=\s*\?/);
  assert.match(statement, /ON CONFLICT \(lead_id,event_type,occurred_on\) DO UPDATE/);
  assert.ok(values.includes('lead-a'));
  await assert.rejects(() => recordReviewEvent({ leadId: 'lead-a', type: 'reply-by-guess', date: '2026-09-24' }, fake), /supported activity/);
  await assert.rejects(() => recordReviewEvent({ leadId: 'lead-a', type: 'application', date: '2026-09-24' }, fake), /supported activity/);
  await assert.rejects(() => recordReviewEvent({ leadId: 'lead-a', type: 'offer', date: '2999-01-01' }, fake), /only after its date/);
  await assert.rejects(() => recordReviewEvent({ leadId: 'lead-a', type: 'reply', date: '2026-02-30' }, fake), /valid activity date/);
});

test('weekly zero is explicit only after review, and only Monday dates can close a week', async () => {
  let statement = '';
  const fake = tagged(async (text) => { statement = text; return []; });
  await markReviewWeekComplete('2026-09-21', fake);
  assert.match(statement, /INSERT INTO job_review_weeks/);
  assert.match(statement, /ON CONFLICT \(week_start\) DO UPDATE SET reviewed_at=now\(\)/);
  await assert.rejects(() => markReviewWeekComplete('2026-09-22', fake), /Invalid review week/);
});

test('review route and both mutations require the authorized jobs account', async () => {
  const [page, actions] = await Promise.all([
    readFile(new URL('../app/jobs/review/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/jobs/review/actions.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /await requireJobsAccount\(\)/);
  assert.equal((actions.match(/await requireJobsAccount\(\)/g) ?? []).length, 4);
  assert.match(page, /JOB_REVIEW_TIME_ZONE/);
  assert.match(page, /Not recorded/);
  assert.match(page, /Applications are counted from confirmed submission receipts/);
  assert.doesNotMatch(page, /option value="application"/);
  assert.match(page, /Confirmed inquiries and conversations/);
  assert.match(page, /not sent to PostHog/);
});
