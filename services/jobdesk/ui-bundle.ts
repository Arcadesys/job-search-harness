import { readFile } from 'node:fs/promises';
import { resource } from '../../lib/resources';

const STYLES = ['base.css', 'jobs.css', 'cockpit.css'];

/** Compile the cockpit from source. Used in development and by the desktop build. */
export async function buildCockpit() {
  const { build } = await import('esbuild');
  const built = await build({
    entryPoints: [resource('services', 'jobdesk', 'ui.tsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const css = (await Promise.all(STYLES.map((name) => readFile(resource('services', 'jobdesk', 'ui', name), 'utf8')))).join('\n');
  return { js: built.outputFiles[0].text, css };
}

/** Packaged apps ship a prebuilt cockpit and no compiler; source checkouts compile on start. */
export async function loadCockpit() {
  try {
    const [js, css] = await Promise.all([readFile(resource('dist', 'cockpit', 'app.js'), 'utf8'), readFile(resource('dist', 'cockpit', 'app.css'), 'utf8')]);
    return { js, css };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return buildCockpit();
  }
}
