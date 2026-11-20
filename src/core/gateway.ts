import type { z } from "zod";
import { ToolRegistry } from "./dispatch/registry.js";
import { validateInput } from "./generation/validator.js";
import {
  formatJsonRpcError,
  formatJsonRpcSuccess,
  formatToolResult,
} from "./generation/protocol.js";
import { McpError, McpErrorCode } from "../errors/mcp-errors.js";
import type {
  BindMcpOptions,
  ExecutionContext,
  HandleRequestOptions,
  JsonRpcRequest,
  RouteToolDefinition,
  ToolDefinition,
} from "./generation/types.js";

export class BindMCP {
  private readonly name: string;
  private readonly version: string;
  private readonly basePath: string;
  private readonly registry: ToolRegistry;

  constructor(options: BindMcpOptions) {
    this.name = options.name;
    this.version = options.version;
    this.basePath = options.basePath ?? "/mcp";
    this.registry = new ToolRegistry();
  }

  /**
   * Register a function-backed or route-proxied tool.
   */
  public tool<TInput extends z.ZodType, TOutput = unknown>(
    definition: ToolDefinition<TInput, TOutput>,
  ): this {
    this.registry.register(definition);
    return this;
  }

  /**
   * Expose the generated tool manifest (useful for build-time pregeneration or custom routes).
   */
  public getManifest() {
    return {
      name: this.name,
      version: this.version,
      endpoint: this.basePath,
      tools: this.registry.listDescriptors(),
    };
  }

  /**
   * Primary entry point called by all framework adapters.
   * Returns a Web Standard Response if the request matches an MCP route, or `null` if unhandled.
   */
  public async handle(
    request: Request,
    options: HandleRequestOptions = {},
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const mountPath = options.basePath ?? this.basePath;

    // 1. Handle .well-known discovery manifest
    if (request.method === "GET" && url.pathname === "/.well-known/mcp") {
      return Response.json(this.getManifest(), {
        status: 200,
        headers: { "Cache-Control": "no-cache" },
      });
    }

    // 2. Ignore requests not targeting the mounted MCP endpoint
    if (url.pathname !== mountPath) {
      return null;
    }

    // 3. Only accept POST for JSON-RPC execution
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = (await request.json()) as JsonRpcRequest;
    } catch {
      return Response.json(
        formatJsonRpcError(
          null,
          McpErrorCode.ParseError,
          "Invalid JSON payload",
        ),
        { status: 400 },
      );
    }

    const requestId = rpcRequest.id ?? null;

    if (rpcRequest.jsonrpc !== "2.0" || typeof rpcRequest.method !== "string") {
      return Response.json(
        formatJsonRpcError(
          requestId,
          McpErrorCode.InvalidRequest,
          "Invalid JSON-RPC 2.0 request",
        ),
        { status: 400 },
      );
    }

    try {
      const result = await this.routeRpcMethod(rpcRequest, request, options);
      return Response.json(formatJsonRpcSuccess(requestId, result), {
        status: 200,
      });
    } catch (err) {
      if (err instanceof McpError) {
        return Response.json(
          formatJsonRpcError(requestId, err.code, err.message, err.data),
          {
            status: 200, // JSON-RPC application errors return HTTP 200 with an error payload
          },
        );
      }

      const message =
        err instanceof Error ? err.message : "Internal server error";
      return Response.json(
        formatJsonRpcError(requestId, McpErrorCode.InternalError, message),
        { status: 500 },
      );
    }
  }

  private async routeRpcMethod(
    rpc: JsonRpcRequest,
    request: Request,
    options: HandleRequestOptions,
  ): Promise<unknown> {
    switch (rpc.method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          serverInfo: { name: this.name, version: this.version },
          capabilities: { tools: {} },
        };

      case "tools/list":
        return {
          tools: this.registry.listDescriptors(),
        };

      case "tools/call":
        return await this.executeToolCall(rpc.params, request, options);

      default:
        throw new McpError(
          McpErrorCode.MethodNotFound,
          `Unsupported MCP method: ${rpc.method}`,
        );
    }
  }

  private async executeToolCall(
    params: Record<string, unknown> | undefined,
    request: Request,
    options: HandleRequestOptions,
  ) {
    const toolName = params?.name;
    if (typeof toolName !== "string" || !toolName) {
      throw new McpError(
        McpErrorCode.InvalidParams,
        "Missing or invalid tool name",
      );
    }

    const tool = this.registry.get(toolName);
    if (!tool) {
      throw new McpError(
        McpErrorCode.MethodNotFound,
        `Tool not found: ${toolName}`,
      );
    }

    // Validate incoming arguments against the tool's Zod schema
    const validatedArgs = validateInput(tool.input, params?.arguments ?? {});

    const ctx: ExecutionContext = {
      request,
      headers: request.headers,
      signal: request.signal,
      ...(options.dispatch ? { dispatch: options.dispatch } : {}),
    };

    // Branch A: Direct async handler
    if ("execute" in tool && typeof tool.execute === "function") {
      const output = await tool.execute(validatedArgs, ctx);
      return formatToolResult(output);
    }

    // Branch B: Declarative route proxy
    if ("route" in tool && tool.route) {
      return await this.proxyToRoute(
        tool,
        validatedArgs as Record<string, unknown>,
        ctx,
      );
    }

    throw new McpError(
      McpErrorCode.InternalError,
      `Tool "${toolName}" has no execution target`,
    );
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
      );
    }

    const { method, path, paramMap, forwardAuth = true } = tool.route;
    const incomingUrl = new URL(ctx.request.url);
    let resolvedPath = path;
    const remainingArgs = { ...args };

    // Substitute path parameters (e.g., /users/:id)
    if (paramMap) {
      for (const [paramKey, argKey] of Object.entries(paramMap)) {
        if (argKey in remainingArgs) {
          resolvedPath = resolvedPath.replace(
            `:${paramKey}`,
            encodeURIComponent(String(remainingArgs[argKey])),
          );
          delete remainingArgs[argKey];
        }
      }
    }

    const targetUrl = new URL(resolvedPath, incomingUrl.origin);
    const headers = new Headers({ "Content-Type": "application/json" });

    if (forwardAuth) {
      const auth = ctx.headers.get("authorization");
      const cookie = ctx.headers.get("cookie");
      if (auth) headers.set("authorization", auth);
      if (cookie) headers.set("cookie", cookie);
    }

    let body: string | undefined;
    if (method === "GET" || method === "DELETE") {
      for (const [key, value] of Object.entries(remainingArgs)) {
        if (value !== undefined) {
          targetUrl.searchParams.set(key, String(value));
        }
      }
    } else {
      body = JSON.stringify(remainingArgs);
    }

    const proxyRequest = new Request(targetUrl.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    const response = await ctx.dispatch(proxyRequest);
    const responseText = await response.text();

    if (!response.ok) {
      return formatToolResult(
        { status: response.status, error: responseText },
        true,
      );
    }

    try {
      return formatToolResult(JSON.parse(responseText));
    } catch {
      return formatToolResult(responseText);
    }
  }
}
