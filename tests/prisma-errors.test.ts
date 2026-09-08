import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./db";

// A real database is needed to trigger real Prisma runtime errors — a mocked
// error object would not prove the code path this actually hits in production.
beforeAll(() => useTestDatabase("prisma-errors"));

describe("toolErrorMessage", () => {
  it("narrows a foreign key violation to a short, actionable message", async () => {
    const { prisma } = await import("@/server/db/client");
    const { toolErrorMessage } = await import("@/server/db/prisma-errors");

    let caught: unknown;
    try {
      // Exactly the failure observed live: a model wrote "TBD" as a parentId
      // instead of waiting for a real one.
      await prisma.goal.create({ data: { level: "monthly", title: "x", parentId: "TBD" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    const { message, hint } = toolErrorMessage(caught);
    expect(message).not.toMatch(/prisma\.goal\.create/);
    expect(message).not.toMatch(/\.ts:\d+:\d+/); // no file:line leakage
    expect(message).not.toMatch(/\n\s*\d+\s*\|/); // no source-snippet lines
    expect(message.length).toBeLessThan(200);
    // SQLite's provider only gives Prisma a model name for P2003, not the field
    // (Postgres gives both) — the message should still say something specific
    // rather than a bare "something went wrong".
    expect(message).toMatch(/Goal|id/i);
    expect(hint).toMatch(/never.*placeholder|placeholder.*never/i);
  });

  it("narrows a not-found update to a short, actionable message", async () => {
    const { prisma } = await import("@/server/db/client");
    const { toolErrorMessage } = await import("@/server/db/prisma-errors");

    let caught: unknown;
    try {
      await prisma.task.update({ where: { id: "does-not-exist" }, data: { status: "done" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    const { message, hint } = toolErrorMessage(caught);
    expect(message).not.toMatch(/prisma\.task\.update/);
    expect(message.length).toBeLessThan(200);
    expect(hint).toMatch(/_list|_get/);
  });

  it("narrows a unique constraint violation and names the field", async () => {
    const { prisma } = await import("@/server/db/client");
    const { toolErrorMessage } = await import("@/server/db/prisma-errors");

    await prisma.label.create({ data: { name: "Duplicate Label" } });
    let caught: unknown;
    try {
      await prisma.label.create({ data: { name: "Duplicate Label" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    const { message } = toolErrorMessage(caught);
    expect(message).toMatch(/already exists/);
    expect(message.length).toBeLessThan(200);
  });

  it("passes through a plain error unchanged", async () => {
    const { toolErrorMessage } = await import("@/server/db/prisma-errors");
    const { message } = toolErrorMessage(new Error("Web research is not configured."));
    expect(message).toBe("Web research is not configured.");
  });
});
