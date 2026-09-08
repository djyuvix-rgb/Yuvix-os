import { createHash } from "node:crypto";
import { prisma } from "@/server/db/client";
import { toJson } from "@/server/db/json";
import { toolErrorMessage } from "@/server/db/prisma-errors";
import { errorMessage, log } from "@/server/logger";
import { getTool } from "./registry";
import type { ToolContext, ToolResult } from "./types";

/**
 * Stable fingerprint of a tool call, so an approval granted for one specific
 * action cannot be reused to execute a different one.
 */
export function argsFingerprint(tool: string, args: unknown): string {
  return createHash("sha256").update(`${tool}:${stableStringify(args)}`).digest("hex").slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

async function audit(entry: {
  action: string;
  actor?: string;
  userId?: string | null;
  runId?: string | null;
  autonomy?: string;
  ok: boolean;
  detail: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
}) {
  await prisma.auditLog.create({
    data: {
      action: entry.action,
      actor: entry.actor ?? "agent",
      userId: entry.userId ?? null,
      runId: entry.runId ?? null,
      autonomy: entry.autonomy ?? null,
      ok: entry.ok,
      detailJson: toJson(entry.detail),
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
    },
  });
}

const stepIndex = new Map<string, number>();

/**
 * Tools can run outside a persisted agent run — an approved Level 2 action
 * executed from the Approvals panel is the main case. Trace rows and approvals
 * both carry a foreign key to AgentRun, so resolve once per run id whether that
 * row actually exists, and fall back to an unlinked record rather than failing
 * the action itself.
 */
const runExistsCache = new Map<string, boolean>();

async function resolveRunId(runId: string): Promise<string | null> {
  const cached = runExistsCache.get(runId);
  if (cached !== undefined) return cached ? runId : null;
  const exists = (await prisma.agentRun.count({ where: { id: runId } })) > 0;
  runExistsCache.set(runId, exists);
  return exists ? runId : null;
}

async function recordStep(ctx: ToolContext, data: {
  type: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  summary: string;
  ok: boolean;
  durationMs: number;
}) {
  const runId = await resolveRunId(ctx.runId);
  // Without a run to hang it on, the audit log is the record of what happened.
  if (!runId) return;

  const idx = (stepIndex.get(runId) ?? 0) + 1;
  stepIndex.set(runId, idx);
  try {
    await prisma.agentStep.create({
      data: {
        runId,
        index: idx,
        type: data.type,
        tool: data.tool ?? null,
        inputJson: toJson(data.input ?? {}),
        outputJson: toJson(truncate(data.output)),
        summary: data.summary.slice(0, 2000),
        ok: data.ok,
        durationMs: data.durationMs,
      },
    });
  } catch (err) {
    log.warn("agent.step.persist_failed", { runId: ctx.runId, error: errorMessage(err) });
  }
}

/** Keeps a single huge tool result (e.g. a page fetch) from bloating the trace. */
function truncate(value: unknown, max = 12_000): unknown {
  const json = toJson(value);
  if (json.length <= max) return value;
  return { truncated: true, preview: json.slice(0, max), originalLength: json.length };
}

/**
 * The one gate every tool call passes through.
 *
 * Enforcement order matters: existence → schema → autonomy → execution. A
 * malformed call never reaches the approval check, and no Level 2 tool body runs
 * without a matching approved row.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return {
      ok: false,
      error: `Unknown tool "${name}".`,
      recoverable: true,
      hint: "Use only tools from the provided list.",
    };
  }

  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Invalid arguments for ${name}: ${issues}`,
      recoverable: true,
      hint: "Fix the arguments and call the tool again.",
    };
  }
  const input = parsed.data as never;

  // ── Level 3: no execution path exists. ────────────────────────────────────
  if (tool.autonomy === "level3") {
    await audit({
      action: "tool.blocked",
      runId: ctx.runId,
      userId: ctx.userId,
      autonomy: "level3",
      ok: false,
      detail: { tool: name, reason: tool.forbiddenReason },
    });
    return {
      ok: false,
      error: `${name} is a Level 3 action and can never be performed autonomously. ${tool.forbiddenReason}`,
      recoverable: false,
      hint: "Prepare the material, explain what needs to happen, and hand it to the operator to do themselves.",
    };
  }

  // ── Level 2: execute only against a matching approved row. ────────────────
  if (tool.autonomy === "level2") {
    const fingerprint = argsFingerprint(name, input);
    const approved = await prisma.approval.findFirst({
      where: { tool: name, status: "approved", argsJson: { contains: fingerprint } },
      orderBy: { decidedAt: "desc" },
    });

    if (!approved) {
      const preview = await tool.preview!(input, ctx);
      const approval = await prisma.approval.create({
        data: {
          runId: await resolveRunId(ctx.runId),
          userId: ctx.userId,
          tool: name,
          autonomy: "level2",
          title: preview.title,
          description: preview.description,
          // The fingerprint travels with the args so approval binds to these exact args.
          argsJson: toJson({ fingerprint, args: input }),
          previewJson: toJson({ details: preview.details }),
          riskNotes: preview.riskNotes ?? null,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });

      ctx.emit({
        type: "approval_required",
        approvalId: approval.id,
        title: preview.title,
        description: preview.description,
        details: preview.details,
      });
      await recordStep(ctx, {
        type: "approval_wait",
        tool: name,
        input,
        summary: `Approval requested: ${preview.title}`,
        ok: true,
        durationMs: 0,
      });
      await audit({
        action: "approval.requested",
        runId: ctx.runId,
        userId: ctx.userId,
        autonomy: "level2",
        ok: true,
        detail: { tool: name, approvalId: approval.id, title: preview.title },
        entityType: "Approval",
        entityId: approval.id,
      });

      return {
        ok: false,
        awaitingApproval: true,
        approvalId: approval.id,
        error: `This action needs approval before it can run: ${preview.title}. An approval request was created and is waiting in the operator's inbox. Continue with everything else you can do without it, and tell the operator what is waiting.`,
        recoverable: false,
      };
    }
  }

  // ── Execute. ──────────────────────────────────────────────────────────────
  const started = Date.now();
  ctx.emit({ type: "tool_start", tool: name, input, autonomy: tool.autonomy });

  try {
    const data = await tool.execute(input, ctx);
    const durationMs = Date.now() - started;
    const summary = summarise(name, data);

    await recordStep(ctx, { type: "tool_result", tool: name, input, output: data, summary, ok: true, durationMs });
    if (!tool.readOnly) {
      await audit({
        action: "tool.execute",
        runId: ctx.runId,
        userId: ctx.userId,
        autonomy: tool.autonomy,
        ok: true,
        detail: { tool: name, input, durationMs },
      });
    }
    ctx.emit({ type: "tool_end", tool: name, ok: true, summary, durationMs });
    return { ok: true, data };
  } catch (err) {
    const durationMs = Date.now() - started;
    // The raw message (a Prisma error can run to a multi-line dump of file
    // paths and source snippets) goes to the log and the audit trail, where a
    // human debugging the system benefits from the detail. The model gets the
    // narrowed version: what happened and what to do about it, from
    // toolErrorMessage — never the internals.
    const rawMessage = errorMessage(err);
    const { message: toolMessage, hint } = toolErrorMessage(err);

    await recordStep(ctx, { type: "error", tool: name, input, output: { message: rawMessage }, summary: toolMessage, ok: false, durationMs });
    await audit({
      action: "tool.execute",
      runId: ctx.runId,
      userId: ctx.userId,
      autonomy: tool.autonomy,
      ok: false,
      detail: { tool: name, input, error: rawMessage },
    });
    ctx.emit({ type: "tool_end", tool: name, ok: false, summary: toolMessage, durationMs });
    log.error("agent.tool.failed", { runId: ctx.runId, tool: name, error: rawMessage });

    return {
      ok: false,
      error: toolMessage,
      // Most tool failures are the agent's to route around; it should adapt, not abort.
      recoverable: true,
      hint: hint ?? "Try a different approach, or report the limitation to the operator instead of guessing.",
    };
  }
}

/** One-line human summary of a tool result for the trace and the UI. */
function summarise(tool: string, data: unknown): string {
  if (data === null || data === undefined) return `${tool}: no data`;
  if (typeof data === "string") return `${tool}: ${data.slice(0, 200)}`;
  if (Array.isArray(data)) return `${tool}: ${data.length} item(s)`;
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.summary === "string") return obj.summary.slice(0, 200);
    const keys = Object.keys(obj).slice(0, 6);
    return `${tool}: {${keys.join(", ")}}`;
  }
  return `${tool}: ${String(data).slice(0, 200)}`;
}

/** Clears per-run caches. Called when a run ends. */
export function releaseRun(runId: string) {
  stepIndex.delete(runId);
  runExistsCache.delete(runId);
}
