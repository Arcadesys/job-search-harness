import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { DEFAULT_SEARCHES, ingestSearchResults, leadIdForUrl, normalizeSourceUrl, runDailySearch, saveManualLead, saveSearchQueries, updateLead } from './job-discovery';

type FakeSql = NeonQueryFunction<false, false>;
function tagged(fn: (text: string, values: unknown[]) => Promise<unknown[]>): FakeSql {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => fn(strings.join(' ? '), values)) as FakeSql;
}

test('source URL normalization removes tracking and deduplicates equivalent posting links', () => {
  const first = 'https://www.example.com/jobs/role/?utm_source=board&id=3#apply';
  const second = 'https://example.com/jobs/role?id=3';
  assert.equal(normalizeSourceUrl(first), normalizeSourceUrl(second));
  assert.equal(leadIdForUrl(first), leadIdForUrl(second));
  assert.throws(() => normalizeSourceUrl('javascript:alert(1)'));
});

test('six editable defaults span three target lanes and two locations', () => {
  assert.equal(DEFAULT_SEARCHES.length, 6);
  assert.deepEqual(new Set(DEFAULT_SEARCHES.map((item) => item.location)), new Set(['Chicago', 'Remote']));
  assert.equal(new Set(DEFAULT_SEARCHES.map((item) => item.lane)).size, 3);
  assert.ok(DEFAULT_SEARCHES.every((item) => item.query.length >= 8));
});

test('duplicate scan results update last-checked without replacing review or pipeline state', async () => {
  const statements: string[] = [];
  let payload = '';
  const fake = tagged(async (text, values) => { statements.push(text); payload = String(values[0]); return [{ inserted: false }]; });
  const outcome = await ingestSearchResults([
    { title: 'Role', url: 'https://example.org/job/1?utm_campaign=x', description: 'Snippet' },
    { title: 'Role duplicate', url: 'https://www.example.org/job/1?utm_source=mail', description: 'Duplicate result' },
  ], 'ai-remote', fake);
  assert.deepEqual(outcome, { seen: 1, created: 0 });
  assert.equal(JSON.parse(payload).length, 1);
  assert.match(statements[0], /ON CONFLICT \(source_url\) DO UPDATE SET last_checked_at=now\(\),updated_at=now\(\)/);
  assert.doesNotMatch(statements[0], /verification_status\s*=|decision\s*=/);
});

test('daily repeat deliveries make no second provider call and do not double count usage', async () => {
  let hasRun = false;
  let reservations = 0;
  let status = '';
  let fetches = 0;
  const fake = tagged(async (text) => {
    if (text.includes('INSERT INTO job_search_runs')) {
      if (hasRun) return [];
      hasRun = true;
      return [{ run_date: '2026-09-25' }];
    }
    if (text.includes('SELECT id,query FROM job_search_queries')) return [{ id: 'ai-remote', query: 'remote AI roles' }];
    if (text.includes('INSERT INTO job_search_usage')) { reservations++; return [{ calls_used: reservations }]; }
    if (text.includes('INSERT INTO job_leads')) return [{ inserted: true }];
    if (text.includes("SET status='succeeded'")) { status = 'succeeded'; return []; }
    return [];
  });
  const run = () => runDailySearch({ sql: fake, now: new Date('2026-09-25T14:00:00Z'), apiKey: 'unit-test-key', fetcher: async () => {
    fetches++;
    return Response.json({ web: { results: [{ title: 'AI engineer', url: 'https://jobs.example/ai' }] } });
  } });
  const first = await run();
  const second = await run();
  assert.equal(first.status, 'succeeded');
  assert.deepEqual(second, { skipped: true, reason: 'already-run' });
  assert.equal(fetches, 1);
  assert.equal(reservations, 1);
  assert.equal(status, 'succeeded');
});

test('provider key failure is persisted as a failed run without reserving or sending a search call', async () => {
  let status = '';
  let persistedError = '';
  let calls = 0;
  const fake = tagged(async (text, values) => {
    if (text.includes('INSERT INTO job_search_runs')) return [{ run_date: '2026-09-25' }];
    if (text.includes("SET status='failed'")) { status = 'failed'; persistedError = String(values.find((value) => String(value).includes('BRAVE_SEARCH_API_KEY'))); return []; }
    if (text.includes('INSERT INTO job_search_usage')) calls++;
    return [];
  });
  const result = await runDailySearch({ sql: fake, now: new Date('2026-09-25T14:00:00Z'), apiKey: '' });
  assert.equal(result.status, 'failed');
  assert.match(persistedError, /BRAVE_SEARCH_API_KEY/);
  assert.equal(status, 'failed');
  assert.equal(calls, 0);
});

test('monthly call cap rejection stops before contacting Brave and persists the run failure', async () => {
  let message = '';
  let fetches = 0;
  const fake = tagged(async (text, values) => {
    if (text.includes('INSERT INTO job_search_runs')) return [{ run_date: '2026-09-25' }];
    if (text.includes('SELECT id,query FROM job_search_queries')) return [{ id: 'ai-remote', query: 'remote AI roles' }];
    if (text.includes('INSERT INTO job_search_usage')) return [];
    if (text.includes("SET status='failed'")) { message = String(values.find((value) => String(value).includes('Monthly search call cap'))); }
    return [];
  });
  const result = await runDailySearch({ sql: fake, now: new Date('2026-09-25T14:00:00Z'), apiKey: 'unit-test-key', fetcher: async () => { fetches++; return Response.json({}); } });
  assert.equal(result.status, 'failed');
  assert.match(message, /Monthly search call cap \(300\) reached/);
  assert.equal(fetches, 0);
});

test('manual lead and pipeline updates use normalized unique URLs and constrained private fields', async () => {
  const statements: string[] = [];
  const fake = tagged(async (text) => { statements.push(text); return []; });
  await saveManualLead({ url: 'https://www.example.org/opening?utm_source=email', title: 'Engineer' }, fake);
  await updateLead({ id: 'abc', decision: 'keep', stage: 'interviewing', verification: 'verified' }, fake);
  await saveSearchQueries(DEFAULT_SEARCHES.map((item) => ({ id: item.id, query: item.query, enabled: true })), fake);
  assert.match(statements[0], /ON CONFLICT \(source_url\)/);
  assert.match(statements[1], /verification_status=\s*\?/);
  assert.match(statements[2], /UPDATE job_search_queries/);
  await assert.rejects(() => updateLead({ id: 'abc', decision: 'maybe' }, fake), /Invalid job status/);
  await assert.rejects(() => saveSearchQueries([{ id: 'unknown', query: 'long enough search query', enabled: true }], fake), /six defaults/);
});

test('private page actions authorize reads and writes and cron endpoint validates its secret', async () => {
  const [page, actions, route, exportRoute] = await Promise.all([
    readFile(new URL('../app/jobs/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/jobs/actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/jobs/discovery/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/jobs/drafting-export/route.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /await requireJobsAccount\(\)/);
  assert.equal((actions.match(/await requireJobsAccount\(\)/g) ?? []).length, 4);
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /timingSafeEqual/);
  assert.match(exportRoute, /await requireJobsAccount\(\)/);
  assert.match(exportRoute, /reviewStatus === 'reviewed'/);
  assert.match(exportRoute, /decision === 'keep'/);
});
