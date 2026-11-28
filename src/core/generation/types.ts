import type { z } from 'zod'
import type { CryptoVerifierOptions } from '../security/crypto.js'

/**
 * Standard JSON-RPC 2.0 request envelope used by MCP.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

/**
 * Standard JSON-RPC 2.0 response envelope.
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: string | number | null
  result?: T
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

/**
 * Context passed into every tool execution or route proxy.
 * Carries incoming HTTP headers/cookies, verified agent public key, and optional framework dispatcher.
 */
export interface ExecutionContext {
  request: Request
  headers: Headers
  dispatch?: InternalDispatcher
  signal?: AbortSignal
  /** Present when the incoming request passed Ed25519 signature verification */
  verifiedAgentKey?: string
}

/**
 * Function provided by framework adapters (e.g., Hono's app.fetch)
 * so BindMCP can invoke existing routes in-memory without a network hop.
 */
export type InternalDispatcher = (request: Request) => Promise<Response>

/**
 * Configuration for declarative route proxying to an existing endpoint.
 */
export interface RouteProxyConfig {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  /** Optional mapping of input fields to URL path params (e.g., { id: 'userId' } for /users/:id) */
  paramMap?: Record<string, string>
  /** Forward incoming Authorization and Cookie headers to the internal route (default: true) */
  forwardAuth?: boolean
}

/**
 * Base properties shared by all registered MCP tools.
 */
export interface BaseToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string
  description: string
  input: TInput
}

/**
 * Tool backed by a direct async handler function.
 */
export interface FunctionToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> extends BaseToolDefinition<TInput> {
  execute: (input: z.infer<TInput>, ctx: ExecutionContext) => Promise<TOutput> | TOutput
  route?: never
}

/**
 * Tool backed by an existing HTTP route on the host server.
 */
export interface RouteToolDefinition<
  TInput extends z.ZodType = z.ZodType,
> extends BaseToolDefinition<TInput> {
  route: RouteProxyConfig
  execute?: never
}

/**
 * Discriminated union: a tool uses either `execute` or `route`.
 */
export type ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> = FunctionToolDefinition<TInput, TOutput> | RouteToolDefinition<TInput>

/**
 * Serialized tool descriptor returned in `tools/list` and `.well-known` manifests.
 */
export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Standard MCP tool execution result payload.
 */
export interface McpToolCallResult {
  content: Array<{
    type: 'text'
    text: string
  }>
  isError?: boolean
}

/**
 * CORS settings for cross-origin browser and agent requests.
 */
export interface CorsOptions {
  origin?: string | string[]
  allowHeaders?: string[]
  allowMethods?: string[]
  allowCredentials?: boolean
}

/**
 * Options passed to `gateway.handle()` by framework adapters.
 */
export interface HandleRequestOptions {
  /** Base path where MCP is mounted (default: '/mcp') */
  basePath?: string
  /** Optional internal router dispatcher for route-proxied tools */
  dispatch?: InternalDispatcher
}

/**
 * Provider metadata for NANDA AgentFacts discovery (`provider` field).
 */
export interface AgentProviderInfo {
  name: string
  url: string
  did?: string
}

/**
 * Convenience input accepted for `provider` in `BindMcpOptions`.
 */
export type AgentProviderInput =
  | string
  | {
      name: string
      url?: string
      did?: string
    }

/**
 * NANDA skill descriptor projected from registered MCP tools.
 */
export interface AgentSkill {
  id: string
  description: string
  inputModes: string[]
  outputModes: string[]
  inputSchema?: Record<string, unknown>
}

/**
 * NANDA adaptive resolver endpoint configuration.
 */
export interface AgentAdaptiveResolver {
  url: string
  policies?: string[]
}

/**
 * NANDA observability and telemetry declaration in `AgentFacts`.
 */
export interface AgentTelemetryConfig {
  enabled: boolean
  sampling_rate?: number
  metrics?: string[]
  retention?: string
}

/**
 * NANDA certification / verification attestation metadata.
 */
export interface AgentCertification {
  level?: string
  issuer?: string
  valid_until?: string
}

/**
 * Serialized `.well-known/mcp` manifest.
 */
export interface McpManifest {
  name: string
  version: string
  endpoint: string
  agentId?: string
  description?: string
  provider?: AgentProviderInput
  publicKey?: string
  ttl?: number
  tools: McpToolDescriptor[]
}

/**
 * MIT NANDA-compliant AgentFacts discovery document (`https://agentfacts.org/schema/v1`)
 * served at `/.well-known/agent-facts`.
 */
export interface AgentFacts {
  $schema: string
  id: string
  agent_name: string
  label: string
  description: string
  version: string
  documentationUrl?: string
  jurisdiction?: string
  provider: AgentProviderInfo
  endpoints: {
    static: string[]
    adaptive_resolver?: AgentAdaptiveResolver
    mcp: string
    wellKnownMcp: string
  }
  capabilities: {
    modalities: string[]
    streaming: boolean
    batch: boolean
    authentication: {
      methods: string[]
      required: boolean
    }
    protocols: string[]
    browserRuntime: boolean
  }
  skills: AgentSkill[]
  tools: McpToolDescriptor[]
  telemetry: AgentTelemetryConfig
  certification?: AgentCertification
  public_key?: string
  ttl: number
  issued_at: string
}

/**
 * Telemetry event emitted after every `tools/call` invocation.
 */
export interface ToolCallTelemetryEvent {
  toolName: string
  durationMs: number
  success: boolean
  verifiedAgentKey?: string
  error?: string
}

/**
 * Telemetry event emitted whenever a discovery manifest is requested.
 */
export interface DiscoveryTelemetryEvent {
  path: string
  origin?: string
}

/**
 * Configuration options for initializing BindMCP.
 */
export interface BindMcpOptions {
  name: string
  version: string
  basePath?: string
  /** Enable CORS headers and OPTIONS preflight handling (default: true) */
  cors?: boolean | CorsOptions
  /** Optional Ed25519 signature verification for incoming requests */
  security?: CryptoVerifierOptions
  /** Optional Ed25519 keypair to sign outgoing .well-known/mcp manifests */
  signingKey?: {
    privateKey: string
    publicKey?: string
  }
  /** Optional NANDA agent identifier (e.g., did:web:example.com) */
  agentId?: string
  /** Canonical NANDA URN identifier (e.g., urn:agent:myorg:service) */
  agentName?: string
  /** Human-readable display label for the agent (defaults to `name`) */
  label?: string
  /** Human- and agent-readable description of this service */
  description?: string
  /** URL to human/developer documentation for this agent */
  documentationUrl?: string
  /** Regulatory jurisdiction covering this agent */
  jurisdiction?: string
  /** Organization or author providing this agent endpoint */
  provider?: AgentProviderInput
  /** Optional NANDA adaptive endpoint resolver configuration */
  adaptiveResolver?: AgentAdaptiveResolver
  /** Optional NANDA telemetry declaration overrides */
  telemetry?: Partial<AgentTelemetryConfig>
  /** Optional NANDA certification attestation metadata */
  certification?: AgentCertification
  /** Cache / discovery TTL in seconds (default: 3600) */
  ttl?: number
  /** Zero-dependency telemetry hook fired after tool execution */
  onToolCall?: (event: ToolCallTelemetryEvent) => void | Promise<void>
  /** Zero-dependency telemetry hook fired on .well-known discovery requests */
  onDiscovery?: (event: DiscoveryTelemetryEvent) => void | Promise<void>
}