import { z } from "zod";
import type { McpToolDescriptor, ToolDefinition } from "../generation/types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(definition: ToolDefinition): void {
    if (!definition.name.trim()) {
      throw new Error("Tool name cannot be empty");
    }

    if (this.tools.has(definition.name)) {
      throw new Error(
        `Duplicate tool registration: "${definition.name}" is already registered`,
      );
    }

    this.tools.set(definition.name, definition);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public listDescriptors(): McpToolDescriptor[] {
    const descriptors: McpToolDescriptor[] = [];

    for (const tool of this.tools.values()) {
      // Strip top-level $schema metadata as MCP expects raw JSON Schema objects
      const rawSchema = z.toJSONSchema(tool.input) as Record<string, unknown>;

      const { $schema: _ignored, ...cleanSchema } = rawSchema;

      descriptors.push({
        name: tool.name,
        description: tool.description,
        inputSchema: cleanSchema,
      });
    }

    return descriptors;
  }
}
