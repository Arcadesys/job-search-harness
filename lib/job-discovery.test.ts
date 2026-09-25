import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { DEFAULT_SEARCHES, ingestLinkedInEmailLeads, ingestSearchResults, leadIdForUrl, normalizeSourceUrl, parseGoogleAlertsFeed, parseLinkedInAlertEmailText, runDailySearch, saveManualLead, saveSearchQueries, updateLead, validateGoogleAlertsFeedUrl } from './job-discovery';

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
  assert.equal(normalizeSourceUrl('https://www.linkedin.com/comm/jobs/view/4459916726/?trackingId=secret&trk=email'), 'https://linkedin.com/jobs/view/4459916726');
  assert.equal(leadIdForUrl('https://www.linkedin.com/comm/jobs/view/4459916726/?trackingId=x'), leadIdForUrl('https://linkedin.com/jobs/view/4459916726'));
});

test('LinkedIn alert email text yields only job cards and canonical links', () => {
  const email = `Your job alert for AI jobs in Chicago\nNew jobs match your preferences.\n\nAI Product Engineer\nJerry\nChicago, IL\nTop applicant\nView job: https://www.linkedin.com/comm/jobs/view/4459916726/?trackingId=private\n\n------------------------------\n\nForward Deployed Engineer\nExample Co\nUnited States\nView job: https://www.linkedin.com/jobs/view/4471453089/?trk=email`;
  assert.deepEqual(parseLinkedInAlertEmailText(email), [
    { title: 'AI Product Engineer', organization: 'Jerry', location: 'Chicago, IL', url: 'https://linkedin.com/jobs/view/4459916726' },
    { title: 'Forward Deployed Engineer', organization: 'Example Co', location: 'United States', url: 'https://linkedin.com/jobs/view/4471453089' },
  ]);
  assert.deepEqual(parseLinkedInAlertEmailText(`Your job alert for program manager\nA new job matches your preferences.\n\nAI Program Manager\nNorthern Trust\nChicago, IL\nView job: https://www.linkedin.com/comm/jobs/view/4459572103/?trk=email`), [
    { title: 'AI Program Manager', organization: 'Northern Trust', location: 'Chicago, IL', url: 'https://linkedin.com/jobs/view/4459572103' },
  ]);
});

test('LinkedIn email imports deduplicate and preserve saved decisions on repeat', async () => {
  let statement = '';
  let payload = '';
  const fake = tagged(async (text, values) => { statement = text; payload = String(values[0]); return [{ inserted: true }]; });
  const lead = { title: 'AI Product Engineer', organization: 'Jerry', location: 'Chicago, IL', url: 'https://www.linkedin.com/comm/jobs/view/4459916726/?trackingId=private' };
  const result = await ingestLinkedInEmailLeads([lead, { ...lead, url: 'https://linkedin.com/jobs/view/4459916726' }, { ...lead, url: 'not-a-url' }], fake);
  assert.deepEqual(result, { seen: 1, created: 1 });
  assert.equal(JSON.parse(payload)[0].source_url, 'https://linkedin.com/jobs/view/4459916726');
  assert.match(statement, /'linkedin-email'/);
  assert.match(statement, /ON CONFLICT \(source_url\) DO UPDATE SET last_checked_at=now\(\),updated_at=now\(\)/);
  assert.doesNotMatch(statement, /decision\s*=/);
});

test('six editable defaults span three target lanes and two locations', () => {
  assert.equal(DEFAULT_SEARCHES.length, 6);
  assert.deepEqual(new Set(DEFAULT_SEARCHES.map((item) => item.location)), new Set(['Chicago', 'Remote']));
  assert.equal(new Set(DEFAULT_SEARCHES.map((item) => item.lane)).size, 3);
  assert.ok(DEFAULT_SEARCHES.every((item) => item.query.length >= 8));
});

const feedUrl = 'https://www.google.com/alerts/feeds/123456/789012';
const feedXml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">&lt;b&gt;AI Engineer&lt;/b&gt; · Example</title><link href="https://www.google.com/url?url=https%3A%2F%2Fjobs.example%2Fai%3Futm_source%3Dgoogle"/><content type="html">New opening</content></entry></feed>`;

test('Google Alert feed URLs are constrained and Atom entries retain original posting links', () => {
  assert.equal(validateGoogleAlertsFeedUrl(feedUrl), feedUrl);
  assert.throws(() => validateGoogleAlertsFeedUrl('http://www.google.com/alerts/feeds/1/2'));
  assert.throws(() => validateGoogleAlertsFeedUrl('https://example.com/alerts/feeds/1/2'));
  assert.throws(() => validateGoogleAlertsFeedUrl('https://www.google.com@evil.example/alerts/feeds/1/2'));
  assert.deepEqual(parseGoogleAlertsFeed(feedXml), [{ title: 'AI Engineer · Example', url: 'https://jobs.example/ai?utm_source=google', description: 'New opening' }]);
  assert.throws(() => parseGoogleAlertsFeed('<!DOCTYPE feed><feed/>'), /invalid XML/);
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

test('daily repeat deliveries make no second Google feed poll and do not double count usage', async () => {
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
    if (text.includes('SELECT id,query,feed_url')) return [{ id: 'ai-remote', query: 'remote AI roles', feedUrl }];
    if (text.includes('INSERT INTO job_search_usage')) { reservations++; return [{ calls_used: reservations }]; }
    if (text.includes('INSERT INTO job_leads')) return [{ inserted: true }];
    if (text.includes('UPDATE job_search_runs SET status=')) { status = 'succeeded'; return []; }
    return [];
  });
  const run = () => runDailySearch({ sql: fake, now: new Date('2026-09-25T14:00:00Z'), fetcher: async () => {
    fetches++;
    return new Response(feedXml, { headers: { 'Content-Type': 'application/atom+xml' } });
  } });
  const first = await run();
  const second = await run();
  assert.equal(first.status, 'succeeded');
  assert.deepEqual(second, { skipped: true, reason: 'already-run' });
  assert.equal(fetches, 1);
  assert.equal(reservations, 1);
  assert.equal(status, 'succeeded');
});

test('missing Google Alert RSS URLs are reported without reserving a feed poll', async () => {
  let status = '';
  let persistedError = '';
  let calls = 0;
  const fake = tagged(async (text, values) => {
    if (text.includes('INSERT INTO job_search_runs')) return [{ run_date: '2026-09-25' }];
    if (text.includes('SELECT id,query,feed_url')) return [{ id: 'ai-remote', query: 'remote AI roles', feedUrl: '' }];
    if (text.includes('UPDATE job_search_runs SET status=')) { status = String(values.find((value) => value === 'failed')); persistedError = String(values.find((value) => String(value).includes('RSS feed URL is missing'))); return []; }
    if (text.includes('INSERT INTO job_search_usage')) calls++;
    return [];
  });
  const result = await runDailySearch({ sql: fake, now: new Date('2026-09-25T14:00:00Z') });
  assert.equal(result.status, 'failed');
  assert.match(persistedError, /RSS feed URL is missing/);
  assert.equal(status, 'failed');
  assert.equal(calls, 0);
});

test('monthly feed poll cap rejection stops before contacting Google and persists the run failure', async () => {
  let message = '';
  let fetches = 0;
  const fake = tagged(async (text, values) => {
    if (text.includes('INSERT INTO job_search_runs')) return [{ run_date: '2026-09-25' }];
    if (text.includes('SELECT id,query,feed_url')) return [{ id: 'ai-remote', query: 'remote AI roles', feedUrl }];
    if (text.includes('INSERT INTO job_search_usage')) return [];
    if (text.includes('UPDATE job_search_runs SET status=')) { message = String(values.find((value) => String(value).includes('Monthly feed poll cap'))); }
    return [];
  });
  const result = await runDailySearch({ sql: fake, now: new Date('2026-09-25T14:00:00Z'), fetcher: async () => { fetches++; return new Response(feedXml); } });
  assert.equal(result.status, 'failed');
  assert.match(message, /Monthly feed poll cap \(300\) reached/);
  assert.equal(fetches, 0);
});

test('manual lead and pipeline updates use normalized unique URLs and constrained private fields', async () => {
  const statements: string[] = [];
  const fake = tagged(async (text) => { statements.push(text); return []; });
  await saveManualLead({ url: 'https://www.example.org/opening?utm_source=email', title: 'Engineer' }, fake);
  await updateLead({ id: 'abc', decision: 'keep', stage: 'interviewing', verification: 'verified' }, fake);
  await saveSearchQueries(DEFAULT_SEARCHES.map((item) => ({ id: item.id, query: item.query, feedUrl, enabled: true })), fake);
  assert.match(statements[0], /ON CONFLICT \(source_url\)/);
  assert.match(statements[1], /verification_status=\s*\?/);
  assert.match(statements[2], /UPDATE job_search_queries/);
  await assert.rejects(() => updateLead({ id: 'abc', decision: 'maybe' }, fake), /Invalid job status/);
  await assert.rejects(() => saveSearchQueries([{ id: 'unknown', query: 'long enough search query', feedUrl, enabled: true }], fake), /six defaults/);
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
