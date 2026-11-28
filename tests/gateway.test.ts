import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  BindMCP,
  McpErrorCode,
  callRemoteTool,
  discoverAgent,
  generateMcpKeyPair,
  signMcpPayload,
  verifyMcpRequest,
  type DiscoveryTelemetryEvent,
  type ToolCallTelemetryEvent,
} from '../src/index.js'
import { createHonoAdapter } from '../src/adapters/hono.js'
import { createFetchAdapter } from '../src/adapters/fetch.js'
import {
  BINDMCP_EXTENSION_PROTOCOL,
  ExtensionBridgeError,
  bridgeRemoteToWebMcp,
  createBrowserAdapter,
  createExtensionBridgeClient,
  detectAgentEnvironment,
  type ExtensionBridgeEnvelope,
} from '../src/adapters/browser.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createExpressAdapter } from '../src/adapters/express.js'


function createTestServer() {
  const app = new Hono()
  const gateway = new BindMCP({ name: 'test-gateway', version: '1.0.0' })

  // 1. Direct execute tool
  gateway.tool({
    name: 'calculate_sum',
    description: 'Adds two numbers together',
    input: z.object({
      a: z.number(),
      b: z.number(),
    }),
    execute: async ({ a, b }) => ({ sum: a + b }),
  })

  // 2. Route-proxied tool targeting an existing Hono route
  gateway.tool({
    name: 'get_user_profile',
    description: 'Fetches a user profile by ID',
    input: z.object({
      userId: z.string(),
      includeRoles: z.boolean().optional(),
    }),
    route: {
      method: 'GET',
      path: '/api/users/:id',
      paramMap: { id: 'userId' },
    },
  })

  app.use('*', createHonoAdapter(gateway, { app }))

  // Existing host REST endpoint
  app.get('/api/users/:id', (c) => {
    const id = c.req.param('id')
    const includeRoles = c.req.query('includeRoles')
    const authHeader = c.req.header('authorization') ?? 'none'

    return c.json({
      id,
      includeRoles: includeRoles === 'true',
      authHeader,
    })
  })

  return { app, gateway }
}

describe('BindMCP Gateway & Adapters', () => {
  it('serves the .well-known/mcp manifest with serialized JSON schemas', async () => {
    const { app } = createTestServer()
    const res = await app.request('http://localhost/.well-known/mcp')

    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.name).toBe('test-gateway')
    expect(body.tools).toHaveLength(2)
    expect(body.tools[0]).toMatchObject({
      name: 'calculate_sum',
      description: 'Adds two numbers together',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    })
  })

  it('executes function-backed tools via JSON-RPC tools/call', async () => {
    const { app } = createTestServer()
    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'calculate_sum',
          arguments: { a: 14, b: 28 },
        },
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    const parsedContent = JSON.parse(body.result.content[0].text)

    expect(parsedContent).toEqual({ sum: 42 })
  })

  it('proxies route-backed tools internally with path params, query params, and auth headers', async () => {
    const { app } = createTestServer()
    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-session-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_user_profile',
          arguments: { userId: 'usr_99', includeRoles: true },
        },
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    const parsedContent = JSON.parse(body.result.content[0].text)

    expect(parsedContent).toEqual({
      id: 'usr_99',
      includeRoles: true,
      authHeader: 'Bearer secret-session-token',
    })
  })

  it('returns JSON-RPC InvalidParams error when Zod validation fails', async () => {
    const { app } = createTestServer()
    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'calculate_sum',
          arguments: { a: 'not-a-number', b: 10 },
        },
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.error.code).toBe(McpErrorCode.InvalidParams)
    expect(body.error.message).toBe('Tool input validation failed')
    expect(body.error.data[0].path).toBe('a')
  })

  it('handles MCP tool calls and falls through to normal routes in Express', async () => {
    const app = express()
    app.use(express.json())

    const gateway = new BindMCP({ name: 'express-gateway', version: '1.0.0' })
    gateway.tool({
      name: 'echo_message',
      description: 'Echoes back a string message',
      input: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ echoed: text }),
    })

    app.use(createExpressAdapter(gateway))

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' })
    })

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      // 1. Test MCP tool execution
      const mcpRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'echo_message',
            arguments: { text: 'hello from express' },
          },
        }),
      })

      expect(mcpRes.status).toBe(200)
      const mcpBody = await mcpRes.json()
      expect(JSON.parse(mcpBody.result.content[0].text)).toEqual({
        echoed: 'hello from express',
      })

      // 2. Test normal Express route fallthrough
      const healthRes = await fetch(`${baseUrl}/health`)
      expect(healthRes.status).toBe(200)
      expect(await healthRes.json()).toEqual({ status: 'ok' })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })

  it('returns 404 for unhandled routes in standalone fetch adapter', async () => {
    const gateway = new BindMCP({ name: 'standalone', version: '1.0.0' })
    const handler = createFetchAdapter(gateway)

    const res = await handler(new Request('http://localhost/unrelated-route'))
    expect(res.status).toBe(404)
  })
})

describe('Ed25519 Cryptographic Signing & Verification', () => {
  it('rejects unsigned, tampered, and untrusted requests when requireSignature is enabled', async () => {
    const trustedKeys = await generateMcpKeyPair()
    const untrustedKeys = await generateMcpKeyPair()

    const gateway = new BindMCP({
      name: 'secure-gateway',
      version: '1.0.0',
      security: {
        requireSignature: true,
        trustedPublicKeys: [trustedKeys.publicKey],
      },
    })

    gateway.tool({
      name: 'whoami',
      description: 'Returns the verified agent public key',
      input: z.object({}),
      execute: (_args, ctx) => ({ verifiedAgentKey: ctx.verifiedAgentKey ?? null }),
    })

    const handler = createFetchAdapter(gateway)
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    })

    // 1. Unsigned request -> 401
    const unsignedRes = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }),
    )
    expect(unsignedRes.status).toBe(401)
    const unsignedBody = await unsignedRes.json()
    expect(unsignedBody.error.code).toBe(-32001)

    // 2. Untrusted key -> 401
    const untrustedHeaders = await signMcpPayload(
      payload,
      untrustedKeys.privateKey,
      untrustedKeys.publicKey,
    )
    const untrustedRes = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...untrustedHeaders },
        body: payload,
      }),
    )
    expect(untrustedRes.status).toBe(401)

    // 3. Tampered payload with valid signature for original payload -> 401
    const trustedHeaders = await signMcpPayload(
      payload,
      trustedKeys.privateKey,
      trustedKeys.publicKey,
    )
    const tamperedPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 999,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    })
    const tamperedRes = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...trustedHeaders },
        body: tamperedPayload,
      }),
    )
    expect(tamperedRes.status).toBe(401)

    // 4. Valid trusted signature -> 200 with verifiedAgentKey populated
    const validRes = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...trustedHeaders },
        body: payload,
      }),
    )
    expect(validRes.status).toBe(200)
    const validBody = await validRes.json()
    expect(JSON.parse(validBody.result.content[0].text)).toEqual({
      verifiedAgentKey: trustedKeys.publicKey,
    })
  })

  it('signs GET /.well-known/mcp manifests when signingKey is configured', async () => {
    const serverKeys = await generateMcpKeyPair()
    const gateway = new BindMCP({
      name: 'signed-manifest-gateway',
      version: '1.0.0',
      signingKey: serverKeys,
    })

    const handler = createFetchAdapter(gateway)
    const res = await handler(new Request('http://localhost/.well-known/mcp'))

    expect(res.status).toBe(200)
    const rawBody = await res.text()
    const manifest = JSON.parse(rawBody)

    expect(manifest.publicKey).toBe(serverKeys.publicKey)
    expect(res.headers.get('x-mcp-signature')).toBeTruthy()
    expect(res.headers.get('x-mcp-public-key')).toBe(serverKeys.publicKey)

    const verification = await verifyMcpRequest(res.headers, rawBody, {
      requireSignature: true,
      trustedPublicKeys: [serverKeys.publicKey],
    })
    expect(verification).toEqual({ valid: true, publicKey: serverKeys.publicKey })
  })
})

describe('MIT NANDA /.well-known/agent-facts Discovery', () => {
  it('serves a signed NANDA-compliant AgentFacts document with metadata and Cache-Control', async () => {
    const serverKeys = await generateMcpKeyPair()
    const gateway = new BindMCP({
      name: 'nanda-service',
      version: '2.1.0',
      agentId: 'did:web:agent.example.com',
      agentName: 'urn:agent:bindmcp-labs:nanda-service',
      label: 'NANDA Compute Service',
      description: 'Verifiable agentic compute service',
      documentationUrl: 'https://example.com/docs',
      jurisdiction: 'US',
      provider: {
        name: 'BindMCP Labs',
        url: 'https://example.com',
        did: 'did:web:example.com',
      },
      adaptiveResolver: {
        url: 'https://resolver.example.com/resolve',
        policies: ['geo-proximity'],
      },
      telemetry: {
        sampling_rate: 0.5,
        metrics: ['latency_ms', 'success_rate'],
        retention: '30d',
      },
      certification: {
        level: 'self-attested',
        issuer: 'BindMCP Labs',
      },
      ttl: 1200,
      signingKey: serverKeys,
      security: { requireSignature: true, trustedPublicKeys: [serverKeys.publicKey] },
      onToolCall: () => {},
    })

    gateway.tool({
      name: 'ping',
      description: 'Health check tool',
      input: z.object({}),
      execute: () => ({ ok: true }),
    })

    const handler = createFetchAdapter(gateway)
    const res = await handler(new Request('https://agent.example.com/.well-known/agent-facts'))

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=1200')

    const rawBody = await res.text()
    const facts = JSON.parse(rawBody)

    expect(facts).toMatchObject({
      $schema: 'https://agentfacts.org/schema/v1',
      id: 'did:web:agent.example.com',
      agent_name: 'urn:agent:bindmcp-labs:nanda-service',
      label: 'NANDA Compute Service',
      description: 'Verifiable agentic compute service',
      version: '2.1.0',
      documentationUrl: 'https://example.com/docs',
      jurisdiction: 'US',
      provider: {
        name: 'BindMCP Labs',
        url: 'https://example.com',
        did: 'did:web:example.com',
      },
      endpoints: {
        static: ['https://agent.example.com/mcp'],
        adaptive_resolver: {
          url: 'https://resolver.example.com/resolve',
          policies: ['geo-proximity'],
        },
        mcp: 'https://agent.example.com/mcp',
        wellKnownMcp: 'https://agent.example.com/.well-known/mcp',
      },
      capabilities: {
        modalities: ['text', 'json'],
        streaming: false,
        batch: false,
        authentication: {
          methods: ['ed25519'],
          required: true,
        },
        protocols: ['mcp', 'json-rpc-2.0', 'webmcp'],
        browserRuntime: true,
      },
      skills: [
        {
          id: 'ping',
          description: 'Health check tool',
          inputModes: ['application/json', 'text'],
          outputModes: ['application/json', 'text'],
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
      telemetry: {
        enabled: true,
        sampling_rate: 0.5,
        metrics: ['latency_ms', 'success_rate'],
        retention: '30d',
      },
      certification: {
        level: 'self-attested',
        issuer: 'BindMCP Labs',
      },
      public_key: serverKeys.publicKey,
      ttl: 1200,
    })
    expect(facts.tools).toHaveLength(1)
    expect(typeof facts.issued_at).toBe('string')

    const verification = await verifyMcpRequest(res.headers, rawBody, {
      requireSignature: true,
      trustedPublicKeys: [serverKeys.publicKey],
    })
    expect(verification.valid).toBe(true)
  })

  it('derives defaults for did:web ID, URN agent_name, provider, and telemetry, and rejects non-GET methods', async () => {
    const gateway = new BindMCP({ name: 'derived-did', version: '1.0.0' })
    const handler = createFetchAdapter(gateway)

    const getRes = await handler(new Request('https://demo.example.org:8443/.well-known/agent-facts'))
    expect(getRes.status).toBe(200)
    const facts = await getRes.json()
    expect(facts).toMatchObject({
      $schema: 'https://agentfacts.org/schema/v1',
      id: 'did:web:demo.example.org%3A8443',
      agent_name: 'urn:agent:derived-did:derived-did',
      label: 'derived-did',
      provider: {
        name: 'derived-did',
        url: 'https://demo.example.org:8443',
      },
      telemetry: {
        enabled: false,
        sampling_rate: 0,
        metrics: [],
      },
    })

    const postRes = await handler(
      new Request('https://demo.example.org/.well-known/agent-facts', { method: 'POST' }),
    )
    expect(postRes.status).toBe(405)
  })
})

describe('Telemetry & Lifecycle Hooks', () => {
  it('fires onDiscovery and onToolCall hooks across success, validation error, and handler throw', async () => {
    const agentKeys = await generateMcpKeyPair()
    const discoveries: DiscoveryTelemetryEvent[] = []
    const toolCalls: ToolCallTelemetryEvent[] = []

    const gateway = new BindMCP({
      name: 'telemetry-gateway',
      version: '1.0.0',
      security: { requireSignature: false },
      onDiscovery: (event) => {
        discoveries.push(event)
      },
      onToolCall: (event) => {
        toolCalls.push(event)
      },
    })

    gateway.tool({
      name: 'double_value',
      description: 'Doubles a number',
      input: z.object({ value: z.number() }),
      execute: ({ value }) => ({ result: value * 2 }),
    })

    gateway.tool({
      name: 'explode',
      description: 'Always throws',
      input: z.object({}),
      execute: () => {
        throw new Error('boom')
      },
    })

    const handler = createFetchAdapter(gateway)

    await handler(
      new Request('http://localhost/.well-known/mcp', {
        headers: { Origin: 'https://caller.example.com' },
      }),
    )
    await handler(new Request('http://localhost/.well-known/agent-facts'))

    expect(discoveries).toEqual([
      { path: '/.well-known/mcp', origin: 'https://caller.example.com' },
      { path: '/.well-known/agent-facts' },
    ])

    // 1. Signed successful tool call
    const okPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'double_value', arguments: { value: 21 } },
    })
    const sigHeaders = await signMcpPayload(okPayload, agentKeys.privateKey, agentKeys.publicKey)
    const okRes = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sigHeaders },
        body: okPayload,
      }),
    )
    expect(okRes.status).toBe(200)

    // 2. Validation error
    await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'double_value', arguments: { value: 'bad' } },
        }),
      }),
    )

    // 3. Thrown handler error
    await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'explode', arguments: {} },
        }),
      }),
    )

    expect(toolCalls).toHaveLength(3)
    expect(toolCalls[0]).toMatchObject({
      toolName: 'double_value',
      success: true,
      verifiedAgentKey: agentKeys.publicKey,
    })
    expect(toolCalls[0]!.durationMs).toBeGreaterThanOrEqual(0)

    expect(toolCalls[1]).toMatchObject({
      toolName: 'double_value',
      success: false,
      error: 'Tool input validation failed',
    })

    expect(toolCalls[2]).toMatchObject({
      toolName: 'explode',
      success: false,
      error: 'boom',
    })
  })

  it('swallows errors thrown inside telemetry callbacks', async () => {
    const gateway = new BindMCP({
      name: 'resilient-telemetry',
      version: '1.0.0',
      onDiscovery: () => {
        throw new Error('discovery telemetry crashed')
      },
      onToolCall: () => {
        throw new Error('tool telemetry crashed')
      },
    })

    gateway.tool({
      name: 'ok',
      description: 'Works fine',
      input: z.object({}),
      execute: () => ({ ok: true }),
    })

    const handler = createFetchAdapter(gateway)
    const discoveryRes = await handler(new Request('http://localhost/.well-known/agent-facts'))
    expect(discoveryRes.status).toBe(200)

    const toolRes = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ok', arguments: {} },
        }),
      }),
    )
    expect(toolRes.status).toBe(200)
    const body = await toolRes.json()
    expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true })
  })
})

describe('CORS Preflight & JSON-RPC Notifications', () => {
  it('handles OPTIONS preflight on discovery and MCP routes and respects custom CORS config', async () => {
    const defaultGateway = new BindMCP({ name: 'cors-default', version: '1.0.0' })
    const defaultHandler = createFetchAdapter(defaultGateway)

    for (const path of ['/.well-known/mcp', '/.well-known/agent-facts', '/mcp']) {
      const res = await defaultHandler(
        new Request(`http://localhost${path}`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://agent-ui.example.com' },
        }),
      )
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-methods')).toContain('POST')
      expect(res.headers.get('access-control-allow-headers')).toContain('X-MCP-Signature')
    }

    const restrictedGateway = new BindMCP({
      name: 'cors-restricted',
      version: '1.0.0',
      cors: {
        origin: ['https://allowed.example.com'],
        allowCredentials: true,
      },
    })
    const restrictedHandler = createFetchAdapter(restrictedGateway)
    const allowedRes = await restrictedHandler(
      new Request('http://localhost/.well-known/mcp', {
        headers: { Origin: 'https://allowed.example.com' },
      }),
    )
    expect(allowedRes.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com')
    expect(allowedRes.headers.get('access-control-allow-credentials')).toBe('true')

    const disabledCorsGateway = new BindMCP({
      name: 'cors-disabled',
      version: '1.0.0',
      cors: false,
    })
    const disabledHandler = createFetchAdapter(disabledCorsGateway)
    const disabledRes = await disabledHandler(
      new Request('http://localhost/.well-known/mcp', { method: 'OPTIONS' }),
    )
    expect(disabledRes.status).toBe(204)
    expect(disabledRes.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('returns 202 Accepted with empty body for JSON-RPC 2.0 notifications', async () => {
    const gateway = new BindMCP({ name: 'notif-gateway', version: '1.0.0' })
    const handler = createFetchAdapter(gateway)

    const res = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }),
    )

    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })
})

describe('Tiered Browser Adapter', () => {
  it('supports Tier 3 direct invocation, Tier 1 navigator.modelContext, and Tier 2 window.postMessage', async () => {
    const gateway = new BindMCP({ name: 'browser-gateway', version: '1.0.0' })
    gateway.tool({
      name: 'greet',
      description: 'Greets a person',
      input: z.object({ name: z.string() }),
      execute: ({ name }) => ({ greeting: `Hello, ${name}!` }),
    })

    // Tier 3 only (Node environment without window or navigator.modelContext)
    const directClient = createBrowserAdapter(gateway, {
      enableWebMcp: false,
      enablePostMessage: false,
    })
    expect(directClient.capabilities).toEqual({
      nativeWebMcp: false,
      postMessageBridge: false,
    })
    expect(directClient.listTools()).toHaveLength(1)

    const okCall = await directClient.callTool('greet', { name: 'Sam' })
    expect(JSON.parse((okCall.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual({
      greeting: 'Hello, Sam!',
    })

    const badCall = await directClient.callTool('greet', { name: 123 as unknown as string })
    expect(badCall.error?.code).toBe(McpErrorCode.InvalidParams)

    // Tier 1 + Tier 2 with stubbed navigator.modelContext & window
    const registeredTools = new Map<
      string,
      { execute: (args: Record<string, unknown>) => Promise<unknown> }
    >()
    const unregisteredTools: string[] = []
    const listeners = new Map<string, Array<(event: MessageEvent) => void | Promise<void>>>()
    const fakeWindow: Record<string, unknown> = {
      addEventListener: (type: string, cb: (event: MessageEvent) => void | Promise<void>) => {
        const list = listeners.get(type) ?? []
        list.push(cb)
        listeners.set(type, list)
      },
      removeEventListener: (type: string, cb: (event: MessageEvent) => void | Promise<void>) => {
        const list = listeners.get(type) ?? []
        listeners.set(
          type,
          list.filter((fn) => fn !== cb),
        )
      },
    }

    vi.stubGlobal('navigator', {
      modelContext: {
        registerTool: (tool: {
          name: string
          execute: (args: Record<string, unknown>) => Promise<unknown>
        }) => {
          registeredTools.set(tool.name, tool)
        },
        unregisterTool: (name: string) => {
          unregisteredTools.push(name)
          registeredTools.delete(name)
        },
      },
    })
    vi.stubGlobal('window', fakeWindow)

    try {
      const client = createBrowserAdapter(gateway, {
        allowedOrigins: ['https://trusted-host.example.com'],
        exposeGlobal: '__bindmcp',
      })

      expect(client.capabilities).toEqual({
        nativeWebMcp: true,
        postMessageBridge: true,
      })
      expect(fakeWindow.__bindmcp).toBe(client)
      expect(registeredTools.has('greet')).toBe(true)

      // Execute via Tier 1 native WebMCP callback
      const nativeResult = (await registeredTools.get('greet')!.execute({ name: 'WebMCP' })) as {
        content: Array<{ text: string }>
      }
      expect(JSON.parse(nativeResult.content[0]!.text)).toEqual({ greeting: 'Hello, WebMCP!' })

      // Execute via Tier 2 postMessage (untrusted origin ignored, trusted origin answered)
      const replies: Array<{ data: unknown; targetOrigin: string }> = []
      const fakeSource = {
        postMessage: (data: unknown, targetOrigin: string) => {
          replies.push({ data, targetOrigin })
        },
      } as unknown as Window

      const messageHandlers = listeners.get('message') ?? []
      expect(messageHandlers).toHaveLength(1)

      await messageHandlers[0]!({
        origin: 'https://evil.example.com',
        source: fakeSource,
        data: {
          jsonrpc: '2.0',
          id: 'ignored',
          method: 'tools/call',
          params: { name: 'greet', arguments: { name: 'Evil' } },
        },
      } as unknown as MessageEvent)
      expect(replies).toHaveLength(0)

      await messageHandlers[0]!({
        origin: 'https://trusted-host.example.com',
        source: fakeSource,
        data: {
          jsonrpc: '2.0',
          id: 'pm-1',
          method: 'tools/call',
          params: { name: 'greet', arguments: { name: 'Browser' } },
        },
      } as unknown as MessageEvent)

      expect(replies).toHaveLength(1)
      expect(replies[0]!.targetOrigin).toBe('https://trusted-host.example.com')
      const pmResponse = replies[0]!.data as {
        id: string
        result: { content: Array<{ text: string }> }
      }
      expect(pmResponse.id).toBe('pm-1')
      expect(JSON.parse(pmResponse.result.content[0]!.text)).toEqual({
        greeting: 'Hello, Browser!',
      })

      // Cleanup on dispose()
      client.dispose()
      expect(unregisteredTools).toEqual(['greet'])
      expect(listeners.get('message')).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('detects browser capabilities and ranks connection options across Chrome, Firefox, and extension bridge', () => {
    try {
      // 1. Chrome with native WebMCP + built-in LanguageModel
      vi.stubGlobal('navigator', {
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        modelContext: { registerTool: () => {} },
      })
      vi.stubGlobal('LanguageModel', {})
      vi.stubGlobal('window', {
        location: { origin: 'https://shop.example.com' },
        postMessage: () => {},
      })

      const chromeReport = detectAgentEnvironment()
      expect(chromeReport.browser).toBe('chrome')
      expect(chromeReport.capabilities).toEqual({
        nativeWebMcp: true,
        browserLanguageModel: true,
        safeExtensionBridge: false,
        postMessageBridge: true,
      })

      const chromeKinds = chromeReport.recommended.map((opt) => opt.kind)
      expect(chromeKinds).toEqual([
        'safe-extension',
        'native-webmcp',
        'browser-language-model',
        'external-mcp',
        'mozilla-otari',
      ])
      expect(chromeReport.recommended.find((o) => o.kind === 'native-webmcp')?.available).toBe(true)
      expect(
        chromeReport.recommended.find((o) => o.kind === 'external-mcp')?.metadata,
      ).toMatchObject({
        mcpEndpoint: 'https://shop.example.com/mcp',
        agentFactsUrl: 'https://shop.example.com/.well-known/agent-facts',
      })

      // 2. Firefox without WebMCP, with extension install URL
      vi.unstubAllGlobals()
      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0',
      })
      vi.stubGlobal('window', {
        location: { origin: 'https://agent.example.org' },
        postMessage: () => {},
      })

      const firefoxReport = detectAgentEnvironment({
        extensionInstallUrl: 'https://addons.mozilla.org/example-vault',
      })
      expect(firefoxReport.browser).toBe('firefox')
      expect(firefoxReport.capabilities.nativeWebMcp).toBe(false)
      expect(firefoxReport.recommended.find((o) => o.kind === 'native-webmcp')).toBeUndefined()
      expect(
        firefoxReport.recommended.find((o) => o.kind === 'safe-extension')?.metadata,
      ).toEqual({ installUrl: 'https://addons.mozilla.org/example-vault' })
      expect(
        firefoxReport.recommended.find((o) => o.kind === 'external-mcp')?.metadata
          ?.suggestedClients,
      ).toContain('@mozilla/firefox-mcp')
      expect(firefoxReport.recommended.find((o) => o.kind === 'mozilla-otari')?.recommended).toBe(
        true,
      )

      // 3. Installed Safe Extension marker
      vi.stubGlobal('window', {
        location: { origin: 'https://agent.example.org' },
        postMessage: () => {},
        __bindmcpExtension: { version: '0.1.0' },
      })

      const extReport = detectAgentEnvironment()
      expect(extReport.capabilities.safeExtensionBridge).toBe(true)
      expect(extReport.recommended.find((o) => o.kind === 'safe-extension')).toMatchObject({
        available: true,
        recommended: true,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('communicates with a gated extension enforcer via createExtensionBridgeClient and surfaces quota errors', async () => {
    const listeners = new Map<string, Array<(event: MessageEvent) => void>>()
    const sessions = new Map<
      string,
      { expiresAt: number; remaining: number; maxRequests: number; revoked: boolean }
    >()

    const fakeWindow: Record<string, unknown> = {
      location: { origin: 'https://shop.example.com' },
      addEventListener: (type: string, cb: (event: MessageEvent) => void) => {
        const list = listeners.get(type) ?? []
        list.push(cb)
        listeners.set(type, list)
      },
      removeEventListener: (type: string, cb: (event: MessageEvent) => void) => {
        const list = listeners.get(type) ?? []
        listeners.set(
          type,
          list.filter((fn) => fn !== cb),
        )
      },
      postMessage: (raw: unknown) => {
        const msg = raw as ExtensionBridgeEnvelope<Record<string, unknown>>
        if (!msg || msg.protocol !== BINDMCP_EXTENSION_PROTOCOL || msg.direction !== 'page-to-extension') {
          return
        }

        const dispatchReply = (reply: ExtensionBridgeEnvelope) => {
          queueMicrotask(() => {
            for (const cb of listeners.get('message') ?? []) {
              cb({ source: fakeWindow, data: reply } as unknown as MessageEvent)
            }
          })
        }

        if (msg.action === 'ping') {
          dispatchReply({
            protocol: BINDMCP_EXTENSION_PROTOCOL,
            direction: 'extension-to-page',
            requestId: msg.requestId,
            action: 'ping',
            payload: { version: '0.1.0' },
          })
          return
        }

        if (msg.action === 'session/request') {
          const sessionId = 'sess-123'
          const expiresAt = Date.now() + 60_000
          sessions.set(sessionId, { expiresAt, remaining: 1, maxRequests: 1, revoked: false })
          dispatchReply({
            protocol: BINDMCP_EXTENSION_PROTOCOL,
            direction: 'extension-to-page',
            requestId: msg.requestId,
            action: 'session/request',
            payload: {
              sessionId,
              origin: 'https://shop.example.com',
              expiresAt,
              maxRequests: 1,
              remainingRequests: 1,
              cooldownMs: 500,
              maxConcurrent: 1,
              provider: 'otari',
            },
          })
          return
        }

        if (msg.action === 'llm/prompt') {
          const sessionId = String(msg.payload?.sessionId ?? '')
          const grant = sessions.get(sessionId)
          if (!grant || grant.revoked) {
            dispatchReply({
              protocol: BINDMCP_EXTENSION_PROTOCOL,
              direction: 'extension-to-page',
              requestId: msg.requestId,
              action: 'llm/prompt',
              error: { code: 'SESSION_NOT_FOUND', message: 'Session not found or revoked' },
            })
            return
          }
          if (grant.remaining <= 0) {
            dispatchReply({
              protocol: BINDMCP_EXTENSION_PROTOCOL,
              direction: 'extension-to-page',
              requestId: msg.requestId,
              action: 'llm/prompt',
              error: { code: 'QUOTA_EXCEEDED', message: 'Session request quota exceeded' },
            })
            return
          }

          grant.remaining -= 1
          dispatchReply({
            protocol: BINDMCP_EXTENSION_PROTOCOL,
            direction: 'extension-to-page',
            requestId: msg.requestId,
            action: 'llm/prompt',
            payload: {
              text: `Echo: ${String(msg.payload?.prompt ?? '')}`,
              model: 'otari-small',
              remainingRequests: grant.remaining,
              expiresAt: grant.expiresAt,
            },
          })
          return
        }

        if (msg.action === 'session/revoke') {
          const sessionId = String(msg.payload?.sessionId ?? '')
          const grant = sessions.get(sessionId)
          if (grant) grant.revoked = true
          dispatchReply({
            protocol: BINDMCP_EXTENSION_PROTOCOL,
            direction: 'extension-to-page',
            requestId: msg.requestId,
            action: 'session/revoke',
            payload: { revoked: true },
          })
        }
      },
    }

    vi.stubGlobal('window', fakeWindow)

    try {
      const bridge = createExtensionBridgeClient()

      expect(await bridge.ping()).toEqual({ available: true, version: '0.1.0' })

      const grant = await bridge.requestSession({
        requestedTtlMs: 60_000,
        requestedMaxRequests: 5,
        purpose: 'Compare vendor quotes',
      })
      expect(grant).toMatchObject({
        sessionId: 'sess-123',
        origin: 'https://shop.example.com',
        maxRequests: 1,
        remainingRequests: 1,
        cooldownMs: 500,
        maxConcurrent: 1,
      })

      const firstReply = await bridge.prompt({
        sessionId: grant.sessionId,
        prompt: 'Find cheapest compute node',
      })
      expect(firstReply).toMatchObject({
        text: 'Echo: Find cheapest compute node',
        remainingRequests: 0,
      })

      // Second prompt hits extension-enforced QUOTA_EXCEEDED
      await expect(
        bridge.prompt({
          sessionId: grant.sessionId,
          prompt: 'Second request',
        }),
      ).rejects.toMatchObject({
        name: 'ExtensionBridgeError',
        code: 'QUOTA_EXCEEDED',
      })

      expect(await bridge.revokeSession(grant.sessionId)).toEqual({ revoked: true })

      bridge.dispose()
      expect(listeners.get('message')).toHaveLength(0)
      expect(ExtensionBridgeError).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('mirrors backend tools into navigator.modelContext via bridgeRemoteToWebMcp without re-declaring schemas', async () => {
    const gateway = new BindMCP({ name: 'backend-api', version: '1.0.0' })
    gateway.tool({
      name: 'multiply',
      description: 'Multiplies two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => ({ product: a * b }),
    })

    const handler = createFetchAdapter(gateway)
    const remoteFetch: typeof globalThis.fetch = (input, init) =>
      handler(input instanceof Request && !init ? input : new Request(input, init))

    const registeredTools = new Map<
      string,
      { execute: (args: Record<string, unknown>) => Promise<unknown> }
    >()
    const unregisteredTools: string[] = []

    vi.stubGlobal('navigator', {
      modelContext: {
        registerTool: (tool: {
          name: string
          execute: (args: Record<string, unknown>) => Promise<unknown>
        }) => {
          registeredTools.set(tool.name, tool)
        },
        unregisterTool: (name: string) => {
          unregisteredTools.push(name)
          registeredTools.delete(name)
        },
      },
    })

    try {
      const bridge = await bridgeRemoteToWebMcp('https://api.example.com', {
        fetch: remoteFetch,
      })

      expect(bridge.registeredInWebMcp).toBe(true)
      expect(bridge.registeredTools).toEqual(['multiply'])

      const result = (await registeredTools.get('multiply')!.execute({ a: 6, b: 7 })) as {
        content: Array<{ text: string }>
      }
      expect(JSON.parse(result.content[0]!.text)).toEqual({ product: 42 })

      bridge.dispose()
      expect(unregisteredTools).toEqual(['multiply'])
      expect(bridge.registeredTools).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Outbound Cross-Agent Client (discoverAgent & callRemoteTool)', () => {
  it('discovers and verifies signed /.well-known/agent-facts and executes signed remote calls', async () => {
    const serverKeys = await generateMcpKeyPair()
    const clientKeys = await generateMcpKeyPair()

    const gateway = new BindMCP({
      name: 'remote-agent',
      version: '1.0.0',
      agentId: 'did:web:remote.example.com',
      signingKey: serverKeys,
      security: {
        requireSignature: true,
        trustedPublicKeys: [clientKeys.publicKey],
      },
    })

    gateway.tool({
      name: 'quote_compute',
      description: 'Returns a signed compute quote',
      input: z.object({ units: z.number().positive() }),
      execute: ({ units }, ctx) => ({
        totalUsd: units * 2.5,
        callerKey: ctx.verifiedAgentKey,
      }),
    })

    const handler = createFetchAdapter(gateway)
    const remoteFetch: typeof globalThis.fetch = (input, init) =>
      handler(input instanceof Request && !init ? input : new Request(input, init))

    const discovered = await discoverAgent('https://remote.example.com', {
      fetch: remoteFetch,
      trustedPublicKeys: [serverKeys.publicKey],
      requireSignature: true,
    })

    expect(discovered.source).toBe('agent-facts')
    expect(discovered.verified).toBe(true)
    expect(discovered.agentId).toBe('did:web:remote.example.com')
    expect(discovered.endpointUrl).toBe('https://remote.example.com/mcp')
    expect(discovered.tools).toHaveLength(1)

    // Signed remote tool call succeeds
    const signedRes = await callRemoteTool(
      discovered.endpointUrl,
      'quote_compute',
      { units: 4 },
      clientKeys,
      { fetch: remoteFetch, id: 'call-1' },
    )
    expect(signedRes.id).toBe('call-1')
    expect(signedRes.error).toBeUndefined()
    expect(JSON.parse(signedRes.result!.content[0]!.text)).toEqual({
      totalUsd: 10,
      callerKey: clientKeys.publicKey,
    })

    // Unsigned remote tool call returns JSON-RPC unauthorized error envelope
    const unsignedRes = await callRemoteTool(
      discovered.endpointUrl,
      'quote_compute',
      { units: 4 },
      undefined,
      { fetch: remoteFetch, id: 'call-2' },
    )
    expect(unsignedRes.error?.code).toBe(-32001)
  })

  it('falls back to /.well-known/mcp and rejects tampered or missing required signatures', async () => {
    const serverKeys = await generateMcpKeyPair()

    // 1. Fallback to /.well-known/mcp when agent-facts returns 404
    const fallbackFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/.well-known/agent-facts')) {
        return new Response('Not Found', { status: 404 })
      }
      return Response.json({
        name: 'legacy-mcp',
        version: '1.0.0',
        endpoint: '/custom-mcp',
        tools: [],
      })
    }

    const discovered = await discoverAgent('https://legacy.example.com', { fetch: fallbackFetch })
    expect(discovered.source).toBe('mcp')
    expect(discovered.verified).toBe(false)
    expect(discovered.endpointUrl).toBe('https://legacy.example.com/custom-mcp')

    // Missing required signature throws
    await expect(
      discoverAgent('https://legacy.example.com', {
        fetch: fallbackFetch,
        requireSignature: true,
      }),
    ).rejects.toThrow(/missing required X-MCP-Signature/i)

    // 2. Tampered signed response throws verification failure
    const originalBody = JSON.stringify({
      id: 'did:web:tampered.example.com',
      agent_name: 'tampered',
      version: '1.0.0',
      endpoints: {
        static: ['https://tampered.example.com/mcp'],
        mcp: 'https://tampered.example.com/mcp',
        wellKnownMcp: 'https://tampered.example.com/.well-known/mcp',
      },
      capabilities: {
        modalities: ['text'],
        authentication: { methods: ['none'], required: false },
        protocols: ['mcp'],
        browserRuntime: true,
      },
      tools: [],
      public_key: serverKeys.publicKey,
      ttl: 60,
      issued_at: new Date().toISOString(),
    })
    const sigHeaders = await signMcpPayload(
      originalBody,
      serverKeys.privateKey,
      serverKeys.publicKey,
    )
    const tamperedBody = originalBody.replace('"ttl":60', '"ttl":999999')

    const tamperedFetch: typeof globalThis.fetch = async () =>
      new Response(tamperedBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...sigHeaders,
        },
      })

    await expect(
      discoverAgent('https://tampered.example.com', {
        fetch: tamperedFetch,
        trustedPublicKeys: [serverKeys.publicKey],
      }),
    ).rejects.toThrow(/signature verification failed/i)

    // 3. Third-party NANDA AgentFacts using only endpoints.static and skills (no endpoints.mcp or tools)
    const thirdPartyFetch: typeof globalThis.fetch = async () =>
      Response.json({
        id: 'did:web:thirdparty.example.org',
        agent_name: 'urn:agent:thirdparty:advisor',
        label: 'Third-Party Advisor',
        description: 'Pure NANDA AgentFacts endpoint',
        version: '1.0.0',
        provider: { name: 'ThirdParty', url: 'https://thirdparty.example.org' },
        endpoints: {
          static: ['https://thirdparty.example.org/rpc'],
        },
        capabilities: {
          modalities: ['text'],
          streaming: false,
          batch: false,
          authentication: { methods: ['none'], required: false },
        },
        skills: [
          {
            id: 'advise',
            description: 'Gives domain advice',
            inputModes: ['text'],
            outputModes: ['text'],
          },
        ],
      })

    const thirdParty = await discoverAgent('https://thirdparty.example.org', {
      fetch: thirdPartyFetch,
    })
    expect(thirdParty.source).toBe('agent-facts')
    expect(thirdParty.name).toBe('Third-Party Advisor')
    expect(thirdParty.endpointUrl).toBe('https://thirdparty.example.org/rpc')
    expect(thirdParty.tools).toEqual([
      {
        name: 'advise',
        description: 'Gives domain advice',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
  })
})