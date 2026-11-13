/**
 * MCP subpath export: `import { TOOLS, handleMessage } from 'mnemo-memory/mcp'`.
 *
 * The server entry point (`./server.js`) is intentionally not re-exported here:
 * importing this module must never start a process or touch stdio.
 */

export { TOOLS, callTool } from './tools.js';
export type { McpTool, ToolCallResult } from './tools.js';
export {
  handleMessage,
  decodeLine,
  SERVER_NAME,
  DEFAULT_PROTOCOL_VERSION,
  ERROR,
} from './protocol.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcId,
  ServerContext,
} from './protocol.js';
