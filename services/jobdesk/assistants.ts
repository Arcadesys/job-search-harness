import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resource } from '../../lib/resources';
import { JobdeskError } from './errors';
import { assistantPaths, type Where } from './assistant-paths';

export { assistantPaths };

/** Writes this app's MCP server into the user's assistant configuration, so nobody
 * has to edit JSON or TOML by hand. Only our own entry is ever added or replaced. */
export const SERVER_NAME = 'job-search-harness';
export type AssistantId = 'claude' | 'codex';
export type Launch = { command: string; args: string[]; env?: Record<string, string> };

/** The desktop app passes a stable launcher; a source checkout runs the script with Node. */
export function launchSpec(env: Record<string, string | undefined> = process.env): Launch {
  if (env.JOBDESK_MCP_LAUNCH) return JSON.parse(env.JOBDESK_MCP_LAUNCH) as Launch;
  return { command: process.execPath, args: [resource('services', 'jobdesk', 'mcp-server.mjs')],
    ...(env.JOBDESK_DATA_DIR ? { env: { JOBDESK_DATA_DIR: env.JOBDESK_DATA_DIR } } : {}) };
}

const sameLaunch = (a: Partial<Launch> | undefined, b: Launch) =>
  !!a && a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args) && JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {});

/** TOML basic strings accept JSON string escapes for everything a path can contain. */
const tomlString = (value: string) => JSON.stringify(value);
export function codexBlock(launch: Launch) {
  const lines = [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(launch.command)}`, `args = [${launch.args.map(tomlString).join(', ')}]`];
  if (launch.env && Object.keys(launch.env).length)
    lines.push(`env = { ${Object.entries(launch.env).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`);
  return `${lines.join('\n')}\n`;
}
/** Remove our table and any of its sub-tables, leaving every other line as written. */
export function withoutCodexEntry(toml: string) {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split('\n')) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line)?.[1];
    if (header !== undefined) skipping = header === `mcp_servers.${SERVER_NAME}` || header.startsWith(`mcp_servers.${SERVER_NAME}.`);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
export function codexEntry(toml: string): Launch | undefined {
  const start = toml.split('\n').findIndex((line) => line.trim() === `[mcp_servers.${SERVER_NAME}]`);
  if (start < 0) return undefined;
  const body = toml.split('\n').slice(start + 1);
  const end = body.findIndex((line) => /^\s*\[/.test(line));
  const text = (end < 0 ? body : body.slice(0, end)).join('\n');
  const command = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(text)?.[1];
  const args = /^\s*args\s*=\s*(\[.*\])/m.exec(text)?.[1];
  const env = /^\s*env\s*=\s*\{(.*)\}/m.exec(text)?.[1];
  try {
    return { command: JSON.parse(command ?? '""'), args: JSON.parse(args ?? '[]'),
      ...(env ? { env: Object.fromEntries([...env.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")/g)].map((m) => [m[1], JSON.parse(m[2])])) } : {}) };
  } catch { return undefined; }
}

async function readText(file: string) {
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw new JobdeskError('WORKFLOW_REJECTED', `${file} is a link to another file, so it was left unchanged. Add the connection by hand instead.`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
/** Back up, then replace atomically, keeping the original file's permissions. If the assistant
 * rewrote its settings while we worked, nothing is written. */
async function replaceFile(file: string, text: string, original: string | null) {
  await mkdir(path.dirname(file), { recursive: true });
  const mode = original === null ? 0o600 : (await stat(file)).mode & 0o777;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode });
  if (await readText(file) !== original) {
    await rm(temporary, { force: true });
    throw new JobdeskError('WORKFLOW_REJECTED', 'The settings file changed while connecting, so nothing was overwritten. Try again.');
  }
  if (original !== null) await copyFile(file, `${file}.before-job-search-harness`);
  await rename(temporary, file);
}

/** Entries this app wrote: the desktop app's copy, a source checkout, or the earlier macOS installer. */
export function isOurEntry(entry: Partial<Launch> | undefined) {
  const script = entry?.args?.find((arg) => /[\\/]mcp-server\.mjs$/.test(arg)) ?? '';
  return Boolean(script) && (/[\\/]services[\\/]jobdesk[\\/]mcp-server\.mjs$/.test(script) || /[\\/]mcp[\\/][^\\/]+[\\/]mcp-server\.mjs$/.test(script)
    || /Job Search Harness|job-search-harness/i.test(`${entry?.command} ${script}`));
}

async function current(id: AssistantId, where: Where) {
  const target = assistantPaths(where)[id];
  const text = await readText(target.file);
  if (id === 'codex') return { target, text, entry: text === null ? undefined : codexEntry(text), parsed: null };
  let parsed: any = {};
  const invalid = (problem: string) => new JobdeskError('WORKFLOW_REJECTED', `${target.name}'s settings file ${problem}, so it was left unchanged. Fix or remove ${target.file}, then try again.`);
  if (text !== null && text.trim()) {
    try { parsed = JSON.parse(text); } catch { throw invalid('is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('is not a JSON object');
    if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)))
      throw invalid('has an unexpected mcpServers section');
  }
  return { target, text, entry: parsed?.mcpServers?.[SERVER_NAME] as Launch | undefined, parsed };
}

export async function assistantStatus(where: Where = {}, launch = launchSpec(where.env)) {
  return Promise.all((['claude', 'codex'] as const).map(async (id) => {
    const target = assistantPaths(where)[id];
    let entry: Launch | undefined, error = '';
    try { entry = (await current(id, where)).entry; } catch (cause) { error = cause instanceof Error ? cause.message : 'Unreadable settings.'; }
    return { id, name: target.name, detected: existsSync(target.dir), connected: Boolean(entry), current: sameLaunch(entry, launch),
      foreign: Boolean(entry) && !isOurEntry(entry), configPath: target.file, error };
  }));
}

/** An unfamiliar entry under our name is only replaced when the person explicitly says so. */
export async function connectAssistant(id: AssistantId, where: Where = {}, launch = launchSpec(where.env), { replace = false } = {}) {
  const { target, text, parsed, entry } = await current(id, where);
  if (entry && !isOurEntry(entry) && !replace)
    throw new JobdeskError('WORKFLOW_REJECTED', `${target.name} already has a different job-search-harness connection. Review it, or choose Replace to use this app instead. No settings were changed.`);
  if (id === 'claude') {
    const next = { ...parsed, mcpServers: { ...(parsed?.mcpServers ?? {}), [SERVER_NAME]: launch } };
    await replaceFile(target.file, `${JSON.stringify(next, null, 2)}\n`, text);
  } else {
    const rest = text === null ? '' : withoutCodexEntry(text);
    await replaceFile(target.file, `${rest ? `${rest}\n\n` : ''}${codexBlock(launch)}`, text);
  }
  return { id, name: target.name, configPath: target.file, restart: `Quit and reopen ${target.name} to finish connecting.` };
}

/** When the app moves (for example a new AppImage, or after the earlier macOS installer),
 * repair only entries this app wrote. */
export async function repairConnections(where: Where = {}, launch = launchSpec(where.env)) {
  const repaired: AssistantId[] = [];
  for (const status of await assistantStatus(where, launch))
    if (status.connected && !status.current && !status.foreign && !status.error) { await connectAssistant(status.id, where, launch); repaired.push(status.id); }
  return repaired;
}
