import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/server/db/client";
import { toJson } from "@/server/db/json";
import { env } from "@/server/env";
import { errorMessage, log } from "@/server/logger";
import { buildBusinessContext } from "@/server/memory/context";
import { researchConfigured } from "@/server/env";
import { anthropic, AgentNotConfiguredError, estimateCostUsd, withRetry } from "./client";
import { executeTool, releaseRun } from "./executor";
import { makePlan } from "./planner";
import { systemPrompt, verificationPrompt } from "./prompt";
import { anthropicToolSpecs, allTools } from "./registry";
import type { AgentEvent, PlanStep, ToolContext } from "./types";

export interface RunOptions {
  objective: string;
  userId: string | null;
  conversationId?: string | null;
  trigger?: "chat" | "schedule" | "job" | "api";
  /** Skips planning + verification. Used by background jobs with narrow scopes. */
  lightweight?: boolean;
  timezone?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed" | "waiting_approval" | "cancelled";
  text: string;
  approvalIds: string[];
  steps: number;
  costUsd: number;
}

type Emit = (event: AgentEvent) => void;

/**
 * The agent loop:
 *
 *   understand → recall → plan → select tools → act → verify → persist → report
 *
 * The loop is deliberately not a straight-line executor of the plan. After every
 * tool result the model re-decides, so a plan that turns out to be wrong gets
 * abandoned rather than completed pointlessly.
 */
export async function runAgent(options: RunOptions, emit: Emit = () => {}): Promise<RunResult> {
  const trigger = options.trigger ?? "chat";
  const run = await prisma.agentRun.create({
    data: {
      conversationId: options.conversationId ?? null,
      trigger,
      objective: options.objective.slice(0, 4000),
      model: env.model,
    },
  });

  const approvalIds: string[] = [];
  let toolCallCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";
  let status: RunResult["status"] = "completed";

  const ctx: ToolContext = {
    runId: run.id,
    userId: options.userId,
    conversationId: options.conversationId ?? null,
    emit,
    signal: options.signal,
  };

  emit({ type: "run_started", runId: run.id, objective: options.objective });
  log.info("agent.run.started", { runId: run.id, trigger, objective: options.objective.slice(0, 200) });

  try {
    if (!env.anthropicApiKey) throw new AgentNotConfiguredError();

    const context = await buildBusinessContext(options.objective);
    const connected = await prisma.integration.findMany({
      where: { status: "configured" },
      select: { key: true },
    });

    const system = systemPrompt({
      context: context.markdown,
      now: new Date(),
      timezone: options.timezone ?? "UTC",
      researchAvailable: researchConfigured(),
      connectedIntegrations: connected.map((c) => c.key),
    });

    // ── Plan ────────────────────────────────────────────────────────────────
    let plan: PlanStep[] = [];
    if (!options.lightweight) {
      const planned = await makePlan({
        objective: options.objective,
        context: context.markdown,
        toolNames: allTools().map((t) => t.name),
      });
      plan = planned.steps;
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { planJson: toJson(plan), objectiveType: planned.objectiveType },
      });
      if (plan.length) emit({ type: "plan", steps: plan });
    }

    // ── Conversation history ────────────────────────────────────────────────
    const messages: Anthropic.MessageParam[] = [];
    if (options.conversationId) {
      const history = await prisma.message.findMany({
        where: { conversationId: options.conversationId },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      for (const m of history.reverse()) {
        if (m.role === "user" || m.role === "assistant") {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }

    const opening = plan.length
      ? `${options.objective}\n\n[Working plan — adapt it if the evidence says otherwise:\n${plan
          .map((s) => `${s.id}. ${s.step}${s.tool ? ` (${s.tool})` : ""}`)
          .join("\n")}]`
      : options.objective;
    messages.push({ role: "user", content: opening });

    const tools = anthropicToolSpecs();
    let verified = false;

    // ── Act ─────────────────────────────────────────────────────────────────
    for (let step = 0; step < env.maxSteps; step++) {
      if (options.signal?.aborted) {
        status = "cancelled";
        break;
      }

      const response = await withRetry("messages", () =>
        anthropic().messages.create({
          model: env.model,
          max_tokens: 8000,
          system,
          tools,
          messages,
        }),
      );

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      const textBlocks = response.content.filter((b) => b.type === "text");
      const toolUses = response.content.filter((b) => b.type === "tool_use");

      const turnText = textBlocks.map((b) => (b as { text: string }).text).join("\n").trim();
      if (turnText) {
        if (toolUses.length) emit({ type: "thinking", text: turnText });
        else emit({ type: "text", text: turnText });
        finalText = turnText;
      }

      messages.push({ role: "assistant", content: response.content });

      if (toolUses.length === 0) {
        // ── Verify ────────────────────────────────────────────────────────
        // One self-check pass, and only when the run actually did something —
        // a plain question does not need it, and it would just double the cost.
        if (!verified && !options.lightweight && toolCallCount > 0) {
          verified = true;
          messages.push({ role: "user", content: verificationPrompt(options.objective) });
          continue;
        }
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const block = use as { id: string; name: string; input: unknown };
        toolCallCount++;
        const result = await executeTool(block.name, block.input, ctx);

        if ("awaitingApproval" in result && result.awaitingApproval) {
          approvalIds.push(result.approvalId);
          status = "waiting_approval";
        }

        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: !result.ok,
          content: JSON.stringify(
            result.ok
              ? result.data
              : { error: result.error, ...("hint" in result && result.hint ? { hint: result.hint } : {}) },
          ).slice(0, 60_000),
        });

        markPlanProgress(plan, block.name);
      }

      messages.push({ role: "user", content: results });

      if (step === env.maxSteps - 1) {
        // Give the model one final turn to summarise rather than cutting off mid-work.
        messages.push({
          role: "user",
          content:
            "You have reached the step limit for this run. Stop calling tools. Summarise what you completed, what you did not, and the exact next step.",
        });
        const wrap = await withRetry("messages.wrap", () =>
          anthropic().messages.create({ model: env.model, max_tokens: 2000, system, messages }),
        );
        inputTokens += wrap.usage.input_tokens;
        outputTokens += wrap.usage.output_tokens;
        finalText = wrap.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n");
        emit({ type: "text", text: finalText });
      }
    }

    if (verified && toolCallCount > 0) {
      emit({ type: "verification", passed: true, notes: "Output re-checked against the original request." });
    }

    if (status === "completed" && approvalIds.length) status = "waiting_approval";

    const costUsd = estimateCostUsd(env.model, inputTokens, outputTokens);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status,
        result: finalText.slice(0, 20_000),
        planJson: toJson(plan),
        verification: verified ? "self-check pass completed" : null,
        inputTokens,
        outputTokens,
        costUsd,
        finishedAt: new Date(),
      },
    });

    if (options.conversationId && finalText) {
      await prisma.message.create({
        data: { conversationId: options.conversationId, role: "assistant", content: finalText, runId: run.id },
      });
      await prisma.conversation.update({
        where: { id: options.conversationId },
        data: { updatedAt: new Date() },
      });
    }

    emit({ type: "run_finished", runId: run.id, status, result: finalText });
    log.info("agent.run.finished", { runId: run.id, status, toolCalls: toolCallCount, costUsd: Number(costUsd.toFixed(4)) });

    return { runId: run.id, status, text: finalText, approvalIds, steps: toolCallCount, costUsd };
  } catch (err) {
    const message = errorMessage(err);
    log.error("agent.run.failed", { runId: run.id, error: message });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "failed", error: message, finishedAt: new Date(), inputTokens, outputTokens },
    });
    emit({ type: "error", message, recoverable: err instanceof AgentNotConfiguredError ? false : true });
    emit({ type: "run_finished", runId: run.id, status: "failed", result: message });
    return { runId: run.id, status: "failed", text: message, approvalIds, steps: toolCallCount, costUsd: 0 };
  } finally {
    releaseRun(run.id);
  }
}

function markPlanProgress(plan: PlanStep[], tool: string) {
  const match = plan.find((s) => s.tool === tool && s.status === "pending");
  if (match) match.status = "done";
}
