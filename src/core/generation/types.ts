import type { z } from "zod";

/**
 * Standard JSON-RPC 2.0 request envelope used by MCP.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Standard JSON-RPC 2.0 response envelope.
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Context passed into every tool execution or route proxy.
 * Carries incoming HTTP headers/cookies and optional framework dispatcher.
 */
export interface ExecutionContext {
  request: Request;
  headers: Headers;
  dispatch?: InternalDispatcher;
  signal?: AbortSignal;
}

/**
 * Function provided by framework adapters (e.g., Hono's app.fetch)
 * so BindMCP can invoke existing routes in-memory without a network hop.
 */
export type InternalDispatcher = (request: Request) => Promise<Response>;

/**
 * Configuration for declarative route proxying to an existing endpoint.
 */
export interface RouteProxyConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Optional mapping of input fields to URL path params (e.g., { id: 'userId' } for /users/:id) */
  paramMap?: Record<string, string>;
  /** Forward incoming Authorization and Cookie headers to the internal route (default: true) */
  forwardAuth?: boolean;
}

/**
 * Base properties shared by all registered MCP tools.
 */
export interface BaseToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: TInput;
}

/**
 * Tool backed by a direct async handler function.
 */
export interface FunctionToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> extends BaseToolDefinition<TInput> {
  execute: (
    input: z.infer<TInput>,
    ctx: ExecutionContext,
  ) => Promise<TOutput> | TOutput;
  route?: never;
}

/**
 * Tool backed by an existing HTTP route on the host server.
 */
export interface RouteToolDefinition<
  TInput extends z.ZodType = z.ZodType,
> extends BaseToolDefinition<TInput> {
  route: RouteProxyConfig;
  execute?: never;
}

/**
 * Discriminated union: a tool uses either `execute` or `route`.
 */
export type ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> = FunctionToolDefinition<TInput, TOutput> | RouteToolDefinition<TInput>;

/**
 * Serialized tool descriptor returned in `tools/list` and `.well-known` manifests.
 */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Standard MCP tool execution result payload.
 */
export interface McpToolCallResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Options passed to `gateway.handle()` by framework adapters.
 */
export interface HandleRequestOptions {
  /** Base path where MCP is mounted (default: '/mcp') */
  basePath?: string;
  /** Optional internal router dispatcher for route-proxied tools */
  dispatch?: InternalDispatcher;
}

/**
 * Configuration options for initializing BindMCP.
 */
export interface BindMcpOptions {
  name: string;
  version: string;
  basePath?: string;
}
