#!/usr/bin/env node
import { cp, mkdir, readFile, rm, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Build the macOS installer on a Mac.');
const source = fileURLToPath(new URL('../../', import.meta.url));
const node = process.env.JOBDESK_PACKAGE_NODE || process.execPath;
const version = execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
if (!version.startsWith('22.')) throw new Error('Use an official standalone Node 22 binary via JOBDESK_PACKAGE_NODE.');
const arch = execFileSync(node, ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
if (!['arm64', 'x64'].includes(arch) || arch !== process.arch)
  throw new Error('Build natively with a Node binary matching this Mac architecture.');
const linkage = execFileSync('/usr/bin/otool', ['-L', node], { encoding: 'utf8' });
if (linkage.split('\n').slice(1).some(line => line.trim() && !/^\s*\/(?:usr\/lib|System\/Library)\//.test(line)))
  throw new Error('The Node binary needs non-system libraries. Use the official nodejs.org macOS distribution.');

const directory = path.join(source, 'dist/job-search-harness-macos');
const app = path.join(directory, 'payload/app');
await rm(directory, { recursive: true, force: true });
await mkdir(app, { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'lib', 'services', 'db', 'assets', 'packaging'])
  await cp(path.join(source, name), path.join(app, name), { recursive: true,
    filter: filename => !/\.test\.(?:mjs|ts)$/.test(filename) });
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit' });
await cp(node, path.join(directory, 'payload/node'));
await cp(path.resolve(path.dirname(node), '../LICENSE'), path.join(directory, 'payload/NODE-LICENSE.txt'));
await chmod(path.join(directory, 'payload/node'), 0o755);
const installer = path.join(directory, 'Install Job Search Harness.command');
await cp(path.join(source, 'packaging/macos/Install Job Search Harness.command'), installer);
await chmod(installer, 0o755);
// Prove the copied executable and production-only dependencies can bundle the UI.
execFileSync(path.join(directory, 'payload/node'), ['--input-type=module', '-e',
  'import { build } from "esbuild"; await build({entryPoints:["services/jobdesk/ui.tsx"],bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":"\\"production\\""}});'],
{ cwd: app, stdio: 'inherit' });
// The owner uses tsconfig path aliases; validate its imports outside the repo.
execFileSync(path.join(directory, 'payload/node'), ['--import', 'tsx', '--input-type=module', '-e',
  'await import("./services/jobdesk/server.ts");'], { cwd: app, stdio: 'inherit' });
const manifest = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
console.log(`Packaged ${manifest.name} ${manifest.version} with standalone Node ${version} (${arch}).`);
const archive = path.join(source, `dist/job-search-harness-macos-${arch}.zip`);
await rm(archive, { force: true });
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', directory, archive]);
console.log(archive);
