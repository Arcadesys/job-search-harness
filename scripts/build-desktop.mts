/** Stages the desktop app in dist/app: one bundled main process, the prebuilt cockpit,
 * migrations, fonts, the dependency-free MCP scripts and only the packages that cannot be
 * bundled. electron-builder packages that folder (see electron-builder.config.cjs). */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCockpit } from '../services/jobdesk/ui-bundle';

const root = process.cwd();
const out = path.join(root, 'dist', 'app');
// Loaded from disk at run time: PGlite reads its WebAssembly files; pdf.js loads its worker.
const EXTERNAL = ['@electric-sql/pglite', 'pdfjs-dist'];

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'dist', 'cockpit'), { recursive: true });

const cockpit = await buildCockpit();
await writeFile(path.join(out, 'dist', 'cockpit', 'app.js'), cockpit.js);
await writeFile(path.join(out, 'dist', 'cockpit', 'app.css'), cockpit.css);

await build({
  entryPoints: [path.join(root, 'desktop', 'main.ts')],
  outfile: path.join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'esbuild', ...EXTERNAL],
  // Bundled CommonJS has no import.meta; give modules that ask for it the bundle's own URL.
  define: { 'import.meta.url': '__bundleUrl' },
  banner: { js: 'const __bundleUrl = require("node:url").pathToFileURL(__filename).href;' },
  legalComments: 'external',
});

await cp(path.join(root, 'db', 'migrations'), path.join(out, 'db', 'migrations'), { recursive: true });
await cp(path.join(root, 'assets', 'fonts'), path.join(out, 'assets', 'fonts'), { recursive: true });
await cp(path.join(root, 'assets', 'icons'), path.join(out, 'assets', 'icons'), { recursive: true });
for (const name of ['mcp-server.mjs', 'mcp-client.mjs', 'paths.mjs', 'workflow-tools.mjs'])
  await cp(path.join(root, 'services', 'jobdesk', name), path.join(out, 'services', 'jobdesk', name));

const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const exact = (name: string) => lock.packages[`node_modules/${name}`].version as string;
await writeFile(path.join(out, 'package.json'), `${JSON.stringify({
  name: pkg.name, productName: 'Job Search Harness', version: pkg.version, private: true,
  description: 'A private job-search workspace that runs on your own computer.',
  author: pkg.author ?? 'Job Search Harness contributors', license: pkg.license ?? 'UNLICENSED',
  main: 'main.cjs',
  desktopName: 'job-search-harness.desktop',
  dependencies: Object.fromEntries(EXTERNAL.map((name) => [name, exact(name)])),
}, null, 2)}\n`);
execFileSync('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' });
console.log(`Staged ${out}`);
