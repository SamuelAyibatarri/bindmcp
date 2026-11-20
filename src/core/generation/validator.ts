import type { z } from "zod";
import { McpError, McpErrorCode } from "../../errors/mcp-errors.js";

export function validateInput<TSchema extends z.ZodType>(
  schema: TSchema,
  rawInput: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(rawInput);

  if (!result.success) {
    const formattedIssues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));

    throw new McpError(
      McpErrorCode.InvalidParams,
      "Tool input validation failed",
      formattedIssues,
    );
  }

  return result.data;
}
