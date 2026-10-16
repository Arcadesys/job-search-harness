import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read-only files that ship with the app (migrations, fonts, the prebuilt cockpit).
 * The desktop app sets JOBDESK_RESOURCES because its bundled code has no source tree. */
export function resourceRoot() {
  return process.env.JOBDESK_RESOURCES ?? fileURLToPath(new URL('../', import.meta.url));
}
export const resource = (...parts: string[]) => path.join(resourceRoot(), ...parts);
export const fontDirectory = () => resource('assets', 'fonts');
