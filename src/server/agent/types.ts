import type { z } from "zod";

/**
 * Autonomy levels. This is the safety spine of YUVIX OS and it is enforced by
 * the executor, not by prompting — a Level 2 tool physically cannot run until an
 * Approval row is approved, and a Level 3 tool has no execution path at all.
 */
export type AutonomyLevel = "level1" | "level2" | "level3";

export const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  level1: "Safe: research, analysis, drafting, planning, internal records. Runs automatically.",
  level2: "Consequential: sends messages, publishes, spends money, deletes, or changes core business data. Requires explicit approval.",
  level3: "Forbidden to automate: contracts, legal commitments, money transfers, impersonation, irreversible acts. The agent may only prepare and advise.",
};

export type ToolGroup =
  | "memory" | "goals" | "projects" | "music" | "crm" | "content"
  | "campaign" | "finance" | "analytics" | "research" | "files"
  | "audio" | "intelligence" | "system";

export interface ToolContext {
  runId: string;
  userId: string | null;
  conversationId: string | null;
  /** Emits a trace event; the UI streams these so the user sees the agent work. */
  emit: (event: AgentEvent) => void;
  /** Set when the run is resuming after an approval was granted. */
  approvalId?: string | null;
  signal?: AbortSignal;
}

export interface ApprovalPreview {
  title: string;
  description: string;
  /** Bullet lines rendered verbatim in the approval card. */
  details: string[];
  riskNotes?: string;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  group: ToolGroup;
  /** Written for the model: what it does, when to use it, what it returns. */
  description: string;
  autonomy: AutonomyLevel;
  schema: z.ZodType<I>;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
  /** Required for level2 tools: what the user is being asked to approve. */
  preview?: (input: I, ctx: ToolContext) => Promise<ApprovalPreview>;
  /** Read-only tools are exempt from audit-log write records and can be retried freely. */
  readOnly?: boolean;
  /** Level 3 tools carry the reason they can never be automated. */
  forbiddenReason?: string;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; recoverable: boolean; hint?: string }
  | { ok: false; awaitingApproval: true; approvalId: string; error: string; recoverable: false };

/** Streamed to the client over SSE so the run is legible while it happens. */
export type AgentEvent =
  | { type: "run_started"; runId: string; objective: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; tool: string; input: unknown; autonomy: AutonomyLevel }
  | { type: "tool_end"; tool: string; ok: boolean; summary: string; durationMs: number }
  | { type: "approval_required"; approvalId: string; title: string; description: string; details: string[] }
  | { type: "text"; text: string }
  | { type: "verification"; passed: boolean; notes: string }
  | { type: "run_finished"; runId: string; status: string; result: string }
  | { type: "error"; message: string; recoverable: boolean };

export interface PlanStep {
  id: number;
  step: string;
  tool?: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  note?: string;
}

export class ForbiddenActionError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: string,
  ) {
    super(`${tool} is Level 3 (never autonomous): ${reason}`);
    this.name = "ForbiddenActionError";
  }
}

export class ApprovalRequiredError extends Error {
  constructor(
    readonly approvalId: string,
    readonly tool: string,
    readonly title: string,
  ) {
    super(`Approval required for ${tool}: ${title}`);
    this.name = "ApprovalRequiredError";
  }
}
