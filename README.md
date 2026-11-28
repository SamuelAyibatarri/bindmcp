# BindMCP

Lightweight, Web Standard-first TypeScript MCP, WebMCP, and MIT NANDA gateway for AI agents.

BindMCP exposes Zod 4 tool definitions across both server HTTP endpoints (`/.well-known/agent-facts`, `/.well-known/mcp`, `POST /mcp`) and in-browser transports (Chrome `navigator.modelContext`, cross-browser `window.postMessage`, and companion extension bridges), with built-in Web Crypto Ed25519 signing/verification, CORS handling, and zero-dependency telemetry hooks.

## Installation

```bash
npm install bindmcp zod
```

## Quick Start

### 1. Define Your Gateway and Tools

```ts
import { BindMCP, generateMcpKeyPair } from 'bindmcp'
import { z } from 'zod'

const serverKeys = await generateMcpKeyPair()

export const gateway = new BindMCP({
  name: 'my-service',
  version: '1.0.0',
  // MIT NANDA AgentFacts identity & metadata
  agentId: 'did:web:my-service.example.com',
  agentName: 'urn:agent:acme:my-service',
  label: 'My Agentic Service',
  description: 'Verifiable MCP & NANDA tool gateway',
  provider: { name: 'Acme Labs', url: 'https://example.com' },
  ttl: 3600,
  // Ed25519 manifest signing & optional incoming request verification
  signingKey: serverKeys,
  security: {
    requireSignature: false,
  },
  // Zero-dependency telemetry hooks
  onDiscovery: ({ path, origin }) => {
    console.log('Discovery hit:', path, origin)
  },
  onToolCall: ({ toolName, durationMs, success, verifiedAgentKey, error }) => {
    console.log({ toolName, durationMs, success, verifiedAgentKey, error })
  },
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
      callerKey: ctx.verifiedAgentKey ?? null,
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

## Ed25519 Cryptographic Signing & Verification

BindMCP uses Web Crypto (`crypto.subtle`) Ed25519 keys with zero external dependencies:

```ts
import { generateMcpKeyPair, signMcpPayload, verifyMcpRequest } from 'bindmcp'

const keys = await generateMcpKeyPair()
const rawBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

// Produces X-MCP-Signature, X-MCP-Timestamp, and X-MCP-Public-Key headers
const headers = await signMcpPayload(rawBody, keys.privateKey, keys.publicKey)

const result = await verifyMcpRequest(new Headers(headers), rawBody, {
  requireSignature: true,
  trustedPublicKeys: [keys.publicKey],
})
```

## Outbound Cross-Agent Client

Discover remote agents (trying `/.well-known/agent-facts` first and falling back to `/.well-known/mcp`), verify `X-MCP-Signature` headers, and invoke remote tools with optional Ed25519 signatures:

```ts
import { discoverAgent, callRemoteTool, generateMcpKeyPair } from 'bindmcp'

const clientKeys = await generateMcpKeyPair()
const agent = await discoverAgent('https://partner.example.com', {
  requireSignature: true,
})

const response = await callRemoteTool(
  agent.endpointUrl,
  'get_quote',
  { units: 10 },
  clientKeys,
)
```

## Browser Adapter & Frontend Client (`bindmcp/browser`)

### Tiered Browser Adapter (DOM / Client-Side Tools)

Registers tools into Chrome's native `navigator.modelContext` (Tier 1) when available, activates a cross-browser `window.postMessage` JSON-RPC bridge (Tier 2), and exposes a direct in-page client (Tier 3):

```ts
import { createBrowserAdapter } from 'bindmcp/browser'

const client = createBrowserAdapter(pageGateway, {
  allowedOrigins: [window.location.origin],
  exposeGlobal: '__bindmcp',
})
```

### Mirror Backend Tools into Chrome WebMCP

Avoid duplicating Zod schemas on the frontend—auto-discover your backend manifest and mirror its tools into `navigator.modelContext`:

```ts
import { bridgeRemoteToWebMcp } from 'bindmcp/browser'

const bridge = await bridgeRemoteToWebMcp(window.location.origin)
```

### Browser Environment Detector & Extension Wire Client

Inspect the visitor's browser and runtime capabilities (`safe-extension`, `native-webmcp`, `browser-language-model`, `external-mcp`, `mozilla-otari`), or communicate with a companion Safe Key Vault extension over `bindmcp-extension-v1`:

```ts
import { detectAgentEnvironment, createExtensionBridgeClient } from 'bindmcp/browser'

const env = detectAgentEnvironment()
const bridge = createExtensionBridgeClient()

const grant = await bridge.requestSession({
  requestedTtlMs: 15 * 60_000,
  requestedMaxRequests: 20,
  purpose: 'Compare options on this page',
})

const reply = await bridge.prompt({
  sessionId: grant.sessionId,
  prompt: 'Summarize the top 3 matches',
})
```

> **Security boundary:** `createExtensionBridgeClient()` runs in untrusted webpage JavaScript and enforces no limits itself. All origin checks, user consent prompts, session expiration, request quotas, cooldowns, and concurrency locks must be enforced exclusively inside the browser extension's isolated background service worker.

## Endpoints Exposed

* `GET /.well-known/agent-facts` — Serves a signed MIT NANDA-compliant `AgentFacts` document (`https://agentfacts.org/schema/v1`) with identity, endpoints, capabilities, skills, MCP tools, and telemetry declaration.
* `GET /.well-known/mcp` — Returns the server metadata and JSON Schema catalog of registered tools.
* `POST /mcp` (configurable via `basePath`) — Handles JSON-RPC 2.0 `initialize`, `tools/list`, `tools/call`, and notifications (`202 Accepted`).
* `OPTIONS` — Handles CORS preflight requests on all MCP and `.well-known` discovery routes.

## License

MIT
