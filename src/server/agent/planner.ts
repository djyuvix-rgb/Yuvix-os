import { anthropic, withRetry } from "./client";
import { env } from "@/server/env";
import { log } from "@/server/logger";
import type { PlanStep } from "./types";

export interface Plan {
  objectiveType: "question" | "research" | "plan" | "execute" | "analysis" | "creative" | "admin";
  /** Trivial requests skip planning entirely so a one-line question stays fast. */
  trivial: boolean;
  reasoning: string;
  steps: PlanStep[];
}

const PLAN_SCHEMA = `{
  "objectiveType": "question|research|plan|execute|analysis|creative|admin",
  "trivial": boolean,
  "reasoning": "one or two sentences on how you read the request",
  "steps": [{ "step": "imperative description", "tool": "tool_name or null" }]
}`;

/**
 * Decomposition pass. Runs on the fast model: it is a routing decision, not the
 * work itself, and keeping it cheap means we can afford to always do it.
 */
export async function makePlan(args: {
  objective: string;
  context: string;
  toolNames: string[];
}): Promise<Plan> {
  const fallback: Plan = {
    objectiveType: "question",
    trivial: true,
    reasoning: "Planning unavailable; answering directly.",
    steps: [],
  };

  try {
    const response = await withRetry("plan", () =>
      anthropic().messages.create({
        model: env.fastModel,
        max_tokens: 1200,
        system: `You are the planning stage of YUVIX OS, an autonomous agent for an independent electronic music artist's business.

Decompose the operator's request into the smallest sequence of concrete steps that actually delivers the outcome — not a description of the outcome.

Rules:
- Mark trivial=true ONLY for greetings, clarifications, or questions answerable from the snapshot in one short paragraph with no tool call.
- Prefer steps that produce durable artifacts (records created, drafts written, research stored) over steps that only "consider" or "think about" something.
- Every step that needs data must name the tool that gets it. Never plan to recall a fact from thin air.
- 3–8 steps for most requests. Do not pad.
- Available tools: ${args.toolNames.join(", ")}

Reply with JSON only, matching:
${PLAN_SCHEMA}`,
        messages: [
          {
            role: "user",
            content: `Business snapshot:\n${args.context}\n\n---\nOperator request: ${args.objective}`,
          },
        ],
      }),
    );

    const text = response.content
      .filter((b): b is { type: "text"; text: string; citations: never } => b.type === "text")
      .map((b) => b.text)
      .join("");

    const json = extractJson(text);
    if (!json) return fallback;

    const raw = JSON.parse(json) as {
      objectiveType?: Plan["objectiveType"];
      trivial?: boolean;
      reasoning?: string;
      steps?: { step: string; tool?: string | null }[];
    };

    return {
      objectiveType: raw.objectiveType ?? "question",
      trivial: raw.trivial ?? false,
      reasoning: raw.reasoning ?? "",
      steps: (raw.steps ?? []).slice(0, 12).map((s, i) => ({
        id: i + 1,
        step: s.step,
        tool: s.tool ?? undefined,
        status: "pending" as const,
      })),
    };
  } catch (err) {
    log.warn("agent.plan.failed", { error: String(err) });
    return fallback;
  }
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
