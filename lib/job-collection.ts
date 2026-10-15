import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import type { Sql } from './job-storage';
import { leadIdForUrl, normalizeSourceUrl, parseGoogleAlertsFeed, validateGoogleAlertsFeedUrl } from './job-discovery';
import { fingerprint } from './workflow-hash';
import { applyExplicitFilters } from './job-workflow';
import type { JobdeskStore } from '../services/jobdesk/store';
import { JobdeskError } from '../services/jobdesk/errors';

const BUILTIN = 'https://www.builtinchicago.org';
export const collectionRequestSchema = z.object({ source: z.enum(['builtin', 'feeds']),
  urls: z.array(z.url().max(2000)).max(25).default([]), runId: z.uuid().optional() }).strict();
export type CollectionRequest = z.infer<typeof collectionRequestSchema>;
export type SourceRecord = { source: string; sourceKey: string; url: string; title: string; organization: string;
  location: string | null; postingText: string | null; snippet: string;
  salary: { currency: string; unit: string; minimum: number | null; maximum: number | null } | null };
type Target = { url: string; kind: 'listing' | 'job' | 'feed'; source: string };
type Counts = { requested: number; fetched: number; parsed: number; failed: number; saved: number };
type FetchOptions = { fetcher?: typeof fetch; delayMs?: number };
const emptyCounts = (): Counts => ({ requested: 0, fetched: 0, parsed: 0, failed: 0, saved: 0 });

export function builtinJobUrl(raw: string) {
  const url = new URL(raw, BUILTIN);
  if (!['www.builtinchicago.org', 'builtinchicago.org'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password
    || !/^\/job\/[^/]+\/\d+\/?$/.test(url.pathname)) throw new Error('Use a public Built In Chicago job URL.');
  return `${BUILTIN}${url.pathname.replace(/\/$/, '')}`;
}
export function parseBuiltinListing(html: string) {
  const $ = load(html);
  const urls = [...new Set($('a[href]').toArray().flatMap((element) => {
    try { return [builtinJobUrl($(element).attr('href') ?? '')]; } catch { return []; }
  }))];
  const explicitEmpty = /no jobs (?:found|match)|no results found/i.test($('main').text());
  if (!urls.length && !explicitEmpty) throw new Error('Listing extraction found no job links or explicit empty-results message.');
  return { urls: urls.slice(0, 25), limited: urls.length > 25, empty: explicitEmpty && !urls.length };
}
function plain(input: string) {
  const $ = load(input);
  $('script,style,noscript').remove();
  $('br').replaceWith('\n');
  $('p,li,div,h1,h2,h3').each((_, node) => { $(node).append('\n'); });
  return $.root().text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}
function jobPosting(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.map(jobPosting).find(Boolean);
  const record = value as Record<string, any>;
  if (record['@type'] === 'JobPosting' || (Array.isArray(record['@type']) && record['@type'].includes('JobPosting'))) return record;
  return record['@graph'] ? jobPosting(record['@graph']) : undefined;
}
export function parseBuiltinJob(html: string, url: string): SourceRecord {
  const canonical = builtinJobUrl(url);
  const $ = load(html);
  let job: Record<string, any> | undefined;
  for (const node of $('script').toArray()) {
    if ($(node).attr('type') !== 'application/ld+json') continue;
    try { job = jobPosting(JSON.parse($(node).text())); } catch { /* another script may contain valid evidence */ }
    if (job) break;
  }
  if (!job || typeof job.title !== 'string' || typeof job.description !== 'string') throw new Error('A valid JobPosting title and description are required.');
  const postingText = plain(job.description);
  if (postingText.length < 200 || postingText.length > 30_000) throw new Error('Job description is missing, incomplete, or exceeds the supported size.');
  const places = (Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation]).filter(Boolean);
  const locations = places.map((place: any) => [place.address?.addressLocality, place.address?.addressRegion, place.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean);
  if (job.jobLocationType === 'TELECOMMUTE') locations.push('Remote');
  const base = job.baseSalary;
  const amount = base?.value;
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const salary = typeof base?.currency === 'string' && typeof amount?.unitText === 'string'
    ? { currency: base.currency, unit: amount.unitText.toUpperCase(), minimum: numeric(amount.minValue ?? amount.value), maximum: numeric(amount.maxValue ?? amount.value) } : null;
  const organization = typeof job.hiringOrganization?.name === 'string' ? plain(job.hiringOrganization.name) : '';
  return { source: 'builtin', sourceKey: canonical.split('/').pop()!, url: canonical, title: plain(job.title).slice(0, 250), organization,
    location: locations.join(' / ') || null, postingText, snippet: postingText.slice(0, 1500), salary };
}

/** Source history never changes user notes, decisions, or submission receipts. */
export async function saveSourceRecord(record: SourceRecord, runId: string, sql: Sql) {
  const sourceUrl = normalizeSourceUrl(record.url);
  const [existing] = await sql`SELECT lead_id FROM job_source_records WHERE source=${record.source} AND source_key=${record.sourceKey}`;
  const leadId = existing?.lead_id ?? leadIdForUrl(sourceUrl);
  const contentHash = fingerprint(record);
  const [prior] = await sql`SELECT content_hash,record FROM job_source_records WHERE source=${record.source} AND source_key=${record.sourceKey}`;
  const [verified] = await sql`SELECT posting_text,verification_status FROM job_leads WHERE id=${leadId}`;
  await sql`INSERT INTO job_leads(id,source_url,title,organization,location,snippet,source,last_seen_at,posting_retrieved_at)
    VALUES(${leadId},${sourceUrl},${record.title},${record.organization},${record.location ?? ''},${record.snippet},${record.source},now(),${record.postingText ? new Date().toISOString() : null}::timestamptz)
    ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,organization=CASE WHEN EXCLUDED.organization<>'' THEN EXCLUDED.organization ELSE job_leads.organization END,
      location=CASE WHEN EXCLUDED.location<>'' THEN EXCLUDED.location ELSE job_leads.location END,snippet=EXCLUDED.snippet,
      last_seen_at=now(),posting_retrieved_at=COALESCE(EXCLUDED.posting_retrieved_at,job_leads.posting_retrieved_at),updated_at=clock_timestamp()`;
  if (record.postingText && ((prior && prior.content_hash !== contentHash)
    || (!prior && verified?.verification_status === 'verified' && String(verified.posting_text).trim() !== record.postingText.trim())))
    await sql`UPDATE job_leads SET verification_status='stale' WHERE id=${leadId} AND verification_status='verified'`;
  if (!prior || prior.content_hash !== contentHash) {
    await sql`INSERT INTO job_source_observations(id,run_id,lead_id,source,source_key,content_hash,record)
      VALUES(${randomUUID()},${runId},${leadId},${record.source},${record.sourceKey},${contentHash},${JSON.stringify(record)}::jsonb)`;
  }
  await sql`INSERT INTO job_source_records(source,source_key,lead_id,content_hash,record)
    VALUES(${record.source},${record.sourceKey},${leadId},${contentHash},${JSON.stringify(record)}::jsonb)
    ON CONFLICT(source,source_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,record=EXCLUDED.record,observed_at=clock_timestamp()`;
  await applyExplicitFilters(leadId, sql);
  return { leadId, changed: prior?.content_hash !== contentHash };
}

async function fetchText(target: Target, fetcher: typeof fetch) {
  if (target.kind === 'feed') validateGoogleAlertsFeedUrl(target.url);
  else if (target.kind === 'listing' && target.url !== `${BUILTIN}/jobs`) throw new Error('Only the first public listing page is supported.');
  else if (target.kind === 'job') builtinJobUrl(target.url);
  const response = await fetcher(target.url, { headers: { Accept: target.kind === 'feed' ? 'application/atom+xml, application/rss+xml, application/xml' : 'text/html',
    'User-Agent': 'JobSearchHarness/0.1 (local user-requested collection)' }, redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > 3_000_000) throw new Error('Source response exceeds the collection size limit.');
  // Stream with a bound, including for sources without Content-Length.
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    bytes += next.value.length;
    if (bytes > 3_000_000) { await reader.cancel(); throw new Error('Source response exceeds the collection size limit.'); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Only short store.run sections surround network requests; failed targets survive restart. */
export async function runCollection(raw: CollectionRequest, store: JobdeskStore, { fetcher = fetch, delayMs = 1000 }: FetchOptions = {}) {
  const input = collectionRequestSchema.parse(raw);
  const run = await store.run(async (sql) => {
    if (input.runId) {
      const [prior] = await sql`SELECT * FROM job_collection_runs WHERE id=${input.runId}`;
      if (!prior || prior.source !== input.source) throw new JobdeskError('WORKFLOW_REJECTED', 'Collection run not found for this source.');
      if (prior.state === 'running') throw new JobdeskError('WORKFLOW_REJECTED', 'This collection is already running.');
      if (!prior.pending.length) return { ...prior, reused: true };
      await sql`UPDATE job_collection_runs SET state='running',errors='[]',updated_at=clock_timestamp() WHERE id=${prior.id}`;
      return { ...prior, errors: [], counts: { ...prior.counts, failed: 0 }, reused: false };
    }
    const pending: Target[] = input.source === 'builtin'
      ? (input.urls.length ? input.urls.map((url) => ({ kind: 'job', source: 'builtin', url: builtinJobUrl(url) })) : [{ kind: 'listing', source: 'builtin', url: `${BUILTIN}/jobs` }])
      : (await sql`SELECT id,feed_url FROM job_search_queries WHERE enabled=true`).map((query) => ({ kind: 'feed', source: `google-alerts:${query.id}`, url: validateGoogleAlertsFeedUrl(query.feed_url) }));
    if (!pending.length) throw new JobdeskError('WORKFLOW_REJECTED', 'Add an enabled source before collecting.');
    const id = randomUUID();
    const coverage = input.source === 'builtin' ? (input.urls.length ? 'Supplied Built In Chicago job URLs only; no full-site coverage.' : 'Built In Chicago first page only, at most 25 details; no full-site coverage.') : 'Entries currently returned by the enabled Google Alert feeds; no full-site coverage.';
    await sql`INSERT INTO job_collection_runs(id,source,state,coverage,request,pending) VALUES(${id},${input.source},'running',${coverage},${JSON.stringify(input)}::jsonb,${JSON.stringify(pending)}::jsonb)`;
    return { id, source: input.source, coverage, request: input, pending, counts: emptyCounts(), errors: [] as string[], reused: false };
  });
  if (run.reused) return run;
  const pending = run.pending as Target[];
  const failed: Target[] = [];
  const counts: Counts = { ...run.counts };
  const errors: string[] = [];
  const visited = new Set<string>();
  while (pending.length) {
    const target = pending.shift()!;
    if (visited.has(target.url)) continue;
    visited.add(target.url); counts.requested++;
    try {
      if (target.kind === 'feed') await store.run(async (sql) => {
        const rows = await sql`INSERT INTO job_search_usage(usage_month,calls_used,call_cap) VALUES(date_trunc('month',now())::date,1,300)
          ON CONFLICT(usage_month) DO UPDATE SET calls_used=job_search_usage.calls_used+1 WHERE job_search_usage.calls_used<job_search_usage.call_cap RETURNING calls_used`;
        if (!rows.length) throw new Error('Monthly feed poll cap reached.');
      });
      const text = await fetchText(target, fetcher); counts.fetched++;
      if (target.kind === 'listing') {
        const listing = parseBuiltinListing(text);
        pending.push(...listing.urls.map((url): Target => ({ kind: 'job', source: 'builtin', url })));
        counts.parsed++;
      } else {
        const records: SourceRecord[] = target.kind === 'job' ? [parseBuiltinJob(text, target.url)]
          : parseGoogleAlertsFeed(text).map((job) => ({ source: target.source, sourceKey: normalizeSourceUrl(job.url), url: job.url, title: job.title,
            organization: '', location: null, postingText: null, snippet: job.description ?? '', salary: null }));
        counts.parsed += records.length;
        for (const record of records) {
          try { await store.run((_sql) => store.db.transaction(async (tx) => {
            const { parameterizedSql } = await import('./job-storage');
            return saveSourceRecord(record, String(run.id), parameterizedSql(tx));
          })); counts.saved++; }
          catch (error) { throw new Error(`Saving extracted record failed: ${error instanceof Error ? error.message : 'invalid record'}`); }
        }
      }
    } catch (error) {
      failed.push(target); counts.failed++;
      errors.push(`${target.url}: ${error instanceof Error ? error.message : 'Collection failed.'}`);
    }
    await store.run((sql) => sql`UPDATE job_collection_runs SET pending=${JSON.stringify([...pending, ...failed])}::jsonb,
      counts=${JSON.stringify(counts)}::jsonb,errors=${JSON.stringify(errors)}::jsonb,updated_at=clock_timestamp() WHERE id=${run.id}`);
    if (pending.length && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // A first-page pilot is intentionally partial even when every requested page succeeded.
  const state = counts.failed ? (counts.saved || counts.fetched > counts.failed ? 'partial' : 'failed')
    : input.source === 'builtin' && !run.request?.urls?.length ? 'partial' : 'complete';
  await store.run((sql) => sql`UPDATE job_collection_runs SET state=${state},updated_at=clock_timestamp() WHERE id=${run.id}`);
  return { id: run.id, source: run.source, state, coverage: run.coverage, counts, errors, resumable: failed.length > 0 };
}

export async function collectionStatus(sql: Sql) {
  return sql`SELECT id,source,state,coverage,counts,errors,jsonb_array_length(pending)>0 AS resumable,updated_at FROM job_collection_runs ORDER BY created_at DESC LIMIT 20`;
}
