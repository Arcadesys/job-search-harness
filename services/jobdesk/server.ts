import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { chmod, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { handleTruthReview } from '../../lib/resume-truth-http';
import { JobdeskStore, DEFAULT_ROOT } from './store';
import { createService, initializeService } from './service';
import { JobdeskError } from './errors';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
async function body(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new Error('JSON content type required.');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 500_000) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { ...PRIVATE_HEADERS, 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}
function listen(server: Server, endpoint: string | number) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (typeof endpoint === 'string') server.listen(endpoint, resolve);
    else server.listen(endpoint, '127.0.0.1', resolve);
  });
}
function close(server: Server) {
  server.closeIdleConnections();
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function startJobdesk({
  root = DEFAULT_ROOT,
  port = 0,
}: { root?: string; port?: number } = {}) {
  const store = await JobdeskStore.open(root);
  let ipc: Server | undefined;
  let web: Server | undefined;
  try {
    await initializeService(store);
    const service = createService(store);
    const sessions = new Map<string, { csrf: string; expires: number }>();
    const tickets = new Map<string, number>();
    const socketPath = path.join(store.root, 'broker.sock');
    // Only the sole database owner can replace its own stale socket, after the
    // database lock has been acquired. It is never a remote listener.
    await rm(socketPath, { force: true });
    const built = await build({
      entryPoints: [fileURLToPath(new URL('./ui.tsx', import.meta.url))],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [
        {
          name: 'local-links',
          setup(plugin) {
            plugin.onResolve({ filter: /^next\/link$/ }, () => ({
              path: 'link',
              namespace: 'local',
            }));
            plugin.onLoad({ filter: /.*/, namespace: 'local' }, () => ({
              contents:
                'import React from "react"; export default function Link(props){return React.createElement("a",props);}',
              resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
              loader: 'js',
            }));
          },
        },
      ],
    });
    const css =
      (await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8')) +
      '\n' +
      (await readFile(new URL('../../app/jobs/jobs.css', import.meta.url), 'utf8')) +
      '\n:root{--font-sans:Arial,sans-serif}';
    let origin = '';
    web = createServer(async (req, res) => {
      try {
        const allowedHost = new URL(origin).host;
        if (
          req.headers.host !== allowedHost ||
          req.headers['x-forwarded-host'] ||
          req.headers['x-forwarded-for'] ||
          (req.headers.origin && req.headers.origin !== origin) ||
          req.headers['sec-fetch-site'] === 'cross-site'
        ) {
          json(res, 403, { error: 'Unexpected host or origin.' });
          return;
        }
        const url = new URL(req.url ?? '/', origin);
        if (req.method === 'GET' && url.pathname === '/app.js') {
          res.writeHead(200, { ...PRIVATE_HEADERS, 'Content-Type': 'text/javascript' });
          res.end(built.outputFiles[0].text);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/app.css') {
          res.writeHead(200, { ...PRIVATE_HEADERS, 'Content-Type': 'text/css' });
          res.end(css);
          return;
        }
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/jobs'))) {
          res.writeHead(200, {
            ...PRIVATE_HEADERS,
            'Content-Type': 'text/html',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          });
          res.end(
            '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local Job Desk</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
          );
          return;
        }
        if (req.method === 'POST' && url.pathname === '/session') {
          if (req.headers.origin !== origin) {
            json(res, 403, { error: 'Same-origin session launch required.' });
            return;
          }
          const input = await body(req);
          const key = typeof input.ticket === 'string' ? hash(input.ticket) : '';
          const expires = tickets.get(key);
          tickets.delete(key);
          if (!expires || expires < Date.now()) {
            json(res, 401, {
              error: 'Launch link expired. Open Jobdesk again from its local command.',
            });
            return;
          }
          const cookie = randomBytes(32).toString('base64url'),
            csrf = randomBytes(32).toString('base64url');
          sessions.set(hash(cookie), { csrf, expires: Date.now() + 8 * 60 * 60 * 1000 });
          res.setHeader(
            'Set-Cookie',
            `jobdesk_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
          );
          json(res, 200, { csrf });
          return;
        }
        const cookie = /(?:^|;\s*)jobdesk_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(
          req.headers.cookie ?? '',
        )?.[1];
        const session = cookie ? sessions.get(hash(cookie)) : undefined;
        if (!session || session.expires < Date.now()) {
          json(res, 401, { error: 'Open Jobdesk using its local command to sign in.' });
          return;
        }
        if (
          req.method !== 'GET' &&
          (req.headers.origin !== origin || req.headers['x-jobdesk-csrf'] !== session.csrf)
        ) {
          json(res, 403, { error: 'Same-origin request and CSRF token required.' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/session') {
          json(res, 200, { csrf: session.csrf });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/logout') {
          sessions.delete(hash(cookie!));
          res.setHeader(
            'Set-Cookie',
            'jobdesk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
          );
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/jobs/resume-truth') {
          if (req.method === 'GET') {
            const id = url.searchParams.get('id');
            json(
              res,
              200,
              id
                ? { versions: await service({ method: 'truth.versions', args: [id] }) }
                : { claims: await service({ method: 'truth.list', args: [] }) },
            );
            return;
          }
          if (req.method === 'POST') {
            const response = await handleTruthReview(
              new Request(url, { method: 'POST', body: JSON.stringify(await body(req)) }),
              {
                authorize: async () => 'local-user',
                save: async (changes) =>
                  (await service({ method: 'truth.review', args: [{ changes }] })) as Awaited<
                    ReturnType<typeof import('../../lib/resume-truth').reviewResumeTruth>
                  >,
                list: async () =>
                  (await service({ method: 'truth.list', args: [] })) as Awaited<
                    ReturnType<typeof import('../../lib/resume-truth').listResumeTruth>
                  >,
              },
            );
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(await response.text());
            return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/jobdesk') {
          const input = await body(req);
          if (
            input.method === 'browser.open' ||
            input.method === 'submission.begin' ||
            input.method === 'submission.record' ||
            input.method === 'items.claim' ||
            input.method === 'items.renew' ||
            input.method === 'items.status'
          ) {
            json(res, 403, { error: 'This operation requires the local worker connection.' });
            return;
          }
          json(res, 200, { data: await service(input) });
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
          const id = url.pathname.slice('/artifacts/'.length);
          if (!/^[a-f0-9-]{36}$/.test(id)) {
            json(res, 404, { error: 'Artifact not found.' });
            return;
          }
          const rows = await store.run(
            (sql) => sql`SELECT relative_path FROM jobdesk_artifacts WHERE id=${id}`,
          );
          if (!rows[0]) {
            json(res, 404, { error: 'Artifact not found.' });
            return;
          }
          res.writeHead(200, {
            ...PRIVATE_HEADERS,
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="application-review-packet.pdf"',
          });
          res.end(await readFile(path.join(store.root, rows[0].relative_path)));
          return;
        }
        json(res, 404, { error: 'Not found.' });
      } catch {
        json(res, 400, {
          error:
            'Request failed. Check its inputs and current state; reconcile submission attempts before retrying.',
        });
      }
    });
    await listen(web, port);
    const address = web.address();
    if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable.');
    origin = `http://127.0.0.1:${address.port}`;
    ipc = createServer(async (req, res) => {
      if (
        req.method !== 'POST' ||
        req.url !== '/rpc' ||
        req.headers.host !== 'jobdesk' ||
        req.headers.origin
      ) {
        json(res, 403, { error: 'Local IPC request required.' });
        return;
      }
      try {
        const input = await body(req);
        if (input.method === 'browser.open') {
          if (!Array.isArray(input.args) || input.args.length)
            throw new Error('Invalid launch arguments.');
          for (const [key, expires] of tickets) if (expires < Date.now()) tickets.delete(key);
          const ticket = randomBytes(32).toString('base64url');
          tickets.set(hash(ticket), Date.now() + 60_000);
          json(res, 200, { data: { url: `${origin}/#ticket=${ticket}` } });
          return;
        }
        json(res, 200, { data: await service(input) });
      } catch (error) {
        json(res, 409, {
          ...(error instanceof JobdeskError ? { code: error.code } : {}),
          error: error instanceof JobdeskError ? error.message :
            'Jobdesk rejected the operation. Check input, ownership, versions, leases, and submission reconciliation.',
        });
      }
    });
    await listen(ipc, socketPath);
    await chmod(socketPath, 0o600);
    return {
      store,
      origin,
      socketPath,
      service,
      close: async () => {
        await close(ipc!);
        await close(web!);
        await store.close();
        await rm(socketPath, { force: true });
      },
    };
  } catch (error) {
    if (ipc?.listening) await close(ipc);
    if (web?.listening) await close(web);
    await store.close();
    throw error;
  }
}

async function main() {
  const runtime = await startJobdesk({
    root: process.env.JOBDESK_DATA_DIR ?? DEFAULT_ROOT,
    port: Number(process.env.JOBDESK_PORT ?? '4317'),
  });
  console.log(
    `Local Jobdesk ready at ${runtime.origin}. Run npm run jobs:cli -- open for a private session.`,
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Jobdesk could not start. Check its private directory, owner lock, and migration ledger.',
    );
    process.exitCode = 1;
  });
