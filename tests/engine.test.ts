import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./db";

beforeAll(() => useTestDatabase("engine"));

const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day);

describe("release campaign engine", () => {
  it("builds a full timeline when there is enough lead time", async () => {
    const { prisma } = await import("@/server/db/client");
    const { generateCampaign } = await import("@/server/campaign/generator");

    const release = await prisma.release.create({ data: { title: "Yaka", releaseDate: iso(70), status: "scheduled" } });
    const result = await generateCampaign({
      releaseId: release.id,
      releaseDate: iso(70),
      resources: { weeklyHours: 20, monthlyBudgetEur: 300, hasArtwork: false, hasVideoCapability: true, hasLabel: false, distributorLeadDays: 21 },
    });

    expect(result.stages.map((s) => s.phase)).toEqual(["foundation", "build", "amplify", "launch", "sustain"]);
    expect(result.tasks.length).toBeGreaterThan(20);
    expect(result.compressed).toBe(false);

    // Distribution must be scheduled before release day, and the retro after it.
    const upload = result.tasks.find((t) => t.title.includes("distributor"));
    expect(upload).toBeDefined();
    expect(new Date(upload!.dueDate).getTime()).toBeLessThan(iso(70).getTime());
    const retro = result.tasks.find((t) => t.title.includes("retro"));
    expect(new Date(retro!.dueDate).getTime()).toBeGreaterThan(iso(70).getTime());
  });

  it("compresses the timeline and warns when lead time is short", async () => {
    const { prisma } = await import("@/server/db/client");
    const { generateCampaign } = await import("@/server/campaign/generator");

    const release = await prisma.release.create({ data: { title: "Rush", releaseDate: iso(10), status: "scheduled" } });
    const result = await generateCampaign({
      releaseId: release.id,
      releaseDate: iso(10),
      resources: { weeklyHours: 6, monthlyBudgetEur: 0, hasArtwork: true, hasVideoCapability: false, hasLabel: false, distributorLeadDays: 21 },
    });

    expect(result.compressed).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/lead time/i);
    // Nothing may be scheduled before today's date minus the available lead.
    for (const task of result.tasks) {
      expect(new Date(task.dueDate).getTime()).toBeGreaterThan(Date.now() - 2 * day);
    }
  });

  it("drops budget and video tasks when those resources do not exist, and says so", async () => {
    const { prisma } = await import("@/server/db/client");
    const { generateCampaign } = await import("@/server/campaign/generator");

    const release = await prisma.release.create({ data: { title: "Lean", releaseDate: iso(60), status: "scheduled" } });
    const result = await generateCampaign({
      releaseId: release.id,
      releaseDate: iso(60),
      resources: { weeklyHours: 8, monthlyBudgetEur: 0, hasArtwork: true, hasVideoCapability: false, hasLabel: false, distributorLeadDays: 21 },
    });

    const droppedReasons = result.droppedTasks.map((d) => d.reason).join(" ");
    expect(droppedReasons).toMatch(/budget/i);
    expect(droppedReasons).toMatch(/video/i);
    expect(result.tasks.some((t) => t.title.includes("paid promotion"))).toBe(false);
  });

  it("warns when the plan exceeds the artist's stated capacity", async () => {
    const { prisma } = await import("@/server/db/client");
    const { generateCampaign } = await import("@/server/campaign/generator");

    const release = await prisma.release.create({ data: { title: "Overloaded", releaseDate: iso(30), status: "scheduled" } });
    const result = await generateCampaign({
      releaseId: release.id,
      releaseDate: iso(30),
      resources: { weeklyHours: 2, monthlyBudgetEur: 100, hasArtwork: true, hasVideoCapability: true, hasLabel: false, distributorLeadDays: 21 },
    });
    expect(result.warnings.join(" ")).toMatch(/capacity/i);
  });
});

describe("proactive intelligence", () => {
  it("flags an upcoming release that has no campaign, with evidence", async () => {
    const { prisma } = await import("@/server/db/client");
    const { scanForInsights } = await import("@/server/intelligence/detectors");

    await prisma.release.create({ data: { title: "Naked Release", releaseDate: iso(20), status: "scheduled" } });
    const { insights } = await scanForInsights();
    const found = insights.find((i) => i.title.includes("Naked Release"));

    expect(found).toBeDefined();
    expect(found!.kind).toBe("missed");
    expect(found!.evidence.length).toBeGreaterThan(0);
    expect(found!.suggestedActions.length).toBeGreaterThan(0);
  });

  it("does not raise the same insight twice", async () => {
    const { scanForInsights } = await import("@/server/intelligence/detectors");
    const first = await scanForInsights();
    const second = await scanForInsights();
    expect(second.created).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(first.created);
  });

  it("flags outreach that has gone silent", async () => {
    const { prisma } = await import("@/server/db/client");
    const { scanForInsights } = await import("@/server/intelligence/detectors");

    await prisma.contact.create({
      data: { name: "Silent A&R", role: "A&R", status: "contacted", lastContactAt: iso(-40) },
    });
    const { insights } = await scanForInsights();
    expect(insights.some((i) => i.title.includes("Silent A&R"))).toBe(true);
  });
});

describe("daily priorities", () => {
  it("ranks overdue high-impact work above future low-impact work", async () => {
    const { prisma } = await import("@/server/db/client");
    const { dailyPriorities } = await import("@/server/intelligence/reviews");

    await prisma.task.deleteMany({});
    await prisma.task.create({
      data: { title: "Overdue high impact", rationale: "critical path", impact: 5, priority: 1, dueDate: iso(-5), effortMin: 60 },
    });
    await prisma.task.create({
      data: { title: "Future low impact", rationale: "nice to have", impact: 1, priority: 5, dueDate: iso(20), effortMin: 15 },
    });

    const result = await dailyPriorities(5);
    const titles = result.items.map((i) => i.title);
    expect(titles.indexOf("Overdue high impact")).toBeLessThan(titles.indexOf("Future low impact"));
    expect(result.items[0].why).toBeTruthy();
  });

  it("excludes tasks blocked by unfinished dependencies", async () => {
    const { prisma } = await import("@/server/db/client");
    const { dailyPriorities } = await import("@/server/intelligence/reviews");

    await prisma.task.deleteMany({});
    const blocker = await prisma.task.create({ data: { title: "Must happen first", rationale: "gate", status: "todo" } });
    const blocked = await prisma.task.create({ data: { title: "Depends on gate", rationale: "later", status: "todo", dueDate: iso(-1) } });
    await prisma.taskDependency.create({ data: { taskId: blocked.id, dependsOnId: blocker.id } });

    const result = await dailyPriorities(10);
    expect(result.items.map((i) => i.title)).not.toContain("Depends on gate");
    expect(result.items.map((i) => i.title)).toContain("Must happen first");
  });
});

describe("weekly review", () => {
  it("states that nothing can be concluded when nothing was measured", async () => {
    const { prisma } = await import("@/server/db/client");
    const { weeklyReview } = await import("@/server/intelligence/reviews");

    await prisma.metric.deleteMany({});
    await prisma.contentPiece.deleteMany({});
    const review = await weeklyReview(0);

    expect(review.whatWorked.join(" ")).toMatch(/not enough was measured|nothing measurable/i);
    expect(review.numbers.audienceMetrics).toMatch(/no growth claim/i);
  });
});
