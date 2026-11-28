import type { BindMCP } from '../core/gateway.js'
import {
  callRemoteTool,
  discoverAgent,
  type DiscoverAgentOptions,
  type DiscoveredAgent,
  type RemoteSigningKey,
} from '../core/client/remote.js'
import type { JsonRpcRequest, JsonRpcResponse, McpToolDescriptor } from '../core/generation/types.js'

interface NavigatorWithModelContext extends Navigator {
  modelContext?: {
    registerTool: (tool: {
      name: string
      description: string
      inputSchema: Record<string, unknown>
      execute: (args: Record<string, unknown>) => Promise<unknown>
    }) => void
    unregisterTool?: (name: string) => void
  }
}

export interface BrowserAdapterOptions {
  /** Register tools into Chrome's native navigator.modelContext when supported (default: true) */
  enableWebMcp?: boolean
  /** Listen for JSON-RPC 2.0 messages via window.postMessage across all browsers (default: true) */
  enablePostMessage?: boolean
  /** Allowed origins for window.postMessage requests (default: ['*']) */
  allowedOrigins?: string[]
  /** Optional window global property name to attach the local BindMCP client (e.g., '__bindmcp') */
  exposeGlobal?: string
}

export interface BrowserMcpClient {
  /** List all registered tool descriptors */
  listTools: () => McpToolDescriptor[]
  /** Directly invoke a tool in-page with full Zod validation */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<JsonRpcResponse>
  /** Clean up window event listeners and native WebMCP registrations */
  dispose: () => void
  /** Reports which browser transports were activated */
  capabilities: {
    nativeWebMcp: boolean
    postMessageBridge: boolean
  }
}

export function createBrowserAdapter(
  gateway: BindMCP,
  options: BrowserAdapterOptions = {},
): BrowserMcpClient {
  const {
    enableWebMcp = true,
    enablePostMessage = true,
    allowedOrigins = ['*'],
    exposeGlobal,
  } = options

  const registeredNativeTools: string[] = []
  let nativeWebMcpActive = false
  let postMessageActive = false

  const executeRpcInMemory = async (rpcPayload: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const syntheticRequest = new Request('https://browser.local/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcPayload),
    })

    const response = await gateway.handle(syntheticRequest)
    if (!response) {
      return {
        jsonrpc: '2.0',
        id: rpcPayload.id ?? null,
        error: { code: -32603, message: 'Gateway did not handle browser RPC request' },
      }
    }

    if (response.status === 202) {
      return { jsonrpc: '2.0', id: null, result: { acknowledged: true } }
    }

    return (await response.json()) as JsonRpcResponse
  }

  // Tier 1: Native Chrome WebMCP (navigator.modelContext)
  const nav = typeof navigator !== 'undefined' ? (navigator as NavigatorWithModelContext) : undefined
  if (enableWebMcp && nav?.modelContext && typeof nav.modelContext.registerTool === 'function') {
    nativeWebMcpActive = true
    const descriptors = gateway.getManifest().tools

    for (const tool of descriptors) {
      nav.modelContext.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (args: Record<string, unknown>) => {
          const rpcRes = await executeRpcInMemory({
            jsonrpc: '2.0',
            id: crypto.randomUUID(),
            method: 'tools/call',
            params: { name: tool.name, arguments: args },
          })

          if (rpcRes.error) {
            throw new Error(rpcRes.error.message)
          }
          return rpcRes.result
        },
      })
      registeredNativeTools.push(tool.name)
    }
  }

  // Tier 2: Universal Cross-Browser postMessage JSON-RPC Bridge
  const handleWindowMessage = async (event: MessageEvent) => {
    if (!allowedOrigins.includes('*') && !allowedOrigins.includes(event.origin)) {
      return
    }

    const data = event.data as Partial<JsonRpcRequest> | null
    if (!data || data.jsonrpc !== '2.0' || typeof data.method !== 'string') {
      return
    }

    const rpcResponse = await executeRpcInMemory(data as JsonRpcRequest)

    if (event.source && typeof (event.source as Window).postMessage === 'function') {
      const targetOrigin = event.origin && event.origin !== 'null' ? event.origin : '*'
      ;(event.source as Window).postMessage(rpcResponse, targetOrigin)
    }
  }

  if (enablePostMessage && typeof window !== 'undefined') {
    postMessageActive = true
    window.addEventListener('message', handleWindowMessage)
  }

  // Tier 3: Direct In-Page Programmatic Client
  const client: BrowserMcpClient = {
    listTools: () => gateway.getManifest().tools,
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      return await executeRpcInMemory({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name, arguments: args },
      })
    },
    dispose: () => {
      if (postMessageActive && typeof window !== 'undefined') {
        window.removeEventListener('message', handleWindowMessage)
      }
      if (nativeWebMcpActive && nav?.modelContext?.unregisterTool) {
        for (const toolName of registeredNativeTools) {
          nav.modelContext.unregisterTool(toolName)
        }
      }
    },
    capabilities: {
      nativeWebMcp: nativeWebMcpActive,
      postMessageBridge: postMessageActive,
    },
  }

  if (exposeGlobal && typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>)[exposeGlobal] = client
  }

  return client
}

export type BrowserFamily = 'chrome' | 'firefox' | 'safari' | 'edge' | 'unknown'

export type AgentConnectionKind =
  | 'safe-extension'
  | 'native-webmcp'
  | 'browser-language-model'
  | 'external-mcp'
  | 'mozilla-otari'

export interface AgentConnectionOption {
  kind: AgentConnectionKind
  label: string
  available: boolean
  recommended: boolean
  reason: string
  metadata?: Record<string, string | string[]>
}

export interface AgentEnvironmentReport {
  browser: BrowserFamily
  capabilities: {
    nativeWebMcp: boolean
    browserLanguageModel: boolean
    safeExtensionBridge: boolean
    postMessageBridge: boolean
  }
  recommended: AgentConnectionOption[]
}

export interface DetectAgentEnvironmentOptions {
  /** Override site origin when running outside a standard browser location (or in tests) */
  siteOrigin?: string
  /** MCP endpoint path exposed by this site (default: '/mcp') */
  mcpPath?: string
  /** Optional install URL for the companion Safe Key Vault extension */
  extensionInstallUrl?: string
  /** Whether Mozilla Otari gateway fallback is enabled on this site (default: true) */
  otariEnabled?: boolean
  /** Window global property marker set by the extension content script (default: '__bindmcpExtension') */
  extensionGlobal?: string
}

/**
 * Detects the visitor's browser family from a User-Agent string.
 */
export function detectBrowserFamily(
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): BrowserFamily {
  if (/edg\//i.test(userAgent)) {
    return 'edge'
  }
  if (/firefox\//i.test(userAgent)) {
    return 'firefox'
  }
  if (/(chrome|crios)\//i.test(userAgent)) {
    return 'chrome'
  }
  if (/safari\//i.test(userAgent)) {
    return 'safari'
  }
  return 'unknown'
}

/**
 * Inspects browser capabilities at runtime and returns ranked connection options
 * (Safe Extension, Native WebMCP, Browser LanguageModel, External MCP/NANDA runtimes, and Mozilla Otari).
 */
export function detectAgentEnvironment(
  options: DetectAgentEnvironmentOptions = {},
): AgentEnvironmentReport {
  const browser = detectBrowserFamily()
  const nav = typeof navigator !== 'undefined' ? (navigator as NavigatorWithModelContext) : undefined
  const nativeWebMcp = Boolean(
    nav?.modelContext && typeof nav.modelContext.registerTool === 'function',
  )
  const browserLanguageModel =
    'LanguageModel' in globalThis ||
    Boolean((globalThis as { ai?: { languageModel?: unknown } }).ai?.languageModel)

  const extensionGlobal = options.extensionGlobal ?? '__bindmcpExtension'
  const safeExtensionBridge =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as Record<string, unknown>)[extensionGlobal])
  const postMessageBridge =
    typeof window !== 'undefined' && typeof window.postMessage === 'function'

  const windowOrigin =
    typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
      ? window.location.origin
      : undefined
  const origin = options.siteOrigin ?? windowOrigin
  const mcpPath = options.mcpPath ?? '/mcp'

  const recommended: AgentConnectionOption[] = []

  // 1. Safe Key Vault Browser Extension
  if (safeExtensionBridge) {
    recommended.push({
      kind: 'safe-extension',
      label: 'Safe Key Vault Extension',
      available: true,
      recommended: true,
      reason:
        'API keys stay isolated in the extension background worker with user-enforced session expiry and rate limits.',
    })
  } else {
    recommended.push({
      kind: 'safe-extension',
      label: 'Safe Key Vault Extension',
      available: false,
      recommended: !nativeWebMcp,
      reason:
        'Install the Safe Key Vault extension (Chrome/Firefox) so websites never see your raw LLM API keys.',
      ...(options.extensionInstallUrl !== undefined
        ? { metadata: { installUrl: options.extensionInstallUrl } }
        : {}),
    })
  }

  // 2. Native WebMCP (navigator.modelContext)
  if (nativeWebMcp) {
    recommended.push({
      kind: 'native-webmcp',
      label: 'Native Browser WebMCP',
      available: true,
      recommended: true,
      reason:
        'Browser-native navigator.modelContext is active; site tools are exposed directly with zero API key sharing.',
    })
  } else if (browser === 'chrome' || browser === 'edge') {
    recommended.push({
      kind: 'native-webmcp',
      label: 'Native Browser WebMCP',
      available: false,
      recommended: false,
      reason:
        'WebMCP (navigator.modelContext) is not enabled in this Chromium session; using cross-browser fallbacks.',
    })
  }

  // 3. Browser Built-in LanguageModel API
  if (browserLanguageModel) {
    recommended.push({
      kind: 'browser-language-model',
      label: 'Browser Built-in LanguageModel',
      available: true,
      recommended: true,
      reason: 'On-device browser LanguageModel API is available and requires no external API key.',
    })
  }

  // 4. External MCP / NANDA Runtime
  const mcpEndpoint = origin ? new URL(mcpPath, origin).toString() : mcpPath
  const agentFactsUrl = origin
    ? new URL('/.well-known/agent-facts', origin).toString()
    : '/.well-known/agent-facts'
  const wellKnownMcpUrl = origin
    ? new URL('/.well-known/mcp', origin).toString()
    : '/.well-known/mcp'
  const suggestedClients =
    browser === 'firefox'
      ? ['@mozilla/firefox-mcp', 'opencode', 'agy', 'claude-desktop']
      : ['opencode', 'agy', 'claude-desktop', 'cursor']

  recommended.push({
    kind: 'external-mcp',
    label: 'External MCP / NANDA Runtime',
    available: true,
    recommended: true,
    reason:
      browser === 'firefox'
        ? 'Connect an external MCP/NANDA client (@mozilla/firefox-mcp, OpenCode, or agy) so your LLM keys never touch the website.'
        : 'Connect an external MCP/NANDA client (OpenCode, agy, Claude Desktop, or Cursor) so your LLM keys never touch the website.',
    metadata: {
      mcpEndpoint,
      agentFactsUrl,
      wellKnownMcpUrl,
      suggestedClients,
    },
  })

  // 5. Mozilla Otari Gateway
  if (options.otariEnabled !== false) {
    recommended.push({
      kind: 'mozilla-otari',
      label: 'Mozilla Otari Gateway',
      available: true,
      recommended: browser === 'firefox' || (!safeExtensionBridge && !nativeWebMcp),
      reason:
        'Route prompts through a budget-capped, revocable Mozilla Otari gateway session instead of exposing master provider keys.',
    })
  }

  return {
    browser,
    capabilities: {
      nativeWebMcp,
      browserLanguageModel,
      safeExtensionBridge,
      postMessageBridge,
    },
    recommended,
  }
}

export const BINDMCP_EXTENSION_PROTOCOL = 'bindmcp-extension-v1' as const

export type ExtensionGateErrorCode =
  | 'EXTENSION_UNAVAILABLE'
  | 'USER_REJECTED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CONCURRENT_REQUEST_BLOCKED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR'

/**
 * Advisory session parameters sent by an untrusted webpage to the extension.
 * NOTE: The webpage SDK enforces nothing. All real limits (expiry, request quota,
 * cooldown, concurrency lock, and origin consent) MUST be enforced inside the
 * browser extension's isolated background service worker.
 */
export interface ExtensionSessionRequestHint {
  requestedTtlMs?: number
  requestedMaxRequests?: number
  purpose?: string
  requestedTools?: string[]
}

/**
 * Lease returned by the extension background worker after user approval.
 */
export interface ExtensionSessionGrant {
  sessionId: string
  origin: string
  expiresAt: number
  maxRequests: number
  remainingRequests: number
  cooldownMs: number
  maxConcurrent: number
  provider?: string
}

export interface ExtensionPromptRequest {
  sessionId: string
  prompt: string
  systemPrompt?: string
  model?: string
  maxOutputTokens?: number
}

export interface ExtensionPromptResult {
  text: string
  model?: string
  remainingRequests?: number
  expiresAt?: number
}

export interface ExtensionBridgeEnvelope<TPayload = unknown> {
  protocol: typeof BINDMCP_EXTENSION_PROTOCOL
  direction: 'page-to-extension' | 'extension-to-page'
  requestId: string
  action: 'ping' | 'session/request' | 'session/revoke' | 'llm/prompt'
  payload?: TPayload
  error?: {
    code: ExtensionGateErrorCode
    message: string
    retryAfterMs?: number
  }
}

export interface ExtensionBridgeClientOptions {
  /** Default request timeout in milliseconds (default: 15000) */
  timeoutMs?: number
  /** Target origin passed to window.postMessage (defaults to current window origin or '*') */
  targetOrigin?: string
}

export interface ExtensionBridgeClient {
  ping: () => Promise<{ available: boolean; version?: string }>
  requestSession: (hint?: ExtensionSessionRequestHint) => Promise<ExtensionSessionGrant>
  prompt: (request: ExtensionPromptRequest) => Promise<ExtensionPromptResult>
  revokeSession: (sessionId: string) => Promise<{ revoked: boolean }>
  dispose: () => void
}

/**
 * Structured error returned when the extension rejects or gates a page request.
 */
export class ExtensionBridgeError extends Error {
  public readonly code: ExtensionGateErrorCode
  public readonly retryAfterMs?: number

  constructor(code: ExtensionGateErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ExtensionBridgeError'
    this.code = code
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs
    }
  }
}

/**
 * Creates an untrusted webpage-side wire client for communicating with a companion
 * Safe Key Vault browser extension over `window.postMessage`.
 *
 * Security boundary: This client executes in webpage JavaScript and enforces ZERO
 * security guarantees. The extension's isolated background service worker must
 * independently verify `sender.origin`, prompt the user for consent, and enforce
 * session expiration, request quotas, cooldowns, and concurrency limits.
 */
export function createExtensionBridgeClient(
  options: ExtensionBridgeClientOptions = {},
): ExtensionBridgeClient {
  const timeoutMs = options.timeoutMs ?? 15_000
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (reason?: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const handleMessage = (event: MessageEvent) => {
    if (event.source && event.source !== window) {
      return
    }

    const data = event.data as Partial<ExtensionBridgeEnvelope> | null
    if (
      !data ||
      data.protocol !== BINDMCP_EXTENSION_PROTOCOL ||
      data.direction !== 'extension-to-page' ||
      typeof data.requestId !== 'string'
    ) {
      return
    }

    const entry = pending.get(data.requestId)
    if (!entry) {
      return
    }

    pending.delete(data.requestId)
    clearTimeout(entry.timer)

    if (data.error) {
      entry.reject(
        new ExtensionBridgeError(data.error.code, data.error.message, data.error.retryAfterMs),
      )
      return
    }

    entry.resolve(data.payload)
  }

  let listening = false
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    listening = true
    window.addEventListener('message', handleMessage)
  }

  const send = <TReq, TRes>(
    action: ExtensionBridgeEnvelope['action'],
    payload?: TReq,
    customTimeoutMs?: number,
  ): Promise<TRes> => {
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function') {
      return Promise.reject(
        new ExtensionBridgeError('EXTENSION_UNAVAILABLE', 'Browser window is not available'),
      )
    }

    const requestId = crypto.randomUUID()
    const effectiveTimeout = customTimeoutMs ?? timeoutMs
    const targetOrigin =
      options.targetOrigin ??
      (window.location?.origin && window.location.origin !== 'null' ? window.location.origin : '*')

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(
          new ExtensionBridgeError(
            'TIMEOUT',
            `Extension bridge request "${action}" timed out after ${effectiveTimeout}ms`,
          ),
        )
      }, effectiveTimeout)

      pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      const envelope: ExtensionBridgeEnvelope<TReq> = {
        protocol: BINDMCP_EXTENSION_PROTOCOL,
        direction: 'page-to-extension',
        requestId,
        action,
        ...(payload !== undefined ? { payload } : {}),
      }

      window.postMessage(envelope, targetOrigin)
    })
  }

  return {
    ping: async () => {
      try {
        const res = await send<undefined, { version?: string }>(
          'ping',
          undefined,
          Math.min(timeoutMs, 1500),
        )
        return {
          available: true,
          ...(res?.version !== undefined ? { version: res.version } : {}),
        }
      } catch (err) {
        if (
          err instanceof ExtensionBridgeError &&
          (err.code === 'TIMEOUT' || err.code === 'EXTENSION_UNAVAILABLE')
        ) {
          return { available: false }
        }
        throw err
      }
    },
    requestSession: (hint?: ExtensionSessionRequestHint) =>
      send<ExtensionSessionRequestHint | undefined, ExtensionSessionGrant>(
        'session/request',
        hint,
      ),
    prompt: (request: ExtensionPromptRequest) =>
      send<ExtensionPromptRequest, ExtensionPromptResult>('llm/prompt', request),
    revokeSession: (sessionId: string) =>
      send<{ sessionId: string }, { revoked: boolean }>('session/revoke', { sessionId }),
    dispose: () => {
      if (listening && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('message', handleMessage)
        listening = false
      }
      for (const [id, entry] of pending.entries()) {
        clearTimeout(entry.timer)
        pending.delete(id)
        entry.reject(
          new ExtensionBridgeError('EXTENSION_UNAVAILABLE', 'Extension bridge client disposed'),
        )
      }
    },
  }
}

export interface BridgeRemoteToWebMcpOptions extends DiscoverAgentOptions {
  /** Optional Ed25519 signing key to sign forwarded remote tools/call requests */
  signingKey?: RemoteSigningKey
  /** Extra headers forwarded on tool execution (e.g., Authorization) */
  callHeaders?: HeadersInit
}

export interface RemoteWebMcpBridge {
  agent: DiscoveredAgent
  registeredInWebMcp: boolean
  registeredTools: string[]
  dispose: () => void
}

/**
 * Discovers a backend or remote agent (`/.well-known/agent-facts` or `/.well-known/mcp`)
 * and mirrors its tools into Chrome's native `navigator.modelContext` (WebMCP) without
 * re-declaring tool schemas on the frontend.
 */
export async function bridgeRemoteToWebMcp(
  baseUrl: string,
  options: BridgeRemoteToWebMcpOptions = {},
): Promise<RemoteWebMcpBridge> {
  const agent = await discoverAgent(baseUrl, options)
  const nav = typeof navigator !== 'undefined' ? (navigator as NavigatorWithModelContext) : undefined
  const registeredTools: string[] = []
  let registeredInWebMcp = false

  if (nav?.modelContext && typeof nav.modelContext.registerTool === 'function') {
    registeredInWebMcp = true

    for (const tool of agent.tools) {
      nav.modelContext.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (args: Record<string, unknown>) => {
          const rpcRes = await callRemoteTool(
            agent.endpointUrl,
            tool.name,
            args,
            options.signingKey,
            {
              ...(options.fetch ? { fetch: options.fetch } : {}),
              ...(options.callHeaders ? { headers: options.callHeaders } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            },
          )

          if (rpcRes.error) {
            throw new Error(rpcRes.error.message)
          }

          return rpcRes.result
        },
      })
      registeredTools.push(tool.name)
    }
  }

  return {
    agent,
    registeredInWebMcp,
    registeredTools,
    dispose: () => {
      if (registeredInWebMcp && nav?.modelContext?.unregisterTool) {
        for (const toolName of registeredTools) {
          nav.modelContext.unregisterTool(toolName)
        }
      }
      registeredTools.length = 0
    },
  }
}