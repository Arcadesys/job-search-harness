import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

// Thin IPC consumer: never opens PGlite, accesses Keychain, or falls back online.
export function localCall(method, args, socketPath) {
  return new Promise((resolve, reject) => {
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
    req.setTimeout(120_000, () => req.destroy());
    req.on('error', () =>
      reject(
        new Error(
          'Local Jobdesk is unavailable or timed out. Reconcile pending submissions before retrying. No hosted fallback was attempted.',
        ),
      ),
    );
    req.end(JSON.stringify({ method, args }));
  });
}

export function createLocalApiClient({
  socketPath = process.env.JOBDESK_SOCKET ??
    path.join(homedir(), 'Library/Application Support/Arcades Jobdesk/broker.sock'),
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
  request.workerTools = [
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
