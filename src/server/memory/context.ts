import { prisma } from "@/server/db/client";
import { parseList, parseObject } from "@/server/db/json";
import { memory } from "./store";
import { CRM_ACTIVE_STATUSES } from "@/server/domain/constants";

/**
 * The "CEO view": a compact, always-current snapshot of the business that is
 * injected into every agent run before it plans.
 *
 * Design rule — this must stay small (roughly 1–2k tokens). It is a map of what
 * exists, not the data itself. When the agent needs detail it calls a tool. That
 * keeps runs cheap and stops the model from answering from a stale snapshot.
 */
export interface BusinessContext {
  artist: string;
  snapshotAt: string;
  markdown: string;
}

function fmtDate(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

function daysUntil(d: Date | null | undefined): number | null {
  if (!d) return null;
  return Math.round((d.getTime() - Date.now()) / 86_400_000);
}

export async function buildBusinessContext(query?: string): Promise<BusinessContext> {
  const now = new Date();
  const in60 = new Date(now.getTime() + 60 * 86_400_000);

  const [
    artist,
    goals,
    projects,
    openTasks,
    overdueTasks,
    upcomingReleases,
    unreleased,
    crmDue,
    labelTargets,
    contentQueue,
    recentInsights,
    recentDecisions,
    pendingApprovals,
    memStats,
    integrations,
    latestMetrics,
  ] = await Promise.all([
    prisma.artistProfile.findFirst({ include: { socialAccounts: true, contentPillars: true } }),
    prisma.goal.findMany({ where: { status: "active" }, orderBy: [{ level: "asc" }, { priority: "asc" }], take: 12 }),
    prisma.project.findMany({ where: { status: { in: ["active", "planned", "blocked"] } }, orderBy: { priority: "asc" }, take: 10 }),
    prisma.task.count({ where: { status: { in: ["todo", "doing"] } } }),
    prisma.task.findMany({ where: { status: { in: ["todo", "doing", "blocked"] }, dueDate: { lt: now } }, orderBy: { dueDate: "asc" }, take: 5 }),
    prisma.release.findMany({ where: { status: { in: ["planned", "scheduled"] }, releaseDate: { lte: in60 } }, orderBy: { releaseDate: "asc" }, take: 6, include: { campaigns: { select: { id: true, status: true } } } }),
    prisma.track.findMany({ where: { status: { in: ["demo", "wip", "mixdown", "mastering", "ready", "signed"] } }, orderBy: { updatedAt: "desc" }, take: 10 }),
    prisma.contact.findMany({ where: { nextActionAt: { lte: now }, status: { in: [...CRM_ACTIVE_STATUSES] } }, orderBy: { nextActionAt: "asc" }, take: 6 }),
    prisma.label.findMany({ where: { status: { in: ["target", "contacted", "replied", "interested", "negotiating"] } }, orderBy: [{ fitScore: "desc" }], take: 6 }),
    prisma.contentPiece.findMany({ where: { status: { in: ["idea", "scripted", "ready", "scheduled"] } }, orderBy: { scheduledFor: "asc" }, take: 6 }),
    prisma.insight.findMany({ where: { status: "new" }, orderBy: [{ severity: "asc" }, { createdAt: "desc" }], take: 5 }),
    prisma.decision.findMany({ orderBy: { createdAt: "desc" }, take: 4 }),
    prisma.approval.count({ where: { status: "pending" } }),
    memory.stats(),
    prisma.integration.findMany({ where: { status: "configured" }, select: { key: true } }),
    prisma.metric.findMany({ orderBy: { periodEnd: "desc" }, take: 8 }),
  ]);

  const semantic = query ? await memory.recall(query, { limit: 6 }) : [];

  const lines: string[] = [];
  lines.push(`# Business snapshot — ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`);

  if (!artist) {
    lines.push(
      "",
      "**No artist profile exists yet.** This is a cold start: the operator has not filled in",
      "identity, genres, goals or resources. Ask for what you need, or use `artist_profile_update`",
      "to record what they tell you. Do not invent profile facts.",
    );
  } else {
    const genres = parseList(artist.genresJson);
    const sound = parseList(artist.soundJson);
    const resources = parseObject<Record<string, unknown>>(artist.resourcesJson, {});
    lines.push(
      "",
      "## Artist",
      `- Name: **${artist.artistName}**${artist.tagline ? ` — ${artist.tagline}` : ""}`,
      `- Genres: ${genres.join(", ") || "not set"}${sound.length ? ` | Sound: ${sound.join(", ")}` : ""}`,
      `- Base: ${[artist.homeCity, artist.country].filter(Boolean).join(", ") || "not set"}`,
      `- Positioning: ${artist.positioning ?? "not set"}`,
      `- Capacity: ${artist.weeklyHours ? `${artist.weeklyHours} h/week` : "unknown"} | Budget: ${
        artist.monthlyBudgetEur != null ? `€${artist.monthlyBudgetEur}/month` : "unknown"
      }`,
    );
    if (Object.keys(resources).length) lines.push(`- Resources: ${JSON.stringify(resources)}`);
    if (artist.socialAccounts.length) {
      lines.push(
        `- Accounts: ${artist.socialAccounts
          .map((a) => `${a.platform}@${a.handle}${a.followers ? ` (${a.followers})` : ""}${a.monthlyListeners ? ` (${a.monthlyListeners} ML)` : ""}`)
          .join(", ")}`,
      );
    }
    if (artist.contentPillars.length) {
      lines.push(`- Content pillars: ${artist.contentPillars.map((p) => `${p.name} ${p.sharePct}%`).join(", ")}`);
    }
  }

  if (goals.length) {
    lines.push("", "## Active goals");
    for (const g of goals) {
      const progress =
        g.targetValue != null
          ? ` [${g.currentValue ?? 0}/${g.targetValue}${g.unit ? ` ${g.unit}` : ""}]`
          : "";
      lines.push(`- (${g.level}) ${g.title}${progress}${g.dueDate ? ` — due ${fmtDate(g.dueDate)}` : ""} \`${g.id}\``);
    }
  } else {
    lines.push("", "## Active goals", "- none set — the goal hierarchy is empty");
  }

  lines.push("", "## Work in flight", `- Open tasks: ${openTasks}${overdueTasks.length ? `, **${overdueTasks.length} overdue**` : ""}`);
  for (const p of projects) lines.push(`- Project: ${p.name} (${p.status}, P${p.priority}) \`${p.id}\``);
  for (const t of overdueTasks) lines.push(`  - OVERDUE: ${t.title} (due ${fmtDate(t.dueDate)}) \`${t.id}\``);

  lines.push("", "## Music");
  if (upcomingReleases.length) {
    for (const r of upcomingReleases) {
      const d = daysUntil(r.releaseDate);
      lines.push(
        `- Release: **${r.title}** ${fmtDate(r.releaseDate)}${d != null ? ` (${d}d)` : ""} — ${r.status}, label ${
          r.labelName ?? "unsigned"
        }, campaign ${r.campaigns.length ? r.campaigns[0].status : "**none**"} \`${r.id}\``,
      );
    }
  } else {
    lines.push("- No releases scheduled in the next 60 days");
  }
  for (const t of unreleased.slice(0, 6)) {
    lines.push(`- Track: ${t.title} (${t.status}${t.bpm ? `, ${t.bpm}bpm` : ""}${t.musicalKey ? ` ${t.musicalKey}` : ""}) \`${t.id}\``);
  }

  if (crmDue.length || labelTargets.length) {
    lines.push("", "## Relationships needing action");
    for (const c of crmDue) lines.push(`- ${c.name}${c.company ? ` (${c.company})` : ""} — ${c.status}, next: ${c.nextAction ?? "follow up"} \`${c.id}\``);
    for (const l of labelTargets) lines.push(`- Label ${l.name} — ${l.status}${l.fitScore != null ? `, fit ${Math.round(l.fitScore)}` : ""} \`${l.id}\``);
  }

  if (contentQueue.length) {
    lines.push("", "## Content queue");
    for (const c of contentQueue) lines.push(`- ${c.platform}/${c.format}: ${c.title} (${c.status}${c.scheduledFor ? `, ${fmtDate(c.scheduledFor)}` : ""}) \`${c.id}\``);
  }

  if (latestMetrics.length) {
    lines.push("", "## Latest measured metrics");
    for (const m of latestMetrics) lines.push(`- ${m.platform}.${m.metric} = ${m.value} (as of ${fmtDate(m.periodEnd)}, source ${m.source})`);
  }

  if (recentInsights.length) {
    lines.push("", "## Unreviewed insights");
    for (const i of recentInsights) lines.push(`- [${i.kind}/S${i.severity}] ${i.title} \`${i.id}\``);
  }

  if (recentDecisions.length) {
    lines.push("", "## Recent decisions");
    for (const d of recentDecisions) lines.push(`- ${d.question} → ${d.chosenOption ?? d.recommendation} (${fmtDate(d.decidedAt ?? d.createdAt)})`);
  }

  if (semantic.length) {
    lines.push("", "## Relevant memories");
    for (const m of semantic) {
      lines.push(`- [${m.kind}, conf ${m.confidence.toFixed(2)}] ${m.title}: ${m.content.slice(0, 240)}`);
    }
  }

  lines.push(
    "",
    "## System state",
    `- Pending approvals: ${pendingApprovals}`,
    `- Memories stored: ${memStats.total}`,
    `- Connected integrations: ${integrations.length ? integrations.map((i) => i.key).join(", ") : "**none** — no live platform data is available; any number you report must come from a tool or the operator"}`,
  );

  return {
    artist: artist?.artistName ?? "unknown",
    snapshotAt: now.toISOString(),
    markdown: lines.join("\n"),
  };
}
