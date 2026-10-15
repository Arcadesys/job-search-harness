import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { clientEndpoint } from './paths.mjs';
import { workflowTools } from './workflow-tools.mjs';

/** The MCP tool currently running, so the owner can show it in the activity feed. */
export const currentTool = new AsyncLocalStorage();

// Thin IPC consumer: never opens PGlite, accesses Keychain, or falls back online.
function sendOnce(method, args, socketPath, tool) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const req = httpRequest(
      {
        socketPath,
        path: '/rpc',
        method: 'POST',
        headers: { Host: 'jobdesk', 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        let length = 0;
        res.on('data', (chunk) => {
          length += chunk.length;
          if (length > 5_000_000) req.destroy();
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200) {
              const error = new Error(result.error ?? 'Local Jobdesk rejected the operation.');
              error.code = result.code;
              throw error;
            }
            resolve(result.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('socket', (socket) => socket.once('connect', () => { connected = true; }));
    req.setTimeout(120_000, () => req.destroy());
    req.on('error', (cause) => {
      const error = new Error(
        'Local Jobdesk is unavailable or timed out. Reconcile pending submissions before retrying. No hosted fallback was attempted.',
      );
      // Nothing reached the owner, so starting it and sending again cannot repeat an action.
      error.notListening = !connected && ['ENOENT', 'ECONNREFUSED'].includes(cause?.code);
      reject(error);
    });
    req.end(JSON.stringify({ method, args, ...(tool ? { tool } : {}) }));
  });
}

let launching;
/** The desktop app names itself in JOBDESK_APP; start it quietly the first time it is needed. */
function launchApp(env = process.env) {
  if (!env.JOBDESK_APP) return false;
  launching ??= new Promise((resolve) => {
    const { ELECTRON_RUN_AS_NODE: _node, ...rest } = env;
    let extra = [];
    try { extra = JSON.parse(env.JOBDESK_APP_ARGS || '[]'); } catch { /* ignore a malformed value */ }
    const child = spawn(env.JOBDESK_APP, [...extra, '--background'], { detached: true, stdio: 'ignore', env: rest });
    child.on('error', () => resolve(false));
    child.unref();
    setTimeout(() => resolve(true), 250);
  });
  return launching;
}

export async function localCall(method, args, socketPath) {
  const tool = currentTool.getStore();
  try {
    return await sendOnce(method, args, socketPath, tool);
  } catch (error) {
    if (!error.notListening || !(await launchApp())) throw error;
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      return await sendOnce(method, args, socketPath, tool);
    } catch (error) {
      if (!error.notListening || Date.now() > deadline) throw error;
    }
  }
}

export function createLocalApiClient({
  socketPath = clientEndpoint(),
} = {}) {
  const workerId = `mcp-${randomUUID()}`;
  const leases = new Map();
  // Dispatching begin may have committed even if its response is lost. Keep
  // this barrier on transport errors; only explicit pre-attempt rejections
  // permit preparation recovery. The broker independently enforces it.
  const submissions = new Map();
  const call = (method, args) => localCall(method, args, socketPath);
  const lease = (itemId) => {
    const current = leases.get(itemId);
    if (!current) throw new Error('Claim preparation first by setting this item to preparing.');
    return { itemId, workerId, generation: current.generation };
  };
  const withLease = async (method, itemId, extra = {}) => {
    try {
      return await call(method, [{ ...lease(itemId), ...extra }]);
    } catch (error) {
      if (error.code === 'STALE_LEASE') leases.delete(itemId);
      throw error;
    }
  };
  const resetAfterRequeue = async (itemId) => {
    const cached = submissions.get(itemId);
    if (!cached) return false;
    const { item, attempts } = await call('items.read', [itemId]);
    const reconciled = attempts.find((attempt) => cached.id ? attempt.id === cached.id :
      attempt.workerId === workerId && attempt.generation === cached.generation &&
      attempt.draftVersion === cached.draftVersion && attempt.draftHash === cached.draftHash);
    // Both facts must come from the owner: the exact dispatched attempt was
    // reconciled, and a user explicitly requeued the now-blocked item. A timer,
    // missing attempt, transport failure, or uncertainty never resets this.
    if (item?.status !== 'queued' || reconciled?.state !== 'not_submitted' ||
      attempts.some((attempt) => ['pending', 'uncertain', 'confirmed'].includes(attempt.state)))
      return false;
    submissions.delete(itemId);
    leases.delete(itemId);
    return true;
  };
  const claim = async (itemId) => {
    if (submissions.has(itemId) && !await resetAfterRequeue(itemId))
      throw new Error('Submission may have begun. Reconcile it before claiming preparation again.');
    const current = await call('items.claim', [{ itemId, workerId }]);
    leases.set(itemId, current);
    return { item: { id: itemId, status: 'preparing', lease: current } };
  };
  const request = async (method, pathname, body) => {
    if (method === 'GET' && pathname === '/api/jobs/mcp/batches') return call('batches.list', []);
    let match = /^\/api\/jobs\/mcp\/batches\/([a-f0-9-]{36})\/items$/i.exec(pathname);
    if (method === 'GET' && match) return call('batches.items', [match[1]]);
    match = /^\/api\/jobs\/mcp\/items\/([a-f0-9-]{36})(\/submission)?$/i.exec(pathname);
    if (!match) throw new Error('Unsupported local Jobdesk operation.');
    const itemId = match[1];
    if (method === 'GET' && !match[2]) return call('items.read', [itemId]);
    if (method === 'PATCH' && !match[2]) {
      if (body.status === 'preparing' && submissions.has(itemId) && await resetAfterRequeue(itemId))
        return claim(itemId);
      if (body.status === 'preparing' && !leases.has(itemId)) return claim(itemId);
      let item;
      try {
        item = await withLease('items.status', itemId,
          { status: body.status, note: (body.note ?? '').slice(0, 1000) });
      } catch (error) {
        // Only a definitive stale lease before any submission dispatch gets
        // one claim retry. Never retry on transport/reconciliation failures.
        if (body.status === 'preparing' && error.code === 'STALE_LEASE' && !submissions.has(itemId))
          return claim(itemId);
        throw error;
      }
      if (body.status !== 'preparing') leases.delete(itemId);
      return { item };
    }
    if (method === 'POST' && match[2]) {
      const attemptId = submissions.get(itemId)?.id;
      return { receipt: await call('submission.record', [{ itemId, ...body,
        ...(attemptId ? { attemptId } : {}) }]) };
    }
    throw new Error('Unsupported local Jobdesk operation.');
  };
  const itemSchema = {
    type: 'object',
    properties: { itemId: { type: 'string', format: 'uuid' } },
    required: ['itemId'],
    additionalProperties: false,
  };
  const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
  const list = (maxItems) => ({ type: 'array', items: text(4000), maxItems });
  request.workerTools = [
    ...workflowTools(call),
    {
      name: 'job_hunt_setup_status',
      description:
        'Check what this Job Search Harness still needs: résumé truths (and how many are reviewed), job searches, and the time zone. Call this first when helping someone get started.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const [claims, search, settings] = await Promise.all([
          call('truth.list', []), call('search.settings', []), call('settings.read', [])]);
        const count = (status) => claims.filter((claim) => claim.reviewStatus === status).length;
        return {
          truths: { total: claims.length, reviewed: count('reviewed'), unreviewed: count('unreviewed') },
          searches: { total: search.queries.length,
            withFeeds: search.queries.filter((query) => query.enabled && query.feedUrl).length },
          timeZone: settings.timeZone,
          nextStep: !claims.length ? 'Import the user’s résumé with job_hunt_import_resume.'
            : !count('reviewed') ? 'Ask the user to review their truths in the cockpit before drafting.'
            : !search.queries.length ? 'Help the user add job searches in the cockpit settings.' : 'Ready.',
        };
      },
    },
    {
      name: 'job_hunt_import_resume',
      description:
        'First-time import of the user’s own résumé into their truth bank. Copy their wording exactly; do not improve, merge, or invent anything. Every claim arrives unreviewed and the user must approve it before any draft uses it. Fails without changes if truths already exist.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceNote: { ...text(1000, 8), description: 'Where this came from, e.g. "Imported from resume-2026.pdf on 2026-10-13".' },
          profile: {
            type: 'object',
            properties: Object.fromEntries(['name', 'headline', 'location', 'email', 'phone', 'website', 'linkedin', 'github']
              .map((key) => [key, text(4000)])),
            additionalProperties: false,
          },
          summary: text(4000),
          accomplishments: { ...list(40), description: 'Headline achievements, if the résumé lists them separately.' },
          experience: {
            type: 'array', maxItems: 40,
            items: {
              type: 'object',
              properties: { employer: text(4000), location: text(200, 0), title: text(4000), dates: text(100, 0), bullets: list(40) },
              required: ['employer', 'title'],
              additionalProperties: false,
            },
          },
          earlier: { ...list(40), description: 'Older roles listed in one line each.' },
          skills: { ...list(60), description: 'One group per entry, e.g. "Tools: Jira, SQL".' },
          education: list(30),
          other: list(100),
        },
        required: ['sourceNote'],
        additionalProperties: false,
      },
      run: (args) => call('truth.importResume', [args]),
    },
    {
      name: 'job_hunt_add_resume_text',
      description:
        'Add more of the user’s own claims as plain text, one per line. Lines already in the truth bank are skipped; nothing existing changes. New lines arrive unreviewed.',
      inputSchema: {
        type: 'object',
        properties: { text: text(100_000), sourceNote: text(1000, 8) },
        required: ['text', 'sourceNote'],
        additionalProperties: false,
      },
      run: (args) => call('truth.importText', [args.text, args.sourceNote]),
    },
    {
      name: 'job_hunt_renew_lease',
      description:
        'Renew this worker’s preparation lease before it expires. A stale worker cannot write progress.',
      inputSchema: itemSchema,
      run: (args) => withLease('items.renew', args.itemId),
    },
    {
      name: 'job_hunt_begin_submission',
      description:
        'Save a durable attempt before clicking Submit. Pass draftVersion and draftHash from the exact approved get_item draft used to fill the form. If stale, read and refill before retrying. This tool performs no employer action.',
      inputSchema: {
        ...itemSchema,
        properties: { ...itemSchema.properties,
          draftVersion: { type: 'string', minLength: 1, maxLength: 100 },
          draftHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
        required: ['itemId', 'draftVersion', 'draftHash'],
      },
      run: async (args) => {
        if (submissions.has(args.itemId))
          throw new Error('Submission may have begun. Reconcile the existing attempt before another submission.');
        const current = lease(args.itemId);
        // Validate locally before setting the ambiguous-dispatch barrier.
        if (typeof args.draftVersion !== 'string' || !args.draftVersion || args.draftVersion.length > 100 ||
          typeof args.draftHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.draftHash))
          throw new Error('Pass the draftVersion and draftHash read from the approved draft used to fill the form.');
        submissions.set(args.itemId, { ...current, draftVersion: args.draftVersion,
          draftHash: args.draftHash, state: 'dispatching' });
        try {
          const attempt = await withLease('submission.begin', args.itemId,
            { draftVersion: args.draftVersion, draftHash: args.draftHash });
          submissions.set(args.itemId, { ...current, ...attempt });
          return attempt;
        } catch (error) {
          if (error.code === 'STALE_LEASE' || error.code === 'STALE_DRAFT')
            submissions.delete(args.itemId);
          throw error;
        }
      },
    },
    {
      name: 'job_hunt_mark_submission_uncertain',
      description:
        'Block an interrupted or timed-out submission for reconciliation. Never click Submit again merely because a lease expired.',
      inputSchema: {
        type: 'object',
        properties: {
          attemptId: { type: 'string', format: 'uuid' },
          note: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        required: ['attemptId', 'note'],
        additionalProperties: false,
      },
      run: (args) => call('submission.uncertain', [args.attemptId, args.note]),
    },
  ];
  return request;
}
