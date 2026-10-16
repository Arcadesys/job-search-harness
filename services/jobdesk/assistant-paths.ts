import { homedir } from 'node:os';
import path from 'node:path';

export type Where = { platform?: NodeJS.Platform; home?: string; env?: Record<string, string | undefined> };

/** Where each assistant keeps its MCP settings. Kept free of app resources so tests can import it. */
export function assistantPaths({ platform = process.platform, home = homedir(), env = process.env }: Where = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const claudeDir = platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude');
  const codexDir = env.CODEX_HOME || join(home, '.codex');
  return {
    claude: { name: 'Claude Desktop', dir: claudeDir, file: join(claudeDir, 'claude_desktop_config.json') },
    codex: { name: 'ChatGPT desktop or Codex', dir: codexDir, file: join(codexDir, 'config.toml') },
  };
}
