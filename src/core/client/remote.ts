import { signMcpPayload, verifyMcpRequest } from '../security/crypto.js'
import type {
  AgentFacts,
  JsonRpcResponse,
  McpManifest,
  McpToolCallResult,
  McpToolDescriptor,
} from '../generation/types.js'

export interface RemoteSigningKey {
  privateKey: string
  publicKey?: string
}

export interface DiscoverAgentOptions {
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  fetch?: typeof globalThis.fetch
  /** Optional allowlist of trusted Ed25519 SPKI public keys */
  trustedPublicKeys?: string[]
  /** Maximum allowed clock drift in milliseconds for X-MCP-Timestamp */
  maxClockDriftMs?: number
  /** Require a valid X-MCP-Signature header on the discovery document */
  requireSignature?: boolean
  /** Optional extra headers sent with the discovery request */
  headers?: HeadersInit
  /** Optional abort signal */
  signal?: AbortSignal
}

export interface DiscoveredAgent {
  source: 'agent-facts' | 'mcp'
  endpointUrl: string
  name: string
  version: string
  agentId?: string
  description?: string
  publicKey?: string
  tools: McpToolDescriptor[]
  verified: boolean
  agentFacts?: AgentFacts
  manifest?: McpManifest
}

export interface CallRemoteToolOptions {
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  fetch?: typeof globalThis.fetch
  /** Optional extra headers sent with the JSON-RPC POST request */
  headers?: HeadersInit
  /** Optional JSON-RPC request ID (defaults to crypto.randomUUID()) */
  id?: string | number
  /** Optional abort signal */
  signal?: AbortSignal
}

/**
 * Discovers a remote agentic website via `/.well-known/agent-facts` (MIT NANDA)
 * with fallback to `/.well-known/mcp`, verifying `X-MCP-Signature` when present.
 */
export async function discoverAgent(
  baseUrl: string,
  options: DiscoverAgentOptions = {},
): Promise<DiscoveredAgent> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const requestHeaders = new Headers(options.headers)
  requestHeaders.set('Accept', 'application/json')

  const factsUrl = new URL('/.well-known/agent-facts', baseUrl).toString()
  const factsRes = await fetchFn(factsUrl, {
    method: 'GET',
    headers: requestHeaders,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  let source: 'agent-facts' | 'mcp' = 'agent-facts'
  let activeRes = factsRes

  if (!factsRes.ok) {
    const mcpUrl = new URL('/.well-known/mcp', baseUrl).toString()
    const mcpRes = await fetchFn(mcpUrl, {
      method: 'GET',
      headers: requestHeaders,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    if (!mcpRes.ok) {
      throw new Error(
        `Failed to discover remote agent at ${baseUrl}: /.well-known/agent-facts (${factsRes.status}) and /.well-known/mcp (${mcpRes.status})`,
      )
    }

    source = 'mcp'
    activeRes = mcpRes
  }

  const rawBody = await activeRes.text()
  const parsed = JSON.parse(rawBody) as AgentFacts | McpManifest

  const docPublicKey =
    source === 'agent-facts'
      ? (parsed as AgentFacts).public_key
      : (parsed as McpManifest).publicKey
  const headerPublicKey = activeRes.headers.get('x-mcp-public-key') ?? undefined
  const publicKey = headerPublicKey ?? docPublicKey

  let verified = false
  if (activeRes.headers.has('x-mcp-signature')) {
    const verifyHeaders = new Headers(activeRes.headers)
    if (!verifyHeaders.has('x-mcp-public-key') && docPublicKey) {
      verifyHeaders.set('x-mcp-public-key', docPublicKey)
    }

    const verification = await verifyMcpRequest(verifyHeaders, rawBody, {
      requireSignature: true,
      ...(options.trustedPublicKeys ? { trustedPublicKeys: options.trustedPublicKeys } : {}),
      ...(options.maxClockDriftMs !== undefined
        ? { maxClockDriftMs: options.maxClockDriftMs }
        : {}),
    })

    if (!verification.valid) {
      throw new Error(
        `Remote agent signature verification failed: ${verification.reason ?? 'Invalid signature'}`,
      )
    }
    verified = true
  } else if (options.requireSignature) {
    throw new Error('Remote agent discovery response is missing required X-MCP-Signature header')
  }

  if (source === 'agent-facts') {
    const facts = parsed as AgentFacts
    const endpointPath = facts.endpoints?.mcp || facts.endpoints?.static?.[0] || '/mcp'
    const endpointUrl = new URL(endpointPath, baseUrl).toString()
    const tools: McpToolDescriptor[] =
      Array.isArray(facts.tools) && facts.tools.length > 0
        ? facts.tools
        : Array.isArray(facts.skills)
          ? facts.skills.map((skill) => ({
              name: skill.id,
              description: skill.description,
              inputSchema: skill.inputSchema ?? { type: 'object', properties: {} },
            }))
          : []

    return {
      source,
      endpointUrl,
      name: facts.label || facts.agent_name,
      version: facts.version,
      agentId: facts.id,
      ...(facts.description !== undefined ? { description: facts.description } : {}),
      ...(publicKey !== undefined ? { publicKey } : {}),
      tools,
      verified,
      agentFacts: facts,
    }
  }

  const manifest = parsed as McpManifest
  const endpointPath = manifest.endpoint || '/mcp'
  const endpointUrl = new URL(endpointPath, baseUrl).toString()

  return {
    source,
    endpointUrl,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.agentId !== undefined ? { agentId: manifest.agentId } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(publicKey !== undefined ? { publicKey } : {}),
    tools: manifest.tools ?? [],
    verified,
    manifest,
  }
}

/**
 * Invokes a tool on a remote MCP endpoint via JSON-RPC 2.0 `tools/call`,
 * optionally signing the payload with an Ed25519 private key.
 */
export async function callRemoteTool(
  endpointUrl: string,
  toolName: string,
  args: Record<string, unknown> = {},
  signingKey?: RemoteSigningKey,
  options: CallRemoteToolOptions = {},
): Promise<JsonRpcResponse<McpToolCallResult>> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const rawBody = JSON.stringify({
    jsonrpc: '2.0',
    id: options.id ?? crypto.randomUUID(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  })

  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json')

  if (signingKey) {
    const sigHeaders = await signMcpPayload(rawBody, signingKey.privateKey, signingKey.publicKey)
    headers.set('X-MCP-Signature', sigHeaders['X-MCP-Signature'])
    headers.set('X-MCP-Timestamp', sigHeaders['X-MCP-Timestamp'])
    if (sigHeaders['X-MCP-Public-Key']) {
      headers.set('X-MCP-Public-Key', sigHeaders['X-MCP-Public-Key'])
    }
  }

  const response = await fetchFn(endpointUrl, {
    method: 'POST',
    headers,
    body: rawBody,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as JsonRpcResponse<McpToolCallResult>
    if (parsed && parsed.jsonrpc === '2.0') {
      return parsed
    }
  } catch {
    // Fall through to HTTP status error below
  }

  throw new Error(`Remote tool call failed with HTTP ${response.status}: ${text}`)
}
