import type { JsonRpcResponse, McpToolCallResult } from "./types.js";

export function formatJsonRpcSuccess<T>(
  id: string | number | null,
  result: T,
): JsonRpcResponse<T> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function formatJsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse<never> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

export function formatToolResult(
  output: unknown,
  isError = false,
): McpToolCallResult {
  const serialized =
    typeof output === "string"
      ? output
      : output === undefined
        ? "Success"
        : JSON.stringify(output, null, 2);

  return {
    content: [
      {
        type: "text",
        text: serialized,
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
