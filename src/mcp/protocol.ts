/**
 * Minimal JSON-RPC 2.0 over newline-delimited JSON.
 *
 * MCP's stdio transport is one JSON object per line, no Content-Length framing.
 * This file contains the protocol layer only — no stdin, no stdout — so the whole
 * handshake and dispatch path can be unit tested without spawning a process.
 */

import type { Mnemo } from '../mnemo.js';
import { TOOLS, callTool } from './tools.js';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export const SERVER_NAME = 'mnemo';
/** Echoed back when the client does not state a version. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export interface ServerContext {
  mem: Mnemo;
  version: string;
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one decoded message.
 *
 * Returns `null` for notifications (messages without an id), which must never be
 * answered. Anything the caller gets back is safe to serialise as one line.
 */
export async function handleMessage(
  ctx: ServerContext,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== 'object' || message === null) {
    return errorResponse(null, ERROR.invalidRequest, 'expected a JSON object');
  }

  const req = message as Partial<JsonRpcRequest>;
  const id = (req.id ?? null) as JsonRpcId;
  const isNotification = req.id === undefined;

  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return isNotification ? null : errorResponse(id, ERROR.invalidRequest, 'invalid JSON-RPC request');
  }

  const params = (req.params ?? {}) as Record<string, unknown>;

  try {
    switch (req.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested ?? DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: ctx.version },
          },
        };
      }

      case 'notifications/initialized':
      case 'initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!name) return errorResponse(id, ERROR.invalidParams, 'tools/call requires a tool name');
        const result = await callTool(ctx.mem, name, args);
        return { jsonrpc: '2.0', id, result };
      }

      // Present but empty: some clients probe these before falling back to tools.
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };

      case 'shutdown':
        return { jsonrpc: '2.0', id, result: null };

      default:
        return isNotification ? null : errorResponse(id, ERROR.methodNotFound, `unknown method: ${req.method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, ERROR.internal, message);
  }
}

/** Decode one line. Returns either a message or a parse-error response. */
export function decodeLine(line: string): { ok: true; value: unknown } | { ok: false; response: JsonRpcResponse } {
  if (line.trim().length === 0) return { ok: false, response: errorResponse(null, ERROR.parse, 'empty line') };
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, response: errorResponse(null, ERROR.parse, 'invalid JSON') };
  }
}
