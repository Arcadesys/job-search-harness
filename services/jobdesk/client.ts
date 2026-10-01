import { request } from 'node:http';
import path from 'node:path';
import { DEFAULT_ROOT } from './store';
import { methodSchemas, type Method, type Args } from './contract';

export async function brokerCall<M extends Method>(
  method: M,
  args: Args<M>,
  socketPath = process.env.JOBDESK_SOCKET ?? path.join(DEFAULT_ROOT, 'broker.sock'),
): Promise<any> {
  methodSchemas[method].parse(args);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath,
        path: '/rpc',
        method: 'POST',
        headers: { Host: 'jobdesk', 'Content-Type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 5_000_000) {
            call.destroy();
            reject(new Error('Broker response exceeded its limit.'));
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString());
            if (response.statusCode !== 200)
              reject(new Error(result.error ?? 'Jobdesk request failed.'));
            else resolve(result.data);
          } catch {
            reject(new Error('Invalid Jobdesk response.'));
          }
        });
      },
    );
    call.setTimeout(120_000, () =>
      call.destroy(new Error('Jobdesk request timed out; reconcile mutations before retrying.')),
    );
    call.on('error', () =>
      reject(
        new Error(
          'Local Jobdesk is unavailable. Start its foreground service; no hosted fallback was attempted.',
        ),
      ),
    );
    call.end(JSON.stringify({ method, args }));
  });
}
