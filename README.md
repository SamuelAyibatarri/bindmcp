# BindMCP

Framework-agnostic TypeScript gateway to expose, validate, and execute Model Context Protocol (MCP) and WebMCP tools for AI agents.

BindMCP sits at the edge of an existing web application, automatically generating `.well-known/mcp` discovery manifests and JSON Schemas from Zod 4 definitions, validating incoming JSON-RPC 2.0 tool calls, and forwarding authenticated execution context to either direct async handlers or existing HTTP routes.

## Installation

```bash
npm install bindmcp zod

```

## Quick Start

### 1. Define Your Gateway and Tools

```ts
import { BindMCP } from 'bindmcp'
import { z } from 'zod'

export const gateway = new BindMCP({
  name: 'my-service',
  version: '1.0.0',
})

// Option A: Direct async execution handler
gateway.tool({
  name: 'calculate_total',
  description: 'Calculates order total with tax',
  input: z.object({
    subtotal: z.number().positive(),
    taxRate: z.number().min(0).max(1),
  }),
  execute: async ({ subtotal, taxRate }, ctx) => {
    const auth = ctx.headers.get('authorization')
    return {
      total: subtotal * (1 + taxRate),
      authenticated: Boolean(auth),
    }
  },
})

// Option B: Declarative proxy to an existing REST endpoint
gateway.tool({
  name: 'get_user_orders',
  description: 'Fetches orders for a specific user',
  input: z.object({
    userId: z.string(),
    status: z.enum(['pending', 'completed']).optional(),
  }),
  route: {
    method: 'GET',
    path: '/api/users/:id/orders',
    paramMap: { id: 'userId' },
  },
})

```

### 2. Mount on Your Server Framework

#### Hono (Cloudflare Workers, Bun, Node.js)

```ts
import { Hono } from 'hono'
import { createHonoAdapter } from 'bindmcp/hono'
import { gateway } from './mcp'

const app = new Hono()

// Pass `app` so route-proxied tools dispatch in-memory without a network hop
app.use('*', createHonoAdapter(gateway, { app }))

export default app

```

#### Express

```ts
import express from 'express'
import { createExpressAdapter } from 'bindmcp/express'
import { gateway } from './mcp'

const app = express()
app.use(express.json())
app.use(createExpressAdapter(gateway))

app.listen(3000)

```

#### Web Standard Fetch (Deno, Bun, Cloudflare Workers)

```ts
import { createFetchAdapter } from 'bindmcp/fetch'
import { gateway } from './mcp'

export default {
  fetch: createFetchAdapter(gateway),
}

```

## Endpoints Exposed

* `GET /.well-known/mcp` — Returns the server metadata and JSON Schema catalog of registered tools.
* `POST /mcp` (configurable via `basePath`) — Handles JSON-RPC 2.0 `initialize`, `tools/list`, and `tools/call` requests.

## License

MIT