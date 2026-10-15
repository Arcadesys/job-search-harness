import { createHash } from 'node:crypto';
import type { Sql } from './job-storage';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

export const SEARCH_CAP = 300;
export const MAX_SEARCHES = 20;
export const searchQuerySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/).optional(),
  lane: z.string().trim().min(1).max(120),
  location: z.string().trim().max(120),
  query: z.string().trim().min(8).max(500),
  feedUrl: z.string().trim().max(2000),
  enabled: z.boolean(),
}).strict();
export type SearchQueryInput = z.input<typeof searchQuerySchema>;

export type SearchResult = { title: string; url: string; description?: string; age?: string; profile?: { long_name?: string; name?: string } };


export function normalizeSourceUrl(input: string): string {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Lead URL must use HTTP or HTTPS.');
  if (['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase())) {
    const job = url.pathname.match(/^\/(?:comm\/)?jobs\/view\/(\d+)\/?$/);
    if (job) return `https://linkedin.com/jobs/view/${job[1]}`;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function leadIdForUrl(url: string): string { return createHash('sha256').update(normalizeSourceUrl(url)).digest('hex'); }

export function validateGoogleAlertsFeedUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' || !['google.com', 'www.google.com'].includes(url.hostname.toLowerCase()) ||
    !/^\/alerts\/feeds\/\d+\/\d+\/?$/.test(url.pathname) || url.username || url.password) {
    throw new Error('Use the RSS feed URL copied from a Google Alert.');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function plainText(input: unknown): string {
  const value = typeof input === 'string' ? input : input && typeof input === 'object' ? String((input as Record<string, unknown>)['#text'] ?? '') : '';
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function parseGoogleAlertsFeed(xml: string): SearchResult[] {
  if (xml.length > 2_000_000) throw new Error('Google Alert feed is too large.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Google Alert returned invalid XML.');
  const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true }).parse(xml);
  if (!Object.hasOwn(document ?? {}, 'feed') && !document?.rss?.channel) throw new Error('Google Alert did not return a feed.');
  const entries = document?.feed?.entry ?? document?.rss?.channel?.item ?? [];
  const items = Array.isArray(entries) ? entries : [entries];
  return items.slice(0, 50).map((entry: Record<string, unknown>) => {
    const links = Array.isArray(entry.link) ? entry.link : [entry.link];
    const selected = links.find((link) => link && typeof link === 'object' && ((link as Record<string, unknown>)['@_rel'] === 'alternate' || !(link as Record<string, unknown>)['@_rel'])) ?? links[0];
    let url = typeof selected === 'string' ? selected : String((selected as Record<string, unknown> | undefined)?.['@_href'] ?? '');
    try {
      const parsed = new URL(url);
      if (['google.com', 'www.google.com'].includes(parsed.hostname) && parsed.pathname === '/url') url = parsed.searchParams.get('url') ?? url;
    } catch { /* invalid links are discarded by ingestion */ }
    return { title: plainText(entry.title), url, description: plainText(entry.content ?? entry.summary ?? entry.description) };
  }).filter((entry: SearchResult) => entry.title && entry.url);
}

export async function listSearchQueries(sql: Sql) {
  return await sql`SELECT id,lane,location,query,feed_url AS "feedUrl",enabled FROM job_search_queries ORDER BY id`;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'search';

/** Replaces the whole list. Existing IDs are kept so lead provenance
 * (google-alerts:<id>) stays meaningful; new searches get readable IDs. */
export async function saveSearchQueries(raw: SearchQueryInput[], sql: Sql): Promise<void> {
  if (raw.length > MAX_SEARCHES) throw new Error(`Keep at most ${MAX_SEARCHES} searches.`);
  const queries = raw.map((item) => searchQuerySchema.parse(item));
  const used = new Set(queries.flatMap((item) => item.id ? [item.id] : []));
  if (used.size !== queries.filter((item) => item.id).length) throw new Error('Each search must appear once.');
  const payload = JSON.stringify(queries.map((item) => {
    let id = item.id;
    if (!id) {
      const base = slug(`${item.lane} ${item.location}`);
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
    }
    return { id, lane: item.lane, location: item.location, query: item.query,
      feedUrl: item.feedUrl ? validateGoogleAlertsFeedUrl(item.feedUrl) : '', enabled: item.enabled };
  }));
  await sql`WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb)
        AS x(id text, lane text, location text, query text, "feedUrl" text, enabled boolean)
    ), removed AS (
      DELETE FROM job_search_queries WHERE id NOT IN (SELECT id FROM incoming)
    ) INSERT INTO job_search_queries (id,lane,location,query,feed_url,enabled)
      SELECT id,lane,location,query,"feedUrl",enabled FROM incoming
      ON CONFLICT (id) DO UPDATE SET lane=EXCLUDED.lane,location=EXCLUDED.location,query=EXCLUDED.query,
        feed_url=EXCLUDED.feed_url,enabled=EXCLUDED.enabled,updated_at=now()`;
}

export async function saveManualLead(input: { url: string; title: string; organization?: string; location?: string; notes?: string }, sql: Sql): Promise<void> {
  const sourceUrl = normalizeSourceUrl(input.url);
  const title = input.title.trim();
  if (!title || title.length > 250) throw new Error('Add a title up to 250 characters.');
  await sql`INSERT INTO job_leads (id,source_url,title,organization,location,source,notes)
    VALUES (${leadIdForUrl(sourceUrl)},${sourceUrl},${title},${input.organization?.trim().slice(0,200) ?? ''},${input.location?.trim().slice(0,160) ?? ''},'manual',${input.notes?.trim().slice(0,4000) ?? ''})
    ON CONFLICT (source_url) DO UPDATE SET last_checked_at=now(),updated_at=now()`;
}

export async function updateLead(input: { id: string; decision?: string; stage?: string; verification?: string; nextAction?: string; nextActionDate?: string; notes?: string }, sql: Sql): Promise<void> {
  const decision = input.decision ?? 'review';
  const stage = input.stage || null;
  const verification = input.verification ?? 'unverified';
  if (!['review','keep','pass'].includes(decision) || (stage && !['researching','preparing','applied','interviewing','offer','closed'].includes(stage)) || !['unverified','verified','stale','unavailable'].includes(verification)) throw new Error('Invalid job status.');
  await sql`UPDATE job_leads SET decision=${decision},application_stage=${stage},verification_status=${verification},next_action=${(input.nextAction ?? '').slice(0,500)},next_action_date=${input.nextActionDate || null},notes=${(input.notes ?? '').slice(0,4000)},updated_at=now() WHERE id=${input.id}`;
}

export async function listLeads(sql: Sql) {
  return await sql`SELECT id,source_url AS "sourceUrl",title,organization,location,snippet,source,discovered_at AS "discoveredAt",last_checked_at AS "lastCheckedAt",verification_status AS "verificationStatus",decision,application_stage AS "applicationStage",next_action AS "nextAction",next_action_date AS "nextActionDate",notes FROM job_leads ORDER BY CASE decision WHEN 'keep' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, COALESCE(next_action_date,discovered_at::date), discovered_at DESC`;
}

export async function listSearchStatus(sql: Sql) {
  const [usage, runs] = await Promise.all([
    sql`SELECT usage_month AS month,calls_used AS "callsUsed",call_cap AS "callCap" FROM job_search_usage WHERE usage_month=date_trunc('month',now())::date`,
    sql`SELECT run_date AS date,status,started_at AS "startedAt",completed_at AS "completedAt",queries_attempted AS "queriesAttempted",results_seen AS "resultsSeen",new_leads AS "newLeads",calls_used AS "callsUsed",error_message AS "errorMessage" FROM job_search_runs ORDER BY run_date DESC LIMIT 8`,
  ]);
  return { usage: usage[0] ?? { callsUsed: 0, callCap: SEARCH_CAP }, runs };
}

async function reserveCall(sql: Sql): Promise<boolean> {
  const result = await sql`INSERT INTO job_search_usage (usage_month,calls_used,call_cap)
    VALUES (date_trunc('month',now())::date,1,${SEARCH_CAP})
    ON CONFLICT (usage_month) DO UPDATE SET calls_used=job_search_usage.calls_used+1,updated_at=now()
    WHERE job_search_usage.calls_used < ${SEARCH_CAP}
    RETURNING calls_used`;
  return result.length > 0;
}

export async function ingestSearchResults(results: SearchResult[], queryId: string, sql: Sql): Promise<{ seen: number; created: number }> {
  const leads: Array<{ id: string; source_url: string; title: string; organization: string; snippet: string; source: string }> = [];
  const sourceUrls = new Set<string>();
  for (const result of results) {
    if (!result.url || !result.title) continue;
    let sourceUrl: string;
    try { sourceUrl = normalizeSourceUrl(result.url); } catch { continue; }
    if (sourceUrls.has(sourceUrl)) continue;
    sourceUrls.add(sourceUrl);
    leads.push({ id: leadIdForUrl(sourceUrl), source_url: sourceUrl, title: result.title.slice(0,250), organization: result.profile?.long_name ?? result.profile?.name ?? '', snippet: result.description?.slice(0,3000) ?? '', source: `google-alerts:${queryId}` });
  }
  if (!leads.length) return { seen: 0, created: 0 };
  const payload = JSON.stringify(leads);
  const rows = await sql`WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS x(id text,source_url text,title text,organization text,snippet text,source text)
    ) INSERT INTO job_leads (id,source_url,title,organization,snippet,source)
      SELECT id,source_url,title,organization,snippet,source FROM incoming
      ON CONFLICT (source_url) DO UPDATE SET title=EXCLUDED.title,snippet=EXCLUDED.snippet,last_seen_at=now(),last_checked_at=now(),updated_at=now()
      RETURNING (xmax = 0) AS inserted`;
  const created = rows.filter((row) => row.inserted === true || row.inserted === 't').length;
  return { seen: leads.length, created };
}

export type LinkedInEmailLead = { title: string; organization: string; location: string; url: string; receivedAt?: string };

export function parseLinkedInAlertEmailText(text: string): LinkedInEmailLead[] {
  if (text.length > 150_000) throw new Error('LinkedIn alert email is too large.');
  const leads: LinkedInEmailLead[] = [];
  for (const segment of text.split(/-{20,}/)) {
    const link = segment.match(/View job:\s*(https:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)[^\s]*)/i);
    if (!link) continue;
    let before = segment.slice(0, link.index);
    const intro = before.match(/(?:New jobs match|A new job matches) your preferences\./i);
    if (intro?.index !== undefined) before = before.slice(intro.index + intro[0].length);
    const lines = before.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 3 || /^Your job alert|^A new job matches/i.test(lines[0])) continue;
    leads.push({ title: lines[0].slice(0, 250), organization: lines[1].slice(0, 200), location: lines[2].slice(0, 160), url: `https://linkedin.com/jobs/view/${link[2]}` });
  }
  return leads;
}

export async function ingestLinkedInEmailLeads(leads: LinkedInEmailLead[], sql: Sql): Promise<{ seen: number; created: number }> {
  const unique = new Map<string, LinkedInEmailLead>();
  for (const item of leads) {
    if (!item.title.trim() || !item.organization.trim()) continue;
    let url: string;
    try { url = normalizeSourceUrl(item.url); } catch { continue; }
    if (!/^https:\/\/linkedin\.com\/jobs\/view\/\d+$/.test(url)) continue;
    unique.set(url, { ...item, url });
  }
  if (!unique.size) return { seen: 0, created: 0 };
  const payload = JSON.stringify([...unique.values()].map((item) => ({
    id: leadIdForUrl(item.url), source_url: item.url, title: item.title.trim().slice(0, 250),
    organization: item.organization.trim().slice(0, 200), location: item.location.trim().slice(0, 160),
    received_at: item.receivedAt && !Number.isNaN(Date.parse(item.receivedAt)) ? new Date(item.receivedAt).toISOString() : new Date().toISOString(),
  })));
  const rows = await sql`WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS x(id text,source_url text,title text,organization text,location text,received_at timestamptz)
    ) INSERT INTO job_leads (id,source_url,title,organization,location,source,discovered_at,notes)
      SELECT id,source_url,title,organization,location,'linkedin-email',received_at,'From a LinkedIn job alert email. Original posting not yet verified.' FROM incoming
      ON CONFLICT (source_url) DO UPDATE SET last_checked_at=now(),updated_at=now()
      RETURNING (xmax = 0) AS inserted`;
  return { seen: unique.size, created: rows.filter((row) => row.inserted === true || row.inserted === 't').length };
}

export type ScanDependencies = { sql: Sql; fetcher?: typeof fetch; now?: Date };
export async function runDailySearch({ sql, fetcher = fetch, now = new Date() }: ScanDependencies) {
  const date = now.toISOString().slice(0, 10);
  const started = await sql`INSERT INTO job_search_runs (run_date,status) VALUES (${date},'running')
    ON CONFLICT (run_date) DO UPDATE SET
      status='running',started_at=now(),completed_at=NULL,
      queries_attempted=0,results_seen=0,new_leads=0,calls_used=0,error_message=''
    WHERE job_search_runs.status='failed'
    RETURNING run_date`;
  if (!started.length) return { skipped: true, reason: 'already-run' };
  let calls = 0, attempted = 0, seen = 0, added = 0;
  try {
    const queries = await sql`SELECT id,query,feed_url AS "feedUrl" FROM job_search_queries WHERE enabled=true ORDER BY id` as Array<{ id: string; query: string; feedUrl: string }>;
    if (!queries.length) throw new Error('Add and enable at least one search with a Google Alert feed before scanning.');
    const failures: string[] = [];
    for (const item of queries) {
      if (!item.feedUrl) { failures.push(`${item.id}: Google Alert RSS feed URL is missing.`); continue; }
      try {
        const feedUrl = validateGoogleAlertsFeedUrl(item.feedUrl);
        if (!await reserveCall(sql)) throw new Error(`Monthly feed poll cap (${SEARCH_CAP}) reached.`);
        calls++; attempted++;
        const response = await fetcher(feedUrl, { headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml' }, signal: AbortSignal.timeout(8000), cache: 'no-store', redirect: 'error' });
        if (!response.ok) throw new Error(`Google Alert returned HTTP ${response.status}.`);
        const results = parseGoogleAlertsFeed(await response.text());
        const ingested = await ingestSearchResults(results, item.id, sql);
        seen += ingested.seen; added += ingested.created;
      } catch (error) { failures.push(`${item.id}: ${error instanceof Error ? error.message : 'Feed poll failed.'}`); }
    }
    const status = failures.length ? 'failed' : 'succeeded';
    const errorMessage = failures.join(' ').slice(0, 1000);
    await sql`UPDATE job_search_runs SET status=${status},completed_at=now(),queries_attempted=${attempted},results_seen=${seen},new_leads=${added},calls_used=${calls},error_message=${errorMessage} WHERE run_date=${date}`;
    return { skipped: false, status, attempted, seen, added, calls, error: errorMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Search run failed.';
    await sql`UPDATE job_search_runs SET status='failed',completed_at=now(),queries_attempted=${attempted},results_seen=${seen},new_leads=${added},calls_used=${calls},error_message=${message} WHERE run_date=${date}`;
    return { skipped: false, status: 'failed', attempted, seen, added, calls, error: message };
  }
}
