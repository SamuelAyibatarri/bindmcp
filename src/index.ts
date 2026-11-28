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
export { discoverAgent, callRemoteTool } from './core/client/remote.js'
export type {
  CallRemoteToolOptions,
  DiscoverAgentOptions,
  DiscoveredAgent,
  RemoteSigningKey,
} from './core/client/remote.js'
export { McpError, McpErrorCode } from './errors/mcp-errors.js'

export type {
  AgentAdaptiveResolver,
  AgentCertification,
  AgentFacts,
  AgentProviderInfo,
  AgentProviderInput,
  AgentSkill,
  AgentTelemetryConfig,
  BaseToolDefinition,
  BindMcpOptions,
  CorsOptions,
  DiscoveryTelemetryEvent,
  ExecutionContext,
  FunctionToolDefinition,
  HandleRequestOptions,
  InternalDispatcher,
  JsonRpcRequest,
  JsonRpcResponse,
  McpManifest,
  McpToolCallResult,
  McpToolDescriptor,
  RouteProxyConfig,
  RouteToolDefinition,
  ToolCallTelemetryEvent,
  ToolDefinition,
} from './core/generation/types.js'