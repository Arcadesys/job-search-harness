#!/usr/bin/env node

import { createLocalApiClient } from './mcp-client.mjs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const STATUSES = ['preparing', 'awaiting_approval', 'blocked', 'skipped'];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requireId(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`${name} must contain 1 to 128 letters, digits, underscores, or hyphens.`);
  }
  return value;
}

function requireText(value, name, maxLength, minLength = 1) {
  if (typeof value !== 'string' || value.trim().length < minLength || value.length > maxLength) {
    throw new Error(`${name} must contain ${minLength} to ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalHttpsUrl(value) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('confirmationUrl must be an HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') throw new Error('confirmationUrl must be an HTTPS URL.');
  if (parsed.href.length > 2000)
    throw new Error('confirmationUrl must be at most 2000 characters.');
  return parsed.href;
}

export const createJobHuntApiClient = createLocalApiClient;

export function createTools(request) {
  return [
    {
      name: 'job_hunt_list_batches',
      description: 'List selected application batches owned by this local Jobdesk user.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => request('GET', '/api/jobs/mcp/batches'),
    },
    {
      name: 'job_hunt_list_batch_items',
      description: 'List lead preparation states in one selected batch.',
      inputSchema: {
        type: 'object',
        properties: {
          batchId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
        },
        required: ['batchId'],
        additionalProperties: false,
      },
      run: (args) =>
        request(
          'GET',
          `/api/jobs/mcp/batches/${encodeURIComponent(requireId(args.batchId, 'batchId'))}/items`,
        ),
    },
    {
      name: 'job_hunt_get_item',
      description: 'Read one selected lead, its saved draft, review status, draftVersion/draftHash for submission, and reviewed résumé truths.',
      inputSchema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
        },
        required: ['itemId'],
        additionalProperties: false,
      },
      run: (args) =>
        request(
          'GET',
          `/api/jobs/mcp/items/${encodeURIComponent(requireId(args.itemId, 'itemId'))}`,
        ),
    },
    {
      name: 'job_hunt_update_item_status',
      description:
        'Record preparation progress, a blocker, or a skipped lead. Submission is recorded only by the verified receipt tool.',
      inputSchema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
          status: { type: 'string', enum: STATUSES },
          note: { type: 'string', maxLength: 2000 },
        },
        required: ['itemId', 'status'],
        additionalProperties: false,
      },
      run: (args) => {
        const itemId = requireId(args.itemId, 'itemId');
        if (!STATUSES.includes(args.status))
          throw new Error(`status must be one of: ${STATUSES.join(', ')}.`);
        if (args.note !== undefined && (typeof args.note !== 'string' || args.note.length > 2000)) {
          throw new Error('note must be at most 2000 characters.');
        }
        return request('PATCH', `/api/jobs/mcp/items/${encodeURIComponent(itemId)}`, {
          status: args.status,
          ...(args.note === undefined ? {} : { note: args.note }),
        });
      },
    },
    {
      name: 'job_hunt_record_submission',
      description:
        'Record an employer submission only after observing an explicit confirmation. This tool does not submit to employers.',
      inputSchema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
          idempotencyKey: { type: 'string', minLength: 8, maxLength: 160 },
          confirmation: { type: 'string', minLength: 1, maxLength: 1000 },
          confirmationUrl: { type: 'string', format: 'uri', maxLength: 2000 },
        },
        required: ['itemId', 'idempotencyKey', 'confirmation'],
        additionalProperties: false,
      },
      run: (args) => {
        const itemId = requireId(args.itemId, 'itemId');
        const idempotencyKey = requireText(args.idempotencyKey, 'idempotencyKey', 160, 8);
        const confirmation = requireText(args.confirmation, 'confirmation', 1000);
        const confirmationUrl = optionalHttpsUrl(args.confirmationUrl);
        return request('POST', `/api/jobs/mcp/items/${encodeURIComponent(itemId)}/submission`, {
          idempotencyKey,
          confirmation,
          ...(confirmationUrl === undefined ? {} : { confirmationUrl }),
        });
      },
    },
  ];
}

export function createProtocolHandler({ request = createJobHuntApiClient() } = {}) {
  const tools = [...createTools(request), ...(request.workerTools ?? [])];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return async function handle(message) {
    if (!message || message.jsonrpc !== '2.0') return undefined;
    const hasId = Object.hasOwn(message, 'id');
    const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
    const error = (code, text) => ({
      jsonrpc: '2.0',
      id: message.id,
      error: { code, message: text },
    });
    if (!hasId && ['notifications/initialized', 'notifications/cancelled'].includes(message.method))
      return undefined;
    if (message.method === 'ping') return hasId ? reply({}) : undefined;
    if (message.method === 'initialize') {
      const versions = ['2025-06-18', '2025-03-26', '2024-11-05'];
      const requested = message.params?.protocolVersion;
      return reply({
        protocolVersion: versions.includes(requested) ? requested : versions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'job-hunt-jobs', version: '0.2.0-local' },
      });
    }
    if (message.method === 'tools/list')
      return reply({ tools: tools.map(({ run, ...definition }) => definition) });
    if (message.method === 'tools/call') {
      const tool = byName.get(message.params?.name);
      if (!tool)
        return reply({
          content: [{ type: 'text', text: 'Unknown Job Hunt tool.' }],
          isError: true,
        });
      try {
        const result = await tool.run(message.params?.arguments ?? {});
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { data: result },
        });
      } catch (cause) {
        const safeMessage = cause instanceof Error ? cause.message : 'Job Hunt request failed.';
        return reply({ content: [{ type: 'text', text: safeMessage }], isError: true });
      }
    }
    if (message.method?.startsWith('notifications/')) return undefined;
    return hasId ? error(-32601, 'Method not found.') : undefined;
  };
}

export async function runStdio({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  handler = createProtocolHandler(),
} = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      errorOutput.write('Ignored malformed MCP input.\n');
      continue;
    }
    try {
      const response = await handler(message);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    } catch {
      errorOutput.write('Job Hunt MCP request failed.\n');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdio().catch(() => {
    process.stderr.write('Job Hunt MCP server could not start.\n');
    process.exitCode = 1;
  });
}
