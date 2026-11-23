import type { z } from 'zod'
import { ToolRegistry } from './dispatch/registry.js'
import { validateInput } from './generation/validator.js'
import { formatJsonRpcError, formatJsonRpcSuccess, formatToolResult } from './generation/protocol.js'
import { signMcpPayload, verifyMcpRequest, type CryptoVerifierOptions } from './security/crypto.js'
import { McpError, McpErrorCode } from '../errors/mcp-errors.js'
import type {
  BindMcpOptions,
  CorsOptions,
  ExecutionContext,
  HandleRequestOptions,
  JsonRpcRequest,
  RouteToolDefinition,
  ToolDefinition,
} from './generation/types.js'

export class BindMCP {
  private readonly name: string
  private readonly version: string
  private readonly basePath: string
  private readonly registry: ToolRegistry
  private readonly cors: CorsOptions | false
  private readonly security: CryptoVerifierOptions | undefined
  private readonly signingKey: { privateKey: string; publicKey?: string } | undefined

  constructor(options: BindMcpOptions) {
    this.name = options.name
    this.version = options.version
    this.basePath = options.basePath ?? '/mcp'
    this.registry = new ToolRegistry()
    this.security = options.security
    this.signingKey = options.signingKey

    if (options.cors === false) {
      this.cors = false
    } else if (typeof options.cors === 'object') {
      this.cors = options.cors
    } else {
      this.cors = {
        origin: '*',
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-MCP-Signature',
          'X-MCP-Timestamp',
          'X-MCP-Public-Key',
        ],
      }
    }
  }

  /**
   * Register a function-backed or route-proxied tool.
   */
  public tool<TInput extends z.ZodType, TOutput = unknown>(
    definition: ToolDefinition<TInput, TOutput>,
  ): this {
    this.registry.register(definition)
    return this
  }

  /**
   * Expose the generated tool manifest.
   */
  public getManifest() {
    return {
      name: this.name,
      version: this.version,
      endpoint: this.basePath,
      ...(this.signingKey?.publicKey ? { publicKey: this.signingKey.publicKey } : {}),
      tools: this.registry.listDescriptors(),
    }
  }

  /**
   * Primary entry point called by all framework and browser adapters.
   * Returns a Web Standard Response if the request matches an MCP route, or `null` if unhandled.
   */
  public async handle(
    request: Request,
    options: HandleRequestOptions = {},
  ): Promise<Response | null> {
    const url = new URL(request.url)
    const mountPath = options.basePath ?? this.basePath
    const isWellKnown = url.pathname === '/.well-known/mcp'
    const isMcpEndpoint = url.pathname === mountPath

    if (!isWellKnown && !isMcpEndpoint) {
      return null
    }

    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return this.applyCorsHeaders(new Response(null, { status: 204 }), request)
    }

    // 2. Handle .well-known discovery manifest
    if (isWellKnown) {
      if (request.method !== 'GET') {
        return this.applyCorsHeaders(new Response('Method Not Allowed', { status: 405 }), request)
      }

      const manifestBody = JSON.stringify(this.getManifest())
      const headers = new Headers({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      })

      if (this.signingKey) {
        const sigHeaders = await signMcpPayload(
          manifestBody,
          this.signingKey.privateKey,
          this.signingKey.publicKey,
        )
        headers.set('X-MCP-Signature', sigHeaders['X-MCP-Signature'])
        headers.set('X-MCP-Timestamp', sigHeaders['X-MCP-Timestamp'])
        if (sigHeaders['X-MCP-Public-Key']) {
          headers.set('X-MCP-Public-Key', sigHeaders['X-MCP-Public-Key'])
        }
      }

      return this.applyCorsHeaders(new Response(manifestBody, { status: 200, headers }), request)
    }

    // 3. Only accept POST for JSON-RPC execution on mountPath
    if (request.method !== 'POST') {
      return this.applyCorsHeaders(new Response('Method Not Allowed', { status: 405 }), request)
    }

    const rawBody = await request.text()

    // 4. Verify cryptographic signature if security policy is configured
    let verifiedAgentKey: string | undefined
    if (this.security) {
      const verification = await verifyMcpRequest(request.headers, rawBody, this.security)
      if (!verification.valid) {
        return this.applyCorsHeaders(
          Response.json(
            formatJsonRpcError(null, -32001, verification.reason ?? 'Unauthorized agent request'),
            { status: 401 },
          ),
          request,
        )
      }
      verifiedAgentKey = verification.publicKey
    }

    let rpcRequest: JsonRpcRequest
    try {
      rpcRequest = JSON.parse(rawBody) as JsonRpcRequest
    } catch {
      return this.applyCorsHeaders(
        Response.json(
          formatJsonRpcError(null, McpErrorCode.ParseError, 'Invalid JSON payload'),
          { status: 400 },
        ),
        request,
      )
    }

    if (rpcRequest.jsonrpc !== '2.0' || typeof rpcRequest.method !== 'string') {
      return this.applyCorsHeaders(
        Response.json(
          formatJsonRpcError(
            rpcRequest.id ?? null,
            McpErrorCode.InvalidRequest,
            'Invalid JSON-RPC 2.0 request',
          ),
          { status: 400 },
        ),
        request,
      )
    }

    // 5. Handle JSON-RPC 2.0 Notifications (no `id` property -> 202 Accepted with empty body)
    if (!('id' in rpcRequest) || rpcRequest.id === undefined) {
      return this.applyCorsHeaders(new Response(null, { status: 202 }), request)
    }

    const requestId = rpcRequest.id

    try {
      const result = await this.routeRpcMethod(rpcRequest, request, options, verifiedAgentKey)
      return this.applyCorsHeaders(
        Response.json(formatJsonRpcSuccess(requestId, result), { status: 200 }),
        request,
      )
    } catch (err) {
      if (err instanceof McpError) {
        return this.applyCorsHeaders(
          Response.json(formatJsonRpcError(requestId, err.code, err.message, err.data), {
            status: 200,
          }),
          request,
        )
      }

      const message = err instanceof Error ? err.message : 'Internal server error'
      return this.applyCorsHeaders(
        Response.json(formatJsonRpcError(requestId, McpErrorCode.InternalError, message), {
          status: 500,
        }),
        request,
      )
    }
  }

  private applyCorsHeaders(response: Response, request: Request): Response {
    if (!this.cors) {
      return response
    }

    const requestOrigin = request.headers.get('origin')
    let allowOrigin = '*'

    if (Array.isArray(this.cors.origin)) {
      if (requestOrigin && this.cors.origin.includes(requestOrigin)) {
        allowOrigin = requestOrigin
      } else {
        allowOrigin = this.cors.origin[0] ?? '*'
      }
    } else if (typeof this.cors.origin === 'string') {
      allowOrigin = this.cors.origin
    }

    response.headers.set('Access-Control-Allow-Origin', allowOrigin)
    response.headers.set(
      'Access-Control-Allow-Methods',
      (this.cors.allowMethods ?? ['GET', 'POST', 'OPTIONS']).join(', '),
    )
    response.headers.set(
      'Access-Control-Allow-Headers',
      (
        this.cors.allowHeaders ?? [
          'Content-Type',
          'Authorization',
          'X-MCP-Signature',
          'X-MCP-Timestamp',
          'X-MCP-Public-Key',
        ]
      ).join(', '),
    )

    if (this.cors.allowCredentials) {
      response.headers.set('Access-Control-Allow-Credentials', 'true')
    }

    return response
  }

  private async routeRpcMethod(
    rpc: JsonRpcRequest,
    request: Request,
    options: HandleRequestOptions,
    verifiedAgentKey?: string,
  ): Promise<unknown> {
    switch (rpc.method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          serverInfo: { name: this.name, version: this.version },
          capabilities: { tools: {} },
        }

      case 'tools/list':
        return {
          tools: this.registry.listDescriptors(),
        }

      case 'tools/call':
        return await this.executeToolCall(rpc.params, request, options, verifiedAgentKey)

      default:
        throw new McpError(McpErrorCode.MethodNotFound, `Unsupported MCP method: ${rpc.method}`)
    }
  }

  private async executeToolCall(
    params: Record<string, unknown> | undefined,
    request: Request,
    options: HandleRequestOptions,
    verifiedAgentKey?: string,
  ) {
    const toolName = params?.name
    if (typeof toolName !== 'string' || !toolName) {
      throw new McpError(McpErrorCode.InvalidParams, 'Missing or invalid tool name')
    }

    const tool = this.registry.get(toolName)
    if (!tool) {
      throw new McpError(McpErrorCode.MethodNotFound, `Tool not found: ${toolName}`)
    }

    const validatedArgs = validateInput(tool.input, params?.arguments ?? {})

    const ctx: ExecutionContext = {
      request,
      headers: request.headers,
      signal: request.signal,
      ...(options.dispatch ? { dispatch: options.dispatch } : {}),
      ...(verifiedAgentKey ? { verifiedAgentKey } : {}),
    }

    if ('execute' in tool && typeof tool.execute === 'function') {
      const output = await tool.execute(validatedArgs, ctx)
      return formatToolResult(output)
    }

    if ('route' in tool && tool.route) {
      return await this.proxyToRoute(tool, validatedArgs as Record<string, unknown>, ctx)
    }

    throw new McpError(McpErrorCode.InternalError, `Tool "${toolName}" has no execution target`)
  }

  private async proxyToRoute(
    tool: RouteToolDefinition,
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ) {
    if (!ctx.dispatch) {
      throw new McpError(
        McpErrorCode.InternalError,
        `Tool "${tool.name}" uses route proxying, but the active adapter did not supply a dispatcher`,
      )
    }

    const { method, path, paramMap, forwardAuth = true } = tool.route
    const incomingUrl = new URL(ctx.request.url)
    let resolvedPath = path
    const remainingArgs = { ...args }

    if (paramMap) {
      for (const [paramKey, argKey] of Object.entries(paramMap)) {
        if (argKey in remainingArgs) {
          resolvedPath = resolvedPath.replace(
            `:${paramKey}`,
            encodeURIComponent(String(remainingArgs[argKey])),
          )
          delete remainingArgs[argKey]
        }
      }
    }

    const targetUrl = new URL(resolvedPath, incomingUrl.origin)
    const headers = new Headers({ 'Content-Type': 'application/json' })

    if (forwardAuth) {
      const auth = ctx.headers.get('authorization')
      const cookie = ctx.headers.get('cookie')
      if (auth) headers.set('authorization', auth)
      if (cookie) headers.set('cookie', cookie)
    }

    let body: string | undefined
    if (method === 'GET' || method === 'DELETE') {
      for (const [key, value] of Object.entries(remainingArgs)) {
        if (value !== undefined) {
          targetUrl.searchParams.set(key, String(value))
        }
      }
    } else {
      body = JSON.stringify(remainingArgs)
    }

    const proxyRequest = new Request(targetUrl.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    })

    const response = await ctx.dispatch(proxyRequest)
    const responseText = await response.text()

    if (!response.ok) {
      return formatToolResult({ status: response.status, error: responseText }, true)
    }

    try {
      return formatToolResult(JSON.parse(responseText))
    } catch {
      return formatToolResult(responseText)
    }
  }
}