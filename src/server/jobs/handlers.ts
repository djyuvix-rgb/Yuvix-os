import { prisma } from "@/server/db/client";
import { registerJobHandler, enqueue } from "./queue";
import { scanForInsights } from "@/server/intelligence/detectors";
import { runWeeklyReview } from "@/server/intelligence/reviews";
import { runAgent } from "@/server/agent/loop";
import { registerAllTools } from "@/server/tools";
import { log } from "@/server/logger";

let installed = false;

/** Wires the job handlers. Idempotent for dev-mode module reloads. */
export function installJobHandlers() {
  if (installed) return;
  registerAllTools();

  registerJobHandler("insights.scan", async () => {
    const { created, skipped } = await scanForInsights();
    return { created, alreadyKnown: skipped };
  });

  registerJobHandler("review.weekly", async () => {
    const { id, review } = await runWeeklyReview();
    return { reviewId: id, period: `${review.periodStart}..${review.periodEnd}` };
  });

  /**
   * A full agent run in the background — used for anything that would time out
   * a request, such as a deep research pass across many labels.
   */
  registerJobHandler("agent.run", async (payload) => {
    const objective = String(payload.objective ?? "");
    if (!objective) throw new Error("agent.run requires an objective");
    const result = await runAgent({
      objective,
      userId: (payload.userId as string) ?? null,
      conversationId: (payload.conversationId as string) ?? null,
      trigger: "job",
      lightweight: payload.lightweight === true,
    });
    return { runId: result.runId, status: result.status, steps: result.steps };
  });

  /** Expires stale approvals so the inbox reflects what is genuinely pending. */
  registerJobHandler("approvals.expire", async () => {
    const { count } = await prisma.approval.updateMany({
      where: { status: "pending", expiresAt: { lt: new Date() } },
      data: { status: "expired" },
    });
    return { expired: count };
  });

  installed = true;
  log.info("jobs.handlers.installed");
}

/**
 * Recurring work. Each tick re-queues the next occurrence only if one is not
 * already pending, so restarts cannot pile up duplicates.
 */
export async function ensureRecurringJobs() {
  const schedule: { name: string; everyHours: number }[] = [
    { name: "insights.scan", everyHours: 12 },
    { name: "review.weekly", everyHours: 24 * 7 },
    { name: "approvals.expire", everyHours: 24 },
  ];

  for (const { name, everyHours } of schedule) {
    const pending = await prisma.job.findFirst({ where: { name, status: { in: ["queued", "running"] } } });
    if (pending) continue;
    const last = await prisma.job.findFirst({ where: { name, status: "completed" }, orderBy: { finishedAt: "desc" } });
    const due = last?.finishedAt ? new Date(last.finishedAt.getTime() + everyHours * 3_600_000) : new Date();
    await enqueue(name, {}, { runAfter: due, priority: 4 });
  }
}
