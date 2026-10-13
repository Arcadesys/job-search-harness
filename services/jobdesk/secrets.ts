import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// API keys live in a user-only file beside the database, never in it: backups
// export every table, and they should never carry credentials.
const FILE = 'secrets.json';
const secretsSchema = z.object({ openaiApiKey: z.string().optional(), anthropicApiKey: z.string().optional() }).strict();
type Secrets = z.infer<typeof secretsSchema>;
export type KeyProvider = 'openai' | 'anthropic';
const field = { openai: 'openaiApiKey', anthropic: 'anthropicApiKey' } as const;
const envName = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' } as const;

async function readSecrets(root: string): Promise<Secrets> {
  try {
    return secretsSchema.parse(JSON.parse(await readFile(path.join(root, FILE), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('The private API key file is unreadable. Re-enter your key in Settings.');
  }
}

/** An environment variable (set by an installer or the user) wins over the saved key. */
export async function apiKeyFor(root: string, provider: KeyProvider, env = process.env): Promise<string | undefined> {
  return env[envName[provider]] || (await readSecrets(root))[field[provider]] || undefined;
}

/** Which keys exist, never their values. */
export async function apiKeyStatus(root: string, env = process.env): Promise<Record<KeyProvider, boolean>> {
  return {
    openai: Boolean(await apiKeyFor(root, 'openai', env)),
    anthropic: Boolean(await apiKeyFor(root, 'anthropic', env)),
  };
}

/** Saves or, with an empty key, removes one provider's key. Written atomically, mode 0600. */
export async function saveApiKey(root: string, provider: KeyProvider, key: string): Promise<void> {
  const value = key.trim();
  if (value.length > 500 || /\s/.test(value)) throw new Error('That does not look like an API key.');
  const secrets = await readSecrets(root);
  if (value) secrets[field[provider]] = value;
  else delete secrets[field[provider]];
  const temporary = path.join(root, `.${FILE}.${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path.join(root, FILE));
}
