/** Loopback-only fixture. Renders production components and runs production SQL
 * against an isolated disk database. No production auth bypass or credentials. */
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { listResumeTruth, listResumeTruthVersions, reviewResumeTruth, seedResumeTruth } from '../../lib/resume-truth';
import { handleTruthReview } from '../../lib/resume-truth-http';
import { sqlAdapter } from './truth-database';

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'truth-browser-db-'));
  let db = new PGlite(directory);
  const migration = await readFile('db/migrations/0001_resume_truth.sql', 'utf8');
  await db.exec(migration); await seedResumeTruth(sqlAdapter(db));
  const built = await build({ entryPoints: ['tests/fixtures/truth-review-entry.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{
    name: 'fixture-link', setup(plugin) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }', resolveDir: process.cwd(), loader: 'js' }));
    },
  }] });
  let fontCss = ':root { --font-sans: Arial, sans-serif; }';
  let font: Buffer | undefined;
  try {
    for (const file of await readdir('.next/static/chunks')) {
      if (!file.endsWith('.css')) continue;
      const css = await readFile(path.join('.next/static/chunks', file), 'utf8');
      const face = css.match(/@font-face\{font-family:Inter;[^}]*unicode-range:U\+0-FF[^}]*\}/i)?.[0];
      const media = face?.match(/url\(\.\.\/media\/([^)]*)\)/)?.[1];
      if (face && media) {
        font = await readFile(path.join('.next/static/media', media));
        fontCss = face.replace(/url\([^)]*\)/, 'url(/fixture-font.woff2)') + ':root { --font-sans: Inter, Arial, sans-serif; }';
        break;
      }
    }
  } catch { /* Fresh checkouts can test before their first Next build. */ }
  const globals = await readFile('app/globals.css', 'utf8');
  const styles = await readFile('app/jobs/jobs.css', 'utf8');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1:3101');
      res.setHeader('Cache-Control', 'private, no-store');
      if (url.pathname === '/fixture-font.woff2' && font) { res.setHeader('Content-Type', 'font/woff2'); res.end(font); return; }
      if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(built.outputFiles[0].text); return; }
      if (url.pathname === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(`${globals}\n${styles}\n${fontCss}`); return; }
      if (url.pathname === '/__test/reset' && req.method === 'POST') { await db.exec('TRUNCATE resume_truth_versions, resume_truth_claims RESTART IDENTITY'); await seedResumeTruth(sqlAdapter(db)); res.end('{}'); return; }
      if (url.pathname === '/__test/restart' && req.method === 'POST') { await db.close(); db = new PGlite(directory); res.end('{}'); return; }
      if (url.pathname === '/api/jobs/resume-truth') {
        const sql = sqlAdapter(db);
        if (req.method === 'POST') {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const response = await handleTruthReview(new Request(url, { method: 'POST', body: Buffer.concat(chunks).toString() }), {
            authorize: async () => req.headers['x-test-unauthorized'] ? null : 'isolated-test-account',
            save: (changes) => reviewResumeTruth(changes, sql), list: () => listResumeTruth(sql),
          });
          res.statusCode = response.status; res.setHeader('Content-Type', 'application/json'); res.end(await response.text()); return;
        }
        res.setHeader('Content-Type', 'application/json');
        const id = url.searchParams.get('id'); res.end(JSON.stringify(id ? { versions: await listResumeTruthVersions(id, sql) } : { claims: await listResumeTruth(sql) })); return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated truth review</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    } catch (error) { console.error(error); res.statusCode = 500; res.end(JSON.stringify({ error: 'Fixture failed' })); }
  });
  server.listen(3101, '127.0.0.1', () => console.log('Isolated truth review: http://127.0.0.1:3101'));
  const close = () => server.close(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); });
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
main().catch((error) => { console.error(error); process.exit(1); });
