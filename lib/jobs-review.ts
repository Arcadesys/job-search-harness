import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

type Sql = NeonQueryFunction<false, false>;
export const JOB_REVIEW_TIME_ZONE = 'America/Chicago';
export const REVIEW_EVENT_TYPES = ['kept', 'application', 'reply', 'interview', 'offer'] as const;
export type ReviewEventType = typeof REVIEW_EVENT_TYPES[number];

function db(): Sql {
  const url = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Private job database is not configured.');
  return neon(url);
}

export function centralDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: JOB_REVIEW_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function getReviewWeeks(today = centralDate(), count = 8): string[] {
  if (!isIsoDate(today) || count < 1 || count > 26) throw new Error('Invalid review window.');
  const date = new Date(`${today}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  return Array.from({ length: count }, (_, index) => {
    const week = new Date(date);
    week.setUTCDate(week.getUTCDate() - ((count - 1 - index) * 7));
    return week.toISOString().slice(0, 10);
  });
}

export async function listReviewLeads(sql: Sql = db()) {
  return await sql`SELECT id,title,organization,source_url AS "sourceUrl",decision FROM job_leads WHERE decision <> 'pass' ORDER BY title`;
}

export async function listWeeklyReview(weeks: string[], sql: Sql = db()) {
  if (!weeks.length || weeks.length > 26 || weeks.some((week) => !isIsoDate(week))) throw new Error('Invalid review weeks.');
  const payload = JSON.stringify(weeks.map((week_start) => ({ week_start })));
  return await sql`WITH weeks AS (
      SELECT week_start FROM jsonb_to_recordset(${payload}::jsonb) AS x(week_start date)
    ), leads AS (
      SELECT date_trunc('week', discovered_at AT TIME ZONE ${JOB_REVIEW_TIME_ZONE})::date AS week_start, count(*)::int AS leads
      FROM job_leads GROUP BY 1
    ), events AS (
      SELECT date_trunc('week', occurred_on::timestamp)::date AS week_start,
        count(*) FILTER (WHERE event_type='kept')::int AS kept,
        count(*) FILTER (WHERE event_type='application')::int AS applications,
        count(*) FILTER (WHERE event_type='reply')::int AS replies,
        count(*) FILTER (WHERE event_type='interview')::int AS interviews,
        count(*) FILTER (WHERE event_type='offer')::int AS offers
      FROM job_review_events GROUP BY 1
    )
    SELECT w.week_start AS "weekStart", coalesce(l.leads,0)::int AS leads,
      coalesce(e.kept,0)::int AS kept, coalesce(e.applications,0)::int AS applications,
      coalesce(e.replies,0)::int AS replies, coalesce(e.interviews,0)::int AS interviews,
      coalesce(e.offers,0)::int AS offers, r.reviewed_at AS "reviewedAt"
    FROM weeks w LEFT JOIN leads l USING (week_start) LEFT JOIN events e USING (week_start)
      LEFT JOIN job_review_weeks r USING (week_start) ORDER BY w.week_start DESC`;
}

export async function recordReviewEvent(input: { leadId: string; type: string; date: string; note?: string }, sql: Sql = db()): Promise<void> {
  if (!REVIEW_EVENT_TYPES.includes(input.type as ReviewEventType)) throw new Error('Choose a supported activity type.');
  if (!isIsoDate(input.date)) throw new Error('Enter a valid activity date.');
  if (input.date > centralDate()) throw new Error('Record an activity only after its date has happened.');
  if (!input.leadId || input.leadId.length > 160) throw new Error('Choose a lead.');
  const result = await sql`INSERT INTO job_review_events (lead_id,event_type,occurred_on,note)
    SELECT id,${input.type},${input.date},${(input.note ?? '').slice(0,1000)} FROM job_leads WHERE id=${input.leadId}
    ON CONFLICT (lead_id,event_type,occurred_on) DO UPDATE SET note=EXCLUDED.note RETURNING id`;
  if (!result.length) throw new Error('Lead not found.');
}

export async function markReviewWeekComplete(weekStart: string, sql: Sql = db()): Promise<void> {
  if (!isIsoDate(weekStart) || !getReviewWeeks(weekStart, 1).includes(weekStart)) throw new Error('Invalid review week.');
  await sql`INSERT INTO job_review_weeks (week_start) VALUES (${weekStart})
    ON CONFLICT (week_start) DO UPDATE SET reviewed_at=now()`;
}
