import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./db";
import { z } from "zod";

// A fresh database per run so assertions about counts are deterministic.
beforeAll(() => useTestDatabase("autonomy"));

const load = async () => {
  const { prisma } = await import("@/server/db/client");
  const { executeTool, argsFingerprint } = await import("@/server/agent/executor");
  const { registerTools, getTool, anthropicToolSpecs, defineTool } = await import("@/server/agent/registry");
  const { registerAllTools } = await import("@/server/tools");
  return { prisma, executeTool, argsFingerprint, registerTools, getTool, anthropicToolSpecs, defineTool, registerAllTools };
};

const ctx = (runId = "test-run") => ({
  runId,
  userId: null,
  conversationId: null,
  emit: () => {},
});

describe("autonomy enforcement", () => {
  it("never exposes Level 3 tools to the model", async () => {
    const { registerAllTools, anthropicToolSpecs } = await load();
    const all = registerAllTools();
    const exposed = anthropicToolSpecs().map((t) => t.name);
    const level3 = all.filter((t) => t.autonomy === "level3");

    expect(level3.length).toBeGreaterThan(0);
    for (const tool of level3) expect(exposed).not.toContain(tool.name);
  });

  it("refuses to execute a Level 3 tool even when called directly", async () => {
    const { registerAllTools, executeTool } = await load();
    registerAllTools();
    const result = await executeTool("money_transfer", { amountEur: 100, recipient: "x", purpose: "y" }, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Level 3/);
      expect(result.recoverable).toBe(false);
    }
  });

  it("creates an approval instead of running a Level 2 tool", async () => {
    const { registerAllTools, executeTool, prisma } = await load();
    registerAllTools();

    const draft = await prisma.outreach.create({
      data: { targetName: "Test Label", channel: "email", purpose: "demo_submission", body: "Hello, here is a track.", status: "draft" },
    });

    const before = await prisma.outreach.findUnique({ where: { id: draft.id } });
    const result = await executeTool("outreach_send", { outreachId: draft.id, confirmChannel: "email" }, ctx());
    const after = await prisma.outreach.findUnique({ where: { id: draft.id } });

    expect(result.ok).toBe(false);
    expect("awaitingApproval" in result && result.awaitingApproval).toBe(true);
    // The critical assertion: nothing about the draft changed.
    expect(after?.status).toBe(before?.status);
    expect(after?.sentAt).toBeNull();

    const approval = await prisma.approval.findFirst({ where: { tool: "outreach_send" }, orderBy: { createdAt: "desc" } });
    expect(approval?.status).toBe("pending");
    expect(approval?.title).toContain("Test Label");
  });

  it("binds an approval to the exact arguments approved", async () => {
    const { argsFingerprint } = await load();
    const a = argsFingerprint("outreach_send", { outreachId: "abc", confirmChannel: "email" });
    const b = argsFingerprint("outreach_send", { confirmChannel: "email", outreachId: "abc" });
    const c = argsFingerprint("outreach_send", { outreachId: "different", confirmChannel: "email" });

    // Key order must not matter; values must.
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("runs a Level 2 tool once a matching approval exists", async () => {
    const { registerAllTools, executeTool, prisma, argsFingerprint } = await load();
    registerAllTools();

    const draft = await prisma.outreach.create({
      data: { targetName: "Approved Label", channel: "email", purpose: "demo_submission", body: "Second draft.", status: "draft" },
    });
    const args = { outreachId: draft.id, confirmChannel: "email" as const };

    await prisma.approval.create({
      data: {
        tool: "outreach_send",
        autonomy: "level2",
        title: "Send", description: "Send",
        argsJson: JSON.stringify({ fingerprint: argsFingerprint("outreach_send", args), args }),
        status: "approved",
        decidedAt: new Date(),
      },
    });

    const result = await executeTool("outreach_send", args, ctx());
    expect(result.ok).toBe(true);
    // No email integration is configured, so it must report that honestly
    // rather than claiming a send.
    if (result.ok) {
      const data = result.data as { sent: boolean; status?: string };
      expect(data.sent).toBe(false);
      expect(data.status).toBe("approved_awaiting_manual_send");
    }
  });

  it("rejects malformed arguments before any autonomy check", async () => {
    const { registerAllTools, executeTool } = await load();
    registerAllTools();
    const result = await executeTool("task_create", { title: "x" }, ctx()); // missing rationale, title too short

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid arguments/);
      expect(result.recoverable).toBe(true);
    }
  });

  it("returns a recoverable error for an unknown tool", async () => {
    const { registerAllTools, executeTool } = await load();
    registerAllTools();
    const result = await executeTool("definitely_not_a_tool", {}, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).toBe(true);
  });

  it("refuses to register a Level 2 tool without an approval preview", async () => {
    const { registerTools, defineTool } = await load();
    expect(() =>
      registerTools([
        defineTool({
          name: "unsafe_tool_without_preview",
          group: "system",
          autonomy: "level2",
          description: "test",
          schema: z.object({}),
          execute: async () => ({}),
        }),
      ]),
    ).toThrowError(/preview/);
  });

  it("writes an audit record for every executed tool", async () => {
    const { registerAllTools, executeTool, prisma } = await load();
    registerAllTools();
    const before = await prisma.auditLog.count({ where: { action: "tool.execute" } });
    await executeTool("goal_create", { level: "annual", title: "Audit trail check" }, ctx());
    const after = await prisma.auditLog.count({ where: { action: "tool.execute" } });
    expect(after).toBeGreaterThan(before);
  });
});

describe("workspace containment", () => {
  it("refuses paths that escape the workspace", async () => {
    const { resolveInWorkspace } = await import("@/server/files/workspace");
    expect(() => resolveInWorkspace("../../etc/passwd")).toThrowError(/outside/);
    expect(() => resolveInWorkspace("Music/../../../root/.ssh/id_rsa")).toThrowError(/outside/);
    expect(() => resolveInWorkspace("/etc/passwd")).not.toThrow(); // leading slash is stripped, not escaped
    expect(resolveInWorkspace("Music/Masters/track.wav")).toMatch(/Music\/Masters\/track\.wav$/);
  });
});

describe("research fetch safety", () => {
  it("refuses private and loopback addresses", async () => {
    const { fetchPage } = await import("@/server/research/fetch");
    await expect(fetchPage("http://localhost:3000/admin")).rejects.toThrow(/private or loopback/);
    await expect(fetchPage("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private or loopback/);
    await expect(fetchPage("http://192.168.1.1/")).rejects.toThrow(/private or loopback/);
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow();
  });
});
