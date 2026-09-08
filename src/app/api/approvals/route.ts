import { prisma } from "@/server/db/client";
import { parseObject, toJson } from "@/server/db/json";
import { authed, badRequest, readJson } from "@/server/api/helpers";
import { executeTool } from "@/server/agent/executor";
import { registerAllTools } from "@/server/tools";
import { errorMessage, log } from "@/server/logger";

export const GET = authed(async () => {
  const approvals = await prisma.approval.findMany({
    where: { status: { in: ["pending", "approved", "rejected", "executed", "failed"] } },
    orderBy: { createdAt: "desc" },
    take: 40,
    include: { run: { select: { id: true, objective: true } } },
  });

  return {
    pending: approvals.filter((a) => a.status === "pending").length,
    approvals: approvals.map((a) => ({
      id: a.id,
      tool: a.tool,
      autonomy: a.autonomy,
      title: a.title,
      description: a.description,
      details: parseObject<{ details?: string[] }>(a.previewJson, {}).details ?? [],
      riskNotes: a.riskNotes,
      status: a.status,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      objective: a.run?.objective ?? null,
      result: parseObject<Record<string, unknown>>(a.resultJson, {}),
    })),
  };
});

/**
 * Approve or reject. Approving flips the row and then executes the tool
 * immediately with the exact arguments that were approved — the executor
 * re-checks the fingerprint, so a mismatch cannot slip through.
 */
export const POST = authed(async (user, request) => {
  const body = await readJson<{ id?: string; decision?: "approve" | "reject"; note?: string }>(request);
  if (!body.id || !body.decision) badRequest("id and decision are required");

  const approval = await prisma.approval.findUnique({ where: { id: body.id } });
  if (!approval) badRequest("Approval not found");
  if (approval.status !== "pending") badRequest(`This approval is already ${approval.status}`);
  if (approval.expiresAt && approval.expiresAt < new Date()) {
    await prisma.approval.update({ where: { id: approval.id }, data: { status: "expired" } });
    badRequest("This approval has expired. Ask the agent to prepare the action again.");
  }

  if (body.decision === "reject") {
    await prisma.approval.update({
      where: { id: approval.id },
      data: { status: "rejected", decidedAt: new Date(), decidedNote: body.note, userId: user.id },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id, actor: "user", action: "approval.reject", ok: true,
        entityType: "Approval", entityId: approval.id,
        detailJson: toJson({ tool: approval.tool, note: body.note }),
      },
    });
    return { id: approval.id, status: "rejected" };
  }

  await prisma.approval.update({
    where: { id: approval.id },
    data: { status: "approved", decidedAt: new Date(), decidedNote: body.note, userId: user.id },
  });
  await prisma.auditLog.create({
    data: {
      userId: user.id, actor: "user", action: "approval.approve", ok: true,
      entityType: "Approval", entityId: approval.id,
      detailJson: toJson({ tool: approval.tool }),
    },
  });

  registerAllTools();
  const args = parseObject<{ args?: unknown }>(approval.argsJson, {}).args;

  const result = await executeTool(approval.tool, args, {
    runId: approval.runId ?? "approval-execution",
    userId: user.id,
    conversationId: null,
    emit: () => {},
    approvalId: approval.id,
  });

  const ok = result.ok;
  await prisma.approval.update({
    where: { id: approval.id },
    data: {
      status: ok ? "executed" : "failed",
      resultJson: toJson(ok ? result.data : { error: "error" in result ? result.error : "unknown" }),
    },
  });

  log.info("approval.executed", { approvalId: approval.id, tool: approval.tool, ok });
  return {
    id: approval.id,
    status: ok ? "executed" : "failed",
    result: ok ? result.data : { error: "error" in result ? result.error : errorMessage(result) },
  };
});
