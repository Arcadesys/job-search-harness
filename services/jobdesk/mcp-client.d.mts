import type { AsyncLocalStorage } from 'node:async_hooks';

export const currentTool: AsyncLocalStorage<string>;
export function localCall(method: string, args: unknown[], socketPath: string): Promise<unknown>;
