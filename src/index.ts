export { BindMCP } from './core/gateway.js'
export { ToolRegistry } from './core/dispatch/registry.js'
export { validateInput } from './core/generation/validator.js'
export {
  formatJsonRpcError,
  formatJsonRpcSuccess,
  formatToolResult,
} from './core/generation/protocol.js'
export {
  generateMcpKeyPair,
  signMcpPayload,
  verifyMcpRequest,
} from './core/security/crypto.js'
export type {
  CryptoVerifierOptions,
  SignedPayloadHeaders,
} from './core/security/crypto.js'
export { McpError, McpErrorCode } from './errors/mcp-errors.js'

export type {
  BaseToolDefinition,
  BindMcpOptions,
  CorsOptions,
  ExecutionContext,
  FunctionToolDefinition,
  HandleRequestOptions,
  InternalDispatcher,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolCallResult,
  McpToolDescriptor,
  RouteProxyConfig,
  RouteToolDefinition,
  ToolDefinition,
} from './core/generation/types.js'