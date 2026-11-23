import type { BindMCP } from '../core/gateway.js'
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