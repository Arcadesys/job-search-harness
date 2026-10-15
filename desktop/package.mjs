import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'darwin')
  throw new Error('Build the macOS desktop app on a Mac.');

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = await mkdtemp(path.join(tmpdir(), 'job-harness-package-'));
try {
  const payload = path.join(stage, 'app');
  await mkdir(payload);
  // Only these source paths may enter the app. Keep native/WASM assets unpacked.
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'lib', 'services', 'db', 'assets', 'desktop'])
    await cp(path.join(root, name), path.join(payload, name), { recursive: true,
      filter: filename => !/\.test\.(?:mjs|ts)$/.test(filename) });
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: payload, stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const output = await packager({
    dir: payload, out: path.join(root, 'dist'), name: 'Job Search Harness',
    appBundleId: 'me.thearcades.job-search-harness.desktop',
    appCategoryType: 'public.app-category.productivity',
    platform: 'darwin', arch: process.arch,
    electronVersion: manifest.devDependencies.electron,
    asar: false, prune: false, overwrite: true,
  });
  const app = path.join(output[0], 'Job Search Harness.app');
  // Ad hoc signing seals the renamed bundle for local Apple Silicon use.
  // A Developer ID and notarization are separate release steps.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const image = path.join(root, `dist/Job Search Harness-${process.arch}.dmg`);
  const disk = path.join(stage, 'disk');
  await mkdir(disk);
  execFileSync('/usr/bin/ditto', [app, path.join(disk, 'Job Search Harness.app')]);
  await symlink('/Applications', path.join(disk, 'Applications'));
  execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'Job Search Harness', '-srcfolder', disk, '-ov', '-format', 'UDZO', image], { stdio: 'inherit' });
  console.log(`Application: ${app}\nDisk image: ${image}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
