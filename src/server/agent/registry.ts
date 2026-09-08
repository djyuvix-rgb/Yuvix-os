import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition, ToolGroup } from "./types";

const tools = new Map<string, ToolDefinition<never, unknown>>();

export function registerTools(defs: ToolDefinition<never, unknown>[]) {
  for (const def of defs) {
    if (tools.has(def.name)) throw new Error(`Duplicate tool registration: ${def.name}`);
    if (def.autonomy === "level2" && !def.preview) {
      throw new Error(`Level 2 tool "${def.name}" must define preview() so approvals are informed`);
    }
    if (def.autonomy === "level3" && !def.forbiddenReason) {
      throw new Error(`Level 3 tool "${def.name}" must state forbiddenReason`);
    }
    tools.set(def.name, def);
  }
}

/** Helper that preserves the input type through registration. */
export function defineTool<I, O>(def: ToolDefinition<I, O>): ToolDefinition<never, unknown> {
  return def as unknown as ToolDefinition<never, unknown>;
}

export function getTool(name: string): ToolDefinition<never, unknown> | undefined {
  return tools.get(name);
}

export function allTools(): ToolDefinition<never, unknown>[] {
  return [...tools.values()];
}

export function toolsByGroup(group: ToolGroup) {
  return allTools().filter((t) => t.group === group);
}

/** Anthropic tool-use schema for the model. Level 3 tools are never exposed. */
export function anthropicToolSpecs() {
  return allTools()
    .filter((t) => t.autonomy !== "level3")
    .map((t) => ({
      name: t.name,
      description:
        t.autonomy === "level2"
          ? `${t.description}\n\n[REQUIRES USER APPROVAL — calling this creates an approval request; it does not execute immediately.]`
          : t.description,
      input_schema: zodToJsonSchema(t.schema, {
        target: "openApi3",
        $refStrategy: "none",
      }) as { type: "object"; properties?: Record<string, unknown> },
    }));
}
