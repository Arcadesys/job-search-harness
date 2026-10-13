import { z } from 'zod';
import type { Sql } from './job-storage';

export const DRAFTING_PROVIDERS = ['none', 'openai', 'anthropic'] as const;
export type DraftingProvider = typeof DRAFTING_PROVIDERS[number];

export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The computer's own zone, so a fresh install needs no configuration. */
export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && validTimeZone(zone) ? zone : 'UTC';
}

export const settingsSchema = z.object({
  timeZone: z.string().min(1).max(64).refine(validTimeZone, 'Choose a valid time zone.'),
  drafting: z.object({
    provider: z.enum(DRAFTING_PROVIDERS),
    model: z.string().trim().max(100),
  }).strict(),
}).strict();
export type JobdeskSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_MODELS: Record<Exclude<DraftingProvider, 'none'>, string> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-opus-5-5',
};

/** Until the user chooses, use whichever provider already has a key in the environment. */
function defaultDrafting(env: Record<string, string | undefined>): JobdeskSettings['drafting'] {
  const provider = env.OPENAI_API_KEY ? 'openai' : env.ANTHROPIC_API_KEY ? 'anthropic' : 'none';
  return { provider, model: provider === 'none' ? '' : DEFAULT_MODELS[provider] };
}

/** The model to call: the saved choice, or the provider's default when left blank. */
export function draftingModel(drafting: JobdeskSettings['drafting']): string {
  return drafting.provider === 'none' ? '' : drafting.model || DEFAULT_MODELS[drafting.provider];
}

export async function readSettings(sql: Sql, env: Record<string, string | undefined> = process.env): Promise<JobdeskSettings> {
  const rows = await sql`SELECT key, value FROM jobdesk_settings WHERE key IN ('timeZone','drafting')`;
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const timeZone = typeof stored.timeZone === 'string' && validTimeZone(stored.timeZone)
    ? stored.timeZone : systemTimeZone();
  const parsed = settingsSchema.shape.drafting.safeParse(stored.drafting);
  return { timeZone, drafting: parsed.success ? parsed.data : defaultDrafting(env) };
}

export async function readTimeZone(sql: Sql): Promise<string> {
  return (await readSettings(sql)).timeZone;
}

export async function saveSettings(input: JobdeskSettings, sql: Sql): Promise<JobdeskSettings> {
  const settings = settingsSchema.parse(input);
  const payload = JSON.stringify([
    { key: 'timeZone', value: settings.timeZone },
    { key: 'drafting', value: settings.drafting },
  ]);
  await sql`INSERT INTO jobdesk_settings (key, value)
    SELECT key, value FROM jsonb_to_recordset(${payload}::jsonb) AS x(key text, value jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`;
  return settings;
}
