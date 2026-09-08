import { prisma } from "@/server/db/client";
import { authed, badRequest } from "@/server/api/helpers";
import { parseArray, parseList, parseObject } from "@/server/db/json";
import { weeklyReview } from "@/server/intelligence/reviews";
import { listWorkspace } from "@/server/files/workspace";
import { memory } from "@/server/memory/store";

const day = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

/**
 * One read endpoint per panel, dispatched by `?panel=`.
 *
 * Panels are read-only views: everything that changes data goes through the
 * agent or an approval, so there is exactly one write path to audit.
 */
export const GET = authed(async (_user, request) => {
  const panel = new URL(request.url).searchParams.get("panel") ?? "projects";

  switch (panel) {
    case "projects": {
      const [projects, tasks] = await Promise.all([
        prisma.project.findMany({
          where: { status: { in: ["planned", "active", "blocked"] } },
          orderBy: [{ priority: "asc" }],
          include: { tasks: { select: { status: true } }, goal: { select: { title: true, level: true } } },
        }),
        prisma.task.findMany({
          where: { status: { in: ["todo", "doing", "blocked"] } },
          orderBy: [{ dueDate: "asc" }, { priority: "asc" }],
          take: 60,
          include: { project: { select: { name: true } } },
        }),
      ]);
      return {
        projects: projects.map((p) => ({
          id: p.id, name: p.name, type: p.type, status: p.status, priority: p.priority,
          dueDate: day(p.dueDate), goal: p.goal?.title ?? null,
          done: p.tasks.filter((t) => t.status === "done").length, total: p.tasks.length,
        })),
        tasks: tasks.map((t) => ({
          id: t.id, title: t.title, status: t.status, priority: t.priority, impact: t.impact,
          dueDate: day(t.dueDate), project: t.project?.name ?? null, rationale: t.rationale,
          overdue: Boolean(t.dueDate && t.dueDate < new Date()),
        })),
      };
    }

    case "releases": {
      const [releases, tracks] = await Promise.all([
        prisma.release.findMany({
          orderBy: { releaseDate: "desc" }, take: 30,
          include: { campaigns: { select: { id: true, status: true } }, supports: true, placements: true, label: { select: { name: true } } },
        }),
        prisma.track.findMany({ orderBy: { updatedAt: "desc" }, take: 40 }),
      ]);
      return {
        releases: releases.map((r) => ({
          id: r.id, title: r.title, type: r.type, status: r.status, releaseDate: day(r.releaseDate),
          label: r.label?.name ?? r.labelName ?? "self-released",
          links: parseObject<Record<string, string>>(r.linksJson, {}),
          campaign: r.campaigns[0] ?? null,
          djSupports: r.supports.length, playlists: r.placements.length,
        })),
        tracks: tracks.map((t) => ({
          id: t.id, title: t.title, status: t.status, genre: t.genre, bpm: t.bpm, key: t.musicalKey,
          collaborators: parseList(t.collaboratorsJson), deadline: day(t.deadline), notes: t.notes,
        })),
      };
    }

    case "contacts": {
      const [contacts, labels, outreach] = await Promise.all([
        prisma.contact.findMany({ orderBy: [{ priority: "asc" }, { nextActionAt: "asc" }], take: 80, include: { label: { select: { name: true } } } }),
        prisma.label.findMany({ orderBy: [{ fitScore: "desc" }], take: 60 }),
        prisma.outreach.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
      ]);
      return {
        contacts: contacts.map((c) => ({
          id: c.id, name: c.name, role: c.role, company: c.company ?? c.label?.name ?? null,
          status: c.status, relationship: c.relationship, priority: c.priority,
          lastContactAt: day(c.lastContactAt), nextAction: c.nextAction, nextActionAt: day(c.nextActionAt),
          email: c.email, instagram: c.instagram,
          due: Boolean(c.nextActionAt && c.nextActionAt <= new Date()),
        })),
        labels: labels.map((l) => ({
          id: l.id, name: l.name, tier: l.tier, status: l.status, fitScore: l.fitScore,
          fitRationale: l.fitRationale, genres: parseList(l.genresJson),
          submission: { method: l.submissionMethod, email: l.submissionEmail, url: l.submissionUrl },
          lastContactAt: day(l.lastContactAt),
        })),
        outreach: outreach.map((o) => ({
          id: o.id, target: o.targetName, purpose: o.purpose, channel: o.channel,
          status: o.status, subject: o.subject, body: o.body, sentAt: day(o.sentAt),
        })),
      };
    }

    case "content": {
      const [pieces, pillars] = await Promise.all([
        prisma.contentPiece.findMany({ orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }], take: 60, include: { performance: true, pillar: { select: { name: true } } } }),
        prisma.contentPillar.findMany(),
      ]);
      return {
        pillars: pillars.map((p) => ({ id: p.id, name: p.name, sharePct: p.sharePct, description: p.description })),
        pieces: pieces.map((c) => ({
          id: c.id, title: c.title, platform: c.platform, format: c.format, status: c.status,
          pillar: c.pillar?.name ?? null, hook: c.hook, caption: c.caption, cta: c.cta,
          scheduledFor: day(c.scheduledFor), publishedAt: day(c.publishedAt), url: c.url,
          performance: c.performance ? { views: c.performance.views, likes: c.performance.likes, saves: c.performance.saves, followersGained: c.performance.followersGained } : null,
        })),
      };
    }

    case "finance": {
      const since = new Date(Date.now() - 365 * 86_400_000);
      const entries = await prisma.financeEntry.findMany({ where: { occurredAt: { gte: since } }, orderBy: { occurredAt: "desc" } });
      const income = entries.filter((e) => e.direction === "income");
      const expense = entries.filter((e) => e.direction === "expense");
      const sum = (rows: typeof entries) => Number(rows.reduce((s, e) => s + e.amountEur, 0).toFixed(2));
      const byMonth = new Map<string, { income: number; expense: number }>();
      for (const e of entries) {
        const key = e.occurredAt.toISOString().slice(0, 7);
        const cur = byMonth.get(key) ?? { income: 0, expense: 0 };
        cur[e.direction as "income" | "expense"] += e.amountEur;
        byMonth.set(key, cur);
      }
      return {
        totals: { income: sum(income), expense: sum(expense), profit: Number((sum(income) - sum(expense)).toFixed(2)) },
        byMonth: [...byMonth.entries()].sort().map(([month, v]) => ({ month, income: Number(v.income.toFixed(2)), expense: Number(v.expense.toFixed(2)) })),
        entries: entries.slice(0, 60).map((e) => ({
          id: e.id, direction: e.direction, category: e.category, amountEur: e.amountEur,
          description: e.description, vendor: e.vendor, occurredAt: day(e.occurredAt),
        })),
      };
    }

    case "analytics": {
      const [metrics, content] = await Promise.all([
        prisma.metric.findMany({ orderBy: { periodEnd: "desc" }, take: 200 }),
        prisma.contentPiece.findMany({ where: { performance: { isNot: null } }, include: { performance: true }, take: 40, orderBy: { publishedAt: "desc" } }),
      ]);
      const series = new Map<string, { at: string; value: number }[]>();
      for (const m of [...metrics].reverse()) {
        const key = `${m.platform}.${m.metric}`;
        const arr = series.get(key) ?? [];
        arr.push({ at: day(m.periodEnd)!, value: m.value });
        series.set(key, arr);
      }
      return {
        series: [...series.entries()].map(([key, points]) => ({ key, points })),
        content: content.map((c) => ({ id: c.id, title: c.title, platform: c.platform, format: c.format, views: c.performance?.views ?? 0, publishedAt: day(c.publishedAt) })),
        note: metrics.length === 0 ? "No metrics recorded yet. Numbers here only ever come from you or a connected integration — nothing is estimated." : null,
      };
    }

    case "strategy": {
      const [goals, decisions, review, experiments] = await Promise.all([
        prisma.goal.findMany({ orderBy: [{ level: "asc" }, { priority: "asc" }] }),
        prisma.decision.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
        prisma.review.findFirst({ where: { type: "weekly" }, orderBy: { createdAt: "desc" } }),
        prisma.experiment.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      ]);
      return {
        goals: goals.map((g) => ({
          id: g.id, level: g.level, title: g.title, parentId: g.parentId, status: g.status,
          current: g.currentValue, target: g.targetValue, unit: g.unit, dueDate: day(g.dueDate),
        })),
        decisions: decisions.map((d) => ({
          id: d.id, question: d.question, recommendation: d.recommendation, reasoning: d.reasoning,
          uncertainty: d.uncertainty, confidence: d.confidence, options: parseArray(d.optionsJson),
          chosen: d.chosenOption, at: day(d.createdAt),
        })),
        experiments: experiments.map((e) => ({ id: e.id, hypothesis: e.hypothesis, area: e.area, metric: e.metric, baseline: e.baseline, result: e.result, status: e.status, conclusion: e.conclusion })),
        latestReview: review ? { id: review.id, period: `${day(review.periodStart)} → ${day(review.periodEnd)}`, markdown: review.markdown } : null,
      };
    }

    case "memory": {
      const [items, stats, runs] = await Promise.all([
        prisma.memoryItem.findMany({ where: { isArchived: false }, orderBy: { updatedAt: "desc" }, take: 80 }),
        memory.stats(),
        prisma.agentRun.findMany({ orderBy: { startedAt: "desc" }, take: 15, select: { id: true, objective: true, status: true, startedAt: true, costUsd: true, inputTokens: true, outputTokens: true } }),
      ]);
      return {
        stats,
        items: items.map((m) => ({
          id: m.id, layer: m.layer, kind: m.kind, title: m.title, content: m.content,
          confidence: m.confidence, source: m.source, sourceUrl: m.sourceUrl,
          tags: parseList(m.tagsJson), useCount: m.useCount, at: day(m.createdAt),
        })),
        runs: runs.map((r) => ({ id: r.id, objective: r.objective, status: r.status, at: r.startedAt, costUsd: Number(r.costUsd.toFixed(4)), tokens: r.inputTokens + r.outputTokens })),
      };
    }

    case "music": {
      const [analyses, files] = await Promise.all([
        prisma.audioAnalysis.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { track: { select: { title: true } } } }),
        listWorkspace("Music", true).catch(() => []),
      ]);
      return {
        analyses: analyses.map((a) => ({
          id: a.id, track: a.track?.title ?? a.filePath, file: a.filePath, at: day(a.createdAt),
          lufs: a.lufsIntegrated, truePeak: a.truePeakDb, crest: a.crestFactorDb,
          phase: a.phaseCorrelation, lowEndWidth: a.lowEndWidth,
          issues: parseArray<{ severity: string; message: string; suggestion: string }>(a.issuesJson),
          summary: a.summary,
        })),
        files: files.filter((f) => !f.isDirectory).map((f) => ({ path: f.path, sizeKb: Math.round(f.sizeBytes / 1024), modified: f.modifiedAt.slice(0, 10) })),
      };
    }

    case "review": {
      const review = await weeklyReview(0);
      return { review };
    }

    default:
      badRequest(`Unknown panel "${panel}"`);
  }
});
