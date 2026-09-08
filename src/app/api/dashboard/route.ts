import { prisma } from "@/server/db/client";
import { authed } from "@/server/api/helpers";
import { dailyPriorities } from "@/server/intelligence/reviews";
import { parseArray, parseList } from "@/server/db/json";
import { agentConfigured, researchConfigured } from "@/server/env";

/** Everything the TODAY panel needs, in one round trip. */
export const GET = authed(async () => {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);

  const [priorities, artist, insights, approvals, releases, goals, openTasks, overdue, integrations] = await Promise.all([
    dailyPriorities(8),
    prisma.artistProfile.findFirst({ include: { socialAccounts: true } }),
    prisma.insight.findMany({ where: { status: "new" }, orderBy: [{ severity: "asc" }], take: 6 }),
    prisma.approval.count({ where: { status: "pending" } }),
    prisma.release.findMany({
      where: { status: { in: ["planned", "scheduled"] }, releaseDate: { lte: in30 } },
      orderBy: { releaseDate: "asc" },
      include: { campaigns: { select: { id: true, status: true } } },
      take: 5,
    }),
    prisma.goal.findMany({ where: { status: "active" }, orderBy: [{ level: "asc" }, { priority: "asc" }], take: 6 }),
    prisma.task.count({ where: { status: { in: ["todo", "doing"] } } }),
    prisma.task.count({ where: { status: { in: ["todo", "doing", "blocked"] }, dueDate: { lt: now } } }),
    prisma.integration.findMany({ select: { key: true, name: true, status: true } }),
  ]);

  return {
    artist: artist
      ? {
          name: artist.artistName,
          tagline: artist.tagline,
          genres: parseList(artist.genresJson),
          accounts: artist.socialAccounts.map((a) => ({ platform: a.platform, handle: a.handle, followers: a.followers, monthlyListeners: a.monthlyListeners })),
          weeklyHours: artist.weeklyHours,
          monthlyBudgetEur: artist.monthlyBudgetEur,
        }
      : null,
    priorities,
    insights: insights.map((i) => ({
      id: i.id, kind: i.kind, area: i.area, title: i.title, body: i.body,
      severity: i.severity, confidence: i.confidence,
      evidence: parseArray(i.evidenceJson),
      actions: parseArray<string>(i.suggestedActionsJson),
    })),
    counters: { pendingApprovals: approvals, openTasks, overdueTasks: overdue },
    releases: releases.map((r) => ({
      id: r.id, title: r.title,
      releaseDate: r.releaseDate?.toISOString().slice(0, 10) ?? null,
      daysAway: r.releaseDate ? Math.round((r.releaseDate.getTime() - now.getTime()) / 86_400_000) : null,
      status: r.status,
      hasCampaign: r.campaigns.length > 0,
    })),
    goals: goals.map((g) => ({
      id: g.id, level: g.level, title: g.title,
      current: g.currentValue, target: g.targetValue, unit: g.unit,
      pct: g.targetValue ? Math.round(((g.currentValue ?? 0) / g.targetValue) * 100) : null,
      dueDate: g.dueDate?.toISOString().slice(0, 10) ?? null,
    })),
    system: {
      agentConfigured: agentConfigured(),
      researchConfigured: researchConfigured(),
      integrations,
    },
  };
});
