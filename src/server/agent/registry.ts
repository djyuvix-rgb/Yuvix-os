import { zodToJsonSchema } from "zod-to-json-schema";
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { ToolDefinition, ToolGroup } from "./types";

/** The SDK's own schema type, so a drift here fails to compile rather than at runtime. */
export type ToolInputSchema = Anthropic.Tool.InputSchema;

/**
 * Converts a tool's Zod schema to the JSON Schema the Messages API accepts.
 *
 * Exported so the test suite can assert every registered tool produces a valid
 * draft 2020-12 schema — an invalid one fails the whole request, not just the
 * offending tool, so it takes down every run until it is fixed.
 */
export function toolInputSchema(schema: z.ZodType<unknown>): ToolInputSchema {
  const json = zodToJsonSchema(schema, {
    $refStrategy: "none",
    // The wrapper object confuses the API; we want the bare schema.
    definitionPath: "definitions",
  }) as Record<string, unknown>;

  // zod-to-json-schema stamps a draft-07 $schema; the API wants 2020-12 or nothing.
  delete json.$schema;
  delete json.definitions;

  return { ...json, type: "object" } as ToolInputSchema;
}

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
      // Draft 2020-12, which is what the Messages API validates against. The
      // "openApi3" target looks tempting but emits draft-04 spellings such as
      // `exclusiveMinimum: true`, which the API rejects outright. Refs are
      // inlined because a tool schema has to stand alone.
      input_schema: toolInputSchema(t.schema),
    }));
}
