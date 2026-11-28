import type { z } from 'zod'
import { ToolRegistry } from './dispatch/registry.js'
import { validateInput } from './generation/validator.js'
import { formatJsonRpcError, formatJsonRpcSuccess, formatToolResult } from './generation/protocol.js'
import { signMcpPayload, verifyMcpRequest, type CryptoVerifierOptions } from './security/crypto.js'
import { McpError, McpErrorCode } from '../errors/mcp-errors.js'
import type {
  AgentAdaptiveResolver,
  AgentCertification,
  AgentFacts,
  AgentProviderInfo,
  AgentProviderInput,
  AgentSkill,
  AgentTelemetryConfig,
  BindMcpOptions,
  CorsOptions,
  DiscoveryTelemetryEvent,
  ExecutionContext,
  HandleRequestOptions,
  JsonRpcRequest,
  McpManifest,
  McpToolCallResult,
  RouteToolDefinition,
  ToolCallTelemetryEvent,
  ToolDefinition,
} from './generation/types.js'

function slugifyUrnSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  )
}

export class BindMCP {
  private readonly name: string
  private readonly version: string
  private readonly basePath: string
  private readonly registry: ToolRegistry
  private readonly cors: CorsOptions | false
  private readonly security: CryptoVerifierOptions | undefined
  private readonly signingKey: { privateKey: string; publicKey?: string } | undefined
  private readonly agentId: string | undefined
  private readonly agentName: string | undefined
  private readonly label: string | undefined
  private readonly description: string | undefined
  private readonly documentationUrl: string | undefined
  private readonly jurisdiction: string | undefined
  private readonly provider: AgentProviderInput | undefined
  private readonly adaptiveResolver: AgentAdaptiveResolver | undefined
  private readonly telemetryConfig: Partial<AgentTelemetryConfig> | undefined
  private readonly certification: AgentCertification | undefined
  private readonly ttl: number
  private readonly explicitTtl: number | undefined
  private readonly onToolCall: BindMcpOptions['onToolCall']
  private readonly onDiscovery: BindMcpOptions['onDiscovery']

  constructor(options: BindMcpOptions) {
    this.name = options.name
    this.version = options.version
    this.basePath = options.basePath ?? '/mcp'
    this.registry = new ToolRegistry()
    this.security = options.security
    this.signingKey = options.signingKey
    this.agentId = options.agentId
    this.agentName = options.agentName
    this.label = options.label
    this.description = options.description
    this.documentationUrl = options.documentationUrl
    this.jurisdiction = options.jurisdiction
    this.provider = options.provider
    this.adaptiveResolver = options.adaptiveResolver
    this.telemetryConfig = options.telemetry
    this.certification = options.certification
    this.ttl = options.ttl ?? 3600
    this.explicitTtl = options.ttl
    this.onToolCall = options.onToolCall
    this.onDiscovery = options.onDiscovery

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
  public getManifest(): McpManifest {
    return {
      name: this.name,
      version: this.version,
      endpoint: this.basePath,
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
      ...(this.description !== undefined ? { description: this.description } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.signingKey?.publicKey ? { publicKey: this.signingKey.publicKey } : {}),
      ...(this.explicitTtl !== undefined ? { ttl: this.explicitTtl } : {}),
      tools: this.registry.listDescriptors(),
    }
  }

  /**
   * Expose the MIT NANDA-compliant AgentFacts discovery document (`https://agentfacts.org/schema/v1`).
   */
  public getAgentFacts(origin?: string, basePath?: string): AgentFacts {
    const mountPath = basePath ?? this.basePath
    const mcpEndpoint = origin ? new URL(mountPath, origin).toString() : mountPath
    const wellKnownMcp = origin ? new URL('/.well-known/mcp', origin).toString() : '/.well-known/mcp'
    const id =
      this.agentId ??
      (origin ? `did:web:${new URL(origin).host.replace(/:/g, '%3A')}` : `urn:bindmcp:${this.name}`)

    const label = this.label ?? this.name
    const description = this.description ?? `MCP and WebMCP agent gateway for ${label}`
    const fallbackUrl = origin ?? 'https://localhost'

    const provider: AgentProviderInfo =
      typeof this.provider === 'string'
        ? { name: this.provider, url: fallbackUrl }
        : this.provider
          ? {
              name: this.provider.name,
              url: this.provider.url ?? fallbackUrl,
              ...(this.provider.did ? { did: this.provider.did } : {}),
            }
          : { name: label, url: fallbackUrl }

    const agentName =
      this.agentName ?? `urn:agent:${slugifyUrnSegment(provider.name)}:${slugifyUrnSegment(this.name)}`

    const tools = this.registry.listDescriptors()
    const skills: AgentSkill[] = tools.map((tool) => ({
      id: tool.name,
      description: tool.description,
      inputModes: ['application/json', 'text'],
      outputModes: ['application/json', 'text'],
      inputSchema: tool.inputSchema,
    }))

    const telemetryEnabled =
      this.telemetryConfig?.enabled ?? Boolean(this.onToolCall || this.onDiscovery)
    const telemetry: AgentTelemetryConfig = {
      enabled: telemetryEnabled,
      sampling_rate: this.telemetryConfig?.sampling_rate ?? (telemetryEnabled ? 1.0 : 0),
      metrics:
        this.telemetryConfig?.metrics ??
        (telemetryEnabled
          ? ['duration_ms', 'success_rate', 'tool_call_count', 'discovery_count']
          : []),
      ...(this.telemetryConfig?.retention !== undefined
        ? { retention: this.telemetryConfig.retention }
        : {}),
    }

    return {
      $schema: 'https://agentfacts.org/schema/v1',
      id,
      agent_name: agentName,
      label,
      description,
      version: this.version,
      ...(this.documentationUrl !== undefined ? { documentationUrl: this.documentationUrl } : {}),
      ...(this.jurisdiction !== undefined ? { jurisdiction: this.jurisdiction } : {}),
      provider,
      endpoints: {
        static: [mcpEndpoint],
        ...(this.adaptiveResolver !== undefined
          ? { adaptive_resolver: this.adaptiveResolver }
          : {}),
        mcp: mcpEndpoint,
        wellKnownMcp,
      },
      capabilities: {
        modalities: ['text', 'json'],
        streaming: false,
        batch: false,
        authentication: {
          methods: this.security ? ['ed25519'] : ['none'],
          required: Boolean(this.security?.requireSignature),
        },
        protocols: ['mcp', 'json-rpc-2.0', 'webmcp'],
        browserRuntime: true,
      },
      skills,
      tools,
      telemetry,
      ...(this.certification !== undefined ? { certification: this.certification } : {}),
      ...(this.signingKey?.publicKey ? { public_key: this.signingKey.publicKey } : {}),
      ttl: this.ttl,
      issued_at: new Date().toISOString(),
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
    const isWellKnownMcp = url.pathname === '/.well-known/mcp'
    const isWellKnownAgentFacts = url.pathname === '/.well-known/agent-facts'
    const isMcpEndpoint = url.pathname === mountPath

    if (!isWellKnownMcp && !isWellKnownAgentFacts && !isMcpEndpoint) {
      return null
    }

    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return this.applyCorsHeaders(new Response(null, { status: 204 }), request)
    }

    // 2. Handle .well-known discovery manifests
    if (isWellKnownMcp || isWellKnownAgentFacts) {
      if (request.method !== 'GET') {
        return this.applyCorsHeaders(new Response('Method Not Allowed', { status: 405 }), request)
      }

      const requestOrigin = request.headers.get('origin')
      await this.emitDiscovery({
        path: url.pathname,
        ...(requestOrigin ? { origin: requestOrigin } : {}),
      })

      const body = JSON.stringify(
        isWellKnownAgentFacts
          ? this.getAgentFacts(url.origin, mountPath)
          : this.getManifest(),
      )
      const cacheControl = isWellKnownAgentFacts
        ? this.ttl > 0
          ? `public, max-age=${this.ttl}`
          : 'no-cache'
        : 'no-cache'

      const headers = new Headers({
        'Content-Type': 'application/json',
        'Cache-Control': cacheControl,
      })

      if (this.signingKey) {
        const sigHeaders = await signMcpPayload(
          body,
          this.signingKey.privateKey,
          this.signingKey.publicKey,
        )
        headers.set('X-MCP-Signature', sigHeaders['X-MCP-Signature'])
        headers.set('X-MCP-Timestamp', sigHeaders['X-MCP-Timestamp'])
        if (sigHeaders['X-MCP-Public-Key']) {
          headers.set('X-MCP-Public-Key', sigHeaders['X-MCP-Public-Key'])
        }
      }

      return this.applyCorsHeaders(new Response(body, { status: 200, headers }), request)
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
  ): Promise<McpToolCallResult> {
    const startTime = performance.now()
    const resolvedToolName =
      typeof params?.name === 'string' && params.name ? params.name : '<unknown>'

    try {
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

      let result: McpToolCallResult
      if ('execute' in tool && typeof tool.execute === 'function') {
        const output = await tool.execute(validatedArgs, ctx)
        result = formatToolResult(output)
      } else if ('route' in tool && tool.route) {
        result = await this.proxyToRoute(tool, validatedArgs as Record<string, unknown>, ctx)
      } else {
        throw new McpError(McpErrorCode.InternalError, `Tool "${toolName}" has no execution target`)
      }

      const isError = Boolean(result.isError)
      await this.emitToolCall({
        toolName: resolvedToolName,
        durationMs: Math.max(0, performance.now() - startTime),
        success: !isError,
        ...(verifiedAgentKey ? { verifiedAgentKey } : {}),
        ...(isError
          ? { error: result.content[0]?.text ?? 'Tool returned an error result' }
          : {}),
      })

      return result
    } catch (err) {
      await this.emitToolCall({
        toolName: resolvedToolName,
        durationMs: Math.max(0, performance.now() - startTime),
        success: false,
        ...(verifiedAgentKey ? { verifiedAgentKey } : {}),
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private async emitToolCall(event: ToolCallTelemetryEvent): Promise<void> {
    if (!this.onToolCall) {
      return
    }
    try {
      await this.onToolCall(event)
    } catch {
      // Telemetry failures must never disrupt tool execution responses
    }
  }

  private async emitDiscovery(event: DiscoveryTelemetryEvent): Promise<void> {
    if (!this.onDiscovery) {
      return
    }
    try {
      await this.onDiscovery(event)
    } catch {
      // Telemetry failures must never disrupt discovery responses
    }
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