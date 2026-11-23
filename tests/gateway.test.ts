import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { BindMCP, McpErrorCode } from '../src/index.js'
import { createHonoAdapter } from '../src/adapters/hono.js'
import { createFetchAdapter } from '../src/adapters/fetch.js'
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