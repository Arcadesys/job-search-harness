import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { JobdeskStore } from './store';
import { createService, initializeService } from './service';
import {
  runDailySearch,
  saveSearchQueries,
  DEFAULT_SEARCHES,
  leadIdForUrl,
} from '../../lib/job-discovery';
import { assessAndDraft, MONTHLY_AI_BUDGET_USD } from '../../lib/job-drafting';
import { centralDate, getReviewWeeks, listWeeklyReview } from '../../lib/jobs-review';

test('real SQL budgets, successful scan dedupe, failed/unmeasured provider calls and Chicago daylight saving', async () => {
  const root = await mkdtemp('/tmp/jobdesk-domain-');
  const store = await JobdeskStore.open(root);
  const oldFetch = globalThis.fetch,
    oldKey = process.env.OPENAI_API_KEY;
  try {
    await initializeService(store);
    const call = createService(store);
    const sql = store.sql;
    await saveSearchQueries(
      DEFAULT_SEARCHES.map((query) => ({
        id: query.id,
        query: query.query,
        feedUrl: query.id === 'ai-chicago' ? 'https://www.google.com/alerts/feeds/1/2' : '',
        enabled: query.id === 'ai-chicago',
      })),
      sql,
    );
    let polls = 0;
    const fetcher = async () => {
      polls++;
      return new Response(
        '<feed><entry><title>Feed test fixture</title><link href="https://example.test/jobs/feed-fixture"/></entry></feed>',
      );
    };
    const first = await runDailySearch({ sql, fetcher, now: new Date('2026-11-01T23:59:00Z') });
    assert.equal(first.status, 'succeeded');
    assert.equal(polls, 1);
    assert.equal(
      (await runDailySearch({ sql, fetcher, now: new Date('2026-11-01T23:59:59Z') })).skipped,
      true,
    );
    assert.equal(polls, 1);
    await sql`UPDATE job_search_usage SET calls_used=300`;
    const capped = await runDailySearch({ sql, fetcher, now: new Date('2026-11-02T00:00:00Z') });
    assert.equal(capped.status, 'failed');
    assert.equal(polls, 1);
    const url = 'https://example.test/jobs/draft-fixture',
      id = leadIdForUrl(url);
    await call({ method: 'leads.add', args: [{ url, title: 'Budget test fixture' }] });
    assert.equal((await assessAndDraft(id, sql)).blocked, true);
    await call({
      method: 'draft.posting',
      args: [
        id,
        'Synthetic original posting. '.repeat(10),
        'Synthetic source note; no real employer.',
      ],
    });
    assert.equal((await assessAndDraft(id, sql)).blocked, true);
    const claims = (await call({ method: 'truth.list', args: [] })) as any[];
    await call({
      method: 'truth.review',
      args: [
        {
          changes: [
            { id: claims[0].id, expectedVersion: claims[0].version, reviewStatus: 'reviewed' },
          ],
        },
      ],
    });
    process.env.OPENAI_API_KEY = 'synthetic-test-only-never-sent';
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json({
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  usedClaimIds: [claims[0].id],
                  strengths: [{ text: 'Model text must be replaced', claimIds: [claims[0].id] }],
                }),
              },
            ],
          },
        ],
      });
    };
    const drafted = await assessAndDraft(id, sql);
    assert.equal(drafted.blocked, false);
    assert.equal(requests, 1);
    const usage = (await sql`SELECT * FROM job_ai_usage`)[0];
    assert.equal(Number(usage.estimated_usd), MONTHLY_AI_BUDGET_USD);
    assert.equal(usage.unknown_cost_requests, 1);
    await assert.rejects(assessAndDraft(id, sql), /budget/);
    assert.equal(requests, 1);
    const draft = (await sql`SELECT * FROM job_application_drafts WHERE lead_id=${id}`)[0];
    assert.equal(draft.truth_snapshot.length, 1);
    assert.equal(draft.truth_snapshot[0].claim, claims[0].claim);
    assert.ok(draft.truth_snapshot[0].version);
    assert.equal(draft.review_status, 'review_required');
    await sql`UPDATE job_ai_usage SET estimated_usd=0,unknown_cost_requests=0`;
    globalThis.fetch = async () => {
      requests++;
      throw new Error('Synthetic definite provider failure');
    };
    await assert.rejects(assessAndDraft(id, sql), /Synthetic/);
    assert.equal(
      (await sql`SELECT unknown_cost_requests FROM job_ai_usage`)[0].unknown_cost_requests,
      1,
    );
    assert.equal(centralDate(new Date('2026-03-08T05:59:00Z')), '2026-03-07');
    assert.equal(centralDate(new Date('2026-03-08T08:00:00Z')), '2026-03-08');
    assert.equal(centralDate(new Date('2026-11-01T06:59:00Z')), '2026-11-01');
    assert.equal(centralDate(new Date('2026-11-01T07:01:00Z')), '2026-11-01');
    const weeks = getReviewWeeks('2026-11-01', 2);
    assert.deepEqual(weeks, ['2026-10-19', '2026-10-26']);
    assert.equal((await listWeeklyReview(weeks, sql)).length, 2);
    // A crashed owner's durable model marker closes its recorded month's cap.
    await sql`UPDATE job_ai_usage SET estimated_usd=0,unknown_cost_requests=0`;
    await sql`INSERT INTO jobdesk_model_runs(id,usage_month,state) VALUES(gen_random_uuid(),date_trunc('month',now())::date,'pending')`;
    await initializeService(store);
    assert.equal(
      (await sql`SELECT unknown_cost_requests FROM job_ai_usage`)[0].unknown_cost_requests,
      1,
    );
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
