import { prisma } from "@/server/db/client";
import { toJson } from "@/server/db/json";
import { log } from "@/server/logger";

/**
 * Proactive intelligence.
 *
 * Every detector is a deterministic rule over data the system actually holds.
 * That is the point: an insight must be able to name its evidence. A rule that
 * would need data we do not have (live Spotify numbers, ad spend from a platform
 * we are not connected to) does not exist here — the system says it cannot see
 * that instead of implying it is watching.
 */

export interface Evidence {
  type: "count" | "date" | "metric" | "money" | "ref";
  label: string;
  value: string | number;
  ref?: string;
}

export interface DetectedInsight {
  kind: "opportunity" | "risk" | "bottleneck" | "missed" | "inefficiency" | "recommendation";
  area: "content" | "release" | "growth" | "outreach" | "finance" | "production" | "brand";
  title: string;
  body: string;
  evidence: Evidence[];
  confidence: number;
  severity: number; // 1 = most severe
  suggestedActions: string[];
  detector: string;
  dedupeKey: string;
  expiresInDays?: number;
}

type Detector = () => Promise<DetectedInsight[]>;

const DAY = 86_400_000;
const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "unknown");

/** Upcoming release with no campaign — the single most expensive omission. */
const releaseWithoutCampaign: Detector = async () => {
  const releases = await prisma.release.findMany({
    where: { status: { in: ["planned", "scheduled"] }, releaseDate: { gte: new Date(), lte: new Date(Date.now() + 90 * DAY) } },
    include: { campaigns: true },
  });
  return releases
    .filter((r) => r.campaigns.length === 0)
    .map((r) => {
      const days = Math.round(((r.releaseDate?.getTime() ?? 0) - Date.now()) / DAY);
      return {
        kind: "missed" as const,
        area: "release" as const,
        title: `"${r.title}" releases in ${days} days with no campaign`,
        body:
          `${r.title} is scheduled for ${fmt(r.releaseDate)} and has no campaign, so there is no pre-save, no DJ promo, no playlist pitch and no content plan attached to it. ` +
          (days < 28
            ? "Editorial playlist pitching needs roughly four weeks, so that window is already closing."
            : "There is still enough lead time to run the full campaign."),
        evidence: [
          { type: "date", label: "Release date", value: fmt(r.releaseDate), ref: r.id },
          { type: "count", label: "Campaigns attached", value: 0, ref: r.id },
          { type: "count", label: "Days remaining", value: days },
        ],
        confidence: 0.95,
        severity: days < 28 ? 1 : 2,
        suggestedActions: [`Generate the campaign for "${r.title}"`, "Confirm the distributor delivery date first — it gates everything else"],
        detector: "release_without_campaign",
        dedupeKey: `release_without_campaign:${r.id}`,
        expiresInDays: Math.max(1, days),
      };
    });
};

/** Contacted and then dropped — the most common silent loss in independent music. */
const staleOutreach: Detector = async () => {
  const cutoff = new Date(Date.now() - 21 * DAY);
  const [contacts, labels] = await Promise.all([
    prisma.contact.findMany({
      where: { status: { in: ["contacted", "replied", "interested", "negotiating"] }, lastContactAt: { lte: cutoff } },
      orderBy: { lastContactAt: "asc" },
      take: 12,
    }),
    prisma.label.findMany({
      where: { status: { in: ["contacted", "replied", "interested", "negotiating"] }, lastContactAt: { lte: cutoff } },
      take: 12,
    }),
  ]);

  const out: DetectedInsight[] = [];
  for (const c of contacts) {
    const days = Math.round((Date.now() - (c.lastContactAt?.getTime() ?? Date.now())) / DAY);
    out.push({
      kind: "missed",
      area: "outreach",
      title: `${c.name} has been waiting ${days} days with no follow-up`,
      body: `${c.name}${c.company ? ` at ${c.company}` : ""} is still marked "${c.status}" but was last contacted on ${fmt(c.lastContactAt)}. Conversations at this stage go cold without one follow-up.`,
      evidence: [
        { type: "date", label: "Last contact", value: fmt(c.lastContactAt), ref: c.id },
        { type: "ref", label: "Pipeline status", value: c.status, ref: c.id },
      ],
      confidence: 0.8,
      severity: 3,
      suggestedActions: [`Draft one short, specific follow-up to ${c.name}`, "If two follow-ups have gone unanswered, move them to inactive instead of chasing"],
      detector: "stale_outreach",
      dedupeKey: `stale_outreach:contact:${c.id}:${Math.floor(days / 14)}`,
      expiresInDays: 14,
    });
  }
  for (const l of labels) {
    const days = Math.round((Date.now() - (l.lastContactAt?.getTime() ?? Date.now())) / DAY);
    out.push({
      kind: "missed",
      area: "outreach",
      title: `${l.name} submission has had no follow-up in ${days} days`,
      body: `${l.name} is at status "${l.status}" since ${fmt(l.lastContactAt)}. Labels routinely lose demos in an inbox; a single polite follow-up is normal and expected.`,
      evidence: [
        { type: "date", label: "Last contact", value: fmt(l.lastContactAt), ref: l.id },
        { type: "ref", label: "Status", value: l.status, ref: l.id },
      ],
      confidence: 0.75,
      severity: 3,
      suggestedActions: [`Follow up with ${l.name} once`, "Check their stated response time before chasing again"],
      detector: "stale_outreach",
      dedupeKey: `stale_outreach:label:${l.id}:${Math.floor(days / 14)}`,
      expiresInDays: 14,
    });
  }
  return out;
};

/** Which content format actually earns attention — with an honest sample-size bar. */
const contentFormatSignal: Detector = async () => {
  const since = new Date(Date.now() - 90 * DAY);
  const pieces = await prisma.contentPiece.findMany({
    where: { publishedAt: { gte: since }, performance: { isNot: null } },
    include: { performance: true },
  });
  if (pieces.length < 8) return [];

  const groups = new Map<string, { n: number; views: number }>();
  for (const p of pieces) {
    const key = `${p.platform}/${p.format}`;
    const cur = groups.get(key) ?? { n: 0, views: 0 };
    cur.n++;
    cur.views += p.performance?.views ?? 0;
    groups.set(key, cur);
  }

  const ranked = [...groups.entries()]
    .filter(([, v]) => v.n >= 3)
    .map(([key, v]) => ({ key, n: v.n, avg: v.views / v.n }))
    .sort((a, b) => b.avg - a.avg);

  if (ranked.length < 2) return [];
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  if (worst.avg === 0 || best.avg < worst.avg * 1.8) return [];

  return [{
    kind: "opportunity",
    area: "content",
    title: `${best.key} is outperforming ${worst.key} by ${(best.avg / worst.avg).toFixed(1)}×`,
    body:
      `Across ${pieces.length} measured posts in the last 90 days, ${best.key} averages ${Math.round(best.avg)} views over ${best.n} posts, ` +
      `while ${worst.key} averages ${Math.round(worst.avg)} over ${worst.n}. ` +
      (best.n >= 8 ? "That is a usable sample." : `With only ${best.n} posts this is a signal worth testing, not a proven finding.`),
    evidence: [
      { type: "metric", label: `${best.key} average views`, value: Math.round(best.avg) },
      { type: "metric", label: `${worst.key} average views`, value: Math.round(worst.avg) },
      { type: "count", label: "Posts measured", value: pieces.length },
    ],
    confidence: best.n >= 8 ? 0.75 : 0.5,
    severity: 3,
    suggestedActions: [`Shift the next content batch toward ${best.key}`, `Run one more round of ${worst.key} before dropping it, to rule out a bad-post effect`],
    detector: "content_format_signal",
    dedupeKey: `content_format_signal:${best.key}:${Math.floor(Date.now() / (30 * DAY))}`,
    expiresInDays: 30,
  }];
};

/** Money going out with nothing attributable coming back. */
const spendWithoutReturn: Detector = async () => {
  const since = new Date(Date.now() - 90 * DAY);
  const entries = await prisma.financeEntry.findMany({ where: { occurredAt: { gte: since } } });
  const spendByCategory = new Map<string, number>();
  for (const e of entries.filter((x) => x.direction === "expense")) {
    spendByCategory.set(e.category, (spendByCategory.get(e.category) ?? 0) + e.amountEur);
  }
  const income = entries.filter((e) => e.direction === "income").reduce((s, e) => s + e.amountEur, 0);

  const out: DetectedInsight[] = [];
  for (const category of ["promotion", "advertising"]) {
    const spend = spendByCategory.get(category) ?? 0;
    if (spend < 100) continue;
    if (income >= spend) continue;
    out.push({
      kind: "inefficiency",
      area: "finance",
      title: `€${spend.toFixed(0)} spent on ${category} in 90 days against €${income.toFixed(0)} total income`,
      body:
        `Recorded ${category} spend over the last 90 days is €${spend.toFixed(2)}, while total recorded income across all sources is €${income.toFixed(2)}. ` +
        "That does not prove the spend failed — attribution in music is genuinely hard, and income lags promotion — but nothing in the recorded data connects this spend to a return.",
      evidence: [
        { type: "money", label: `${category} spend (90d)`, value: spend },
        { type: "money", label: "Total income (90d)", value: income },
      ],
      confidence: 0.6,
      severity: 2,
      suggestedActions: [
        "Link finance entries to the release or campaign they belong to so ROI becomes computable",
        "Run one controlled test with a defined metric before the next spend",
      ],
      detector: "spend_without_return",
      dedupeKey: `spend_without_return:${category}:${Math.floor(Date.now() / (30 * DAY))}`,
      expiresInDays: 30,
    });
  }
  return out;
};

/** Release cadence — the strongest single driver of independent growth. */
const releaseCadence: Detector = async () => {
  const released = await prisma.release.findMany({
    where: { status: "out" },
    orderBy: { releaseDate: "desc" },
    take: 5,
  });
  const upcoming = await prisma.release.count({
    where: { status: { in: ["planned", "scheduled"] }, releaseDate: { gte: new Date() } },
  });
  if (upcoming > 0) return [];

  const last = released[0];
  const daysSince = last?.releaseDate ? Math.round((Date.now() - last.releaseDate.getTime()) / DAY) : null;
  if (daysSince != null && daysSince < 60) return [];

  const unreleased = await prisma.track.count({ where: { status: { in: ["ready", "mixdown", "mastering", "signed"] } } });

  return [{
    kind: "risk",
    area: "release",
    title: daysSince == null ? "No releases scheduled and none recorded" : `${daysSince} days since the last release, with nothing scheduled`,
    body:
      (daysSince == null
        ? "There is no release history in the system and nothing upcoming."
        : `The last release was ${last?.title} on ${fmt(last?.releaseDate)}, ${daysSince} days ago, and nothing is scheduled.`) +
      (unreleased > 0
        ? ` There ${unreleased === 1 ? "is" : "are"} ${unreleased} track${unreleased === 1 ? "" : "s"} at or near finished — the bottleneck is scheduling, not music.`
        : " There is also no finished music waiting, so production is the bottleneck."),
    evidence: [
      { type: "count", label: "Upcoming releases", value: 0 },
      { type: "count", label: "Near-finished tracks", value: unreleased },
      ...(daysSince != null ? [{ type: "count" as const, label: "Days since last release", value: daysSince }] : []),
    ],
    confidence: 0.85,
    severity: unreleased > 0 ? 1 : 2,
    suggestedActions: unreleased > 0
      ? ["Pick the strongest finished track and set a release date", "Work backwards from that date to a distribution deadline"]
      : ["Set a production deadline for the closest track to finished", "Decide whether to release independently to restart cadence"],
    detector: "release_cadence",
    dedupeKey: `release_cadence:${Math.floor(Date.now() / (14 * DAY))}`,
    expiresInDays: 14,
  }];
};

/** Overdue work that is quietly blocking a goal. */
const overdueBottleneck: Detector = async () => {
  const overdue = await prisma.task.findMany({
    where: { status: { in: ["todo", "doing", "blocked"] }, dueDate: { lt: new Date(Date.now() - 3 * DAY) } },
    include: { project: { select: { name: true, goalId: true } } },
    orderBy: { dueDate: "asc" },
    take: 20,
  });
  if (overdue.length < 3) return [];

  const highImpact = overdue.filter((t) => t.impact >= 4);
  const oldest = overdue[0];
  const days = Math.round((Date.now() - (oldest.dueDate?.getTime() ?? Date.now())) / DAY);

  return [{
    kind: "bottleneck",
    area: "growth",
    title: `${overdue.length} tasks overdue, ${highImpact.length} of them high-impact`,
    body:
      `The oldest is "${oldest.title}", ${days} days past due. ` +
      (highImpact.length > 0
        ? `${highImpact.length} of the overdue tasks are rated impact 4–5, so the backlog is not just admin — it is holding up work that matters.`
        : "None are high-impact, so the honest move may be to cancel them rather than carry them."),
    evidence: [
      { type: "count", label: "Overdue tasks", value: overdue.length },
      { type: "count", label: "High-impact overdue", value: highImpact.length },
      { type: "date", label: "Oldest due date", value: fmt(oldest.dueDate), ref: oldest.id },
    ],
    confidence: 0.9,
    severity: highImpact.length > 0 ? 2 : 4,
    suggestedActions: [
      "Cancel or reschedule everything below impact 3 — a backlog nobody will clear is just noise",
      highImpact.length > 0 ? `Start with "${highImpact[0].title}" today` : "Reset the due dates to something realistic",
    ],
    detector: "overdue_bottleneck",
    dedupeKey: `overdue_bottleneck:${Math.floor(Date.now() / (7 * DAY))}`,
    expiresInDays: 7,
  }];
};

/** Finished music sitting unused. */
const shelvedFinishedMusic: Detector = async () => {
  const cutoff = new Date(Date.now() - 45 * DAY);
  const tracks = await prisma.track.findMany({
    where: { status: "ready", updatedAt: { lte: cutoff }, releases: { none: {} } },
    take: 8,
  });
  if (tracks.length === 0) return [];

  return [{
    kind: "opportunity",
    area: "production",
    title: `${tracks.length} finished track${tracks.length === 1 ? "" : "s"} with no release or label plan`,
    body:
      `${tracks.map((t) => `"${t.title}"`).join(", ")} ${tracks.length === 1 ? "is" : "are"} marked ready and ${tracks.length === 1 ? "has" : "have"} sat untouched for over 45 days with no release attached. ` +
      "Finished music that is never released is the most expensive thing in an independent catalogue — the work is already paid for.",
    evidence: tracks.map((t) => ({ type: "ref" as const, label: "Track", value: t.title, ref: t.id })),
    confidence: 0.85,
    severity: 2,
    suggestedActions: ["Pick one and decide: pitch to labels or self-release", "If pitching, set a deadline after which it is self-released anyway"],
    detector: "shelved_finished_music",
    dedupeKey: `shelved_finished_music:${Math.floor(Date.now() / (21 * DAY))}`,
    expiresInDays: 21,
  }];
};

/** A high-fit label target that was researched and then never approached. */
const unusedLabelTargets: Detector = async () => {
  const labels = await prisma.label.findMany({
    where: { status: { in: ["researched", "target"] }, fitScore: { gte: 70 } },
    orderBy: { fitScore: "desc" },
    take: 5,
  });
  if (labels.length === 0) return [];
  const ready = await prisma.track.count({ where: { status: { in: ["ready", "mastering"] } } });
  if (ready === 0) return [];

  return [{
    kind: "opportunity",
    area: "outreach",
    title: `${labels.length} high-fit label${labels.length === 1 ? "" : "s"} researched but never contacted`,
    body:
      `${labels.map((l) => `${l.name} (fit ${Math.round(l.fitScore ?? 0)})`).join(", ")} ${labels.length === 1 ? "was" : "were"} researched and scored as a strong fit, but ${labels.length === 1 ? "has" : "have"} never been approached — ` +
      `while ${ready} track${ready === 1 ? "" : "s"} sit${ready === 1 ? "s" : ""} finished or near-finished.`,
    evidence: labels.map((l) => ({ type: "ref" as const, label: l.name, value: `fit ${Math.round(l.fitScore ?? 0)}`, ref: l.id })),
    confidence: 0.8,
    severity: 2,
    suggestedActions: [
      "Confirm each label's current demo policy before sending anything — policies change",
      "Draft one personalised submission per label, referencing a specific recent release of theirs",
    ],
    detector: "unused_label_targets",
    dedupeKey: `unused_label_targets:${Math.floor(Date.now() / (21 * DAY))}`,
    expiresInDays: 21,
  }];
};

/** Goals that will not be met at the current rate. */
const goalOffTrack: Detector = async () => {
  const goals = await prisma.goal.findMany({
    where: { status: "active", targetValue: { not: null }, dueDate: { not: null } },
  });
  const out: DetectedInsight[] = [];
  for (const g of goals) {
    if (!g.dueDate || g.targetValue == null) continue;
    const daysLeft = Math.round((g.dueDate.getTime() - Date.now()) / DAY);
    if (daysLeft <= 0 || daysLeft > 120) continue;
    const progress = (g.currentValue ?? 0) / g.targetValue;
    const totalDays = Math.max(1, Math.round((g.dueDate.getTime() - (g.startDate?.getTime() ?? g.createdAt.getTime())) / DAY));
    const expected = 1 - daysLeft / totalDays;
    if (progress >= expected * 0.75) continue;

    out.push({
      kind: "risk",
      area: "growth",
      title: `"${g.title}" is behind pace with ${daysLeft} days left`,
      body:
        `At ${g.currentValue ?? 0} of ${g.targetValue}${g.unit ? ` ${g.unit}` : ""} (${Math.round(progress * 100)}%), with ${Math.round(expected * 100)}% of the time elapsed. ` +
        "Either the plan behind it needs more weight, or the target was wrong and should be reset honestly rather than missed quietly.",
      evidence: [
        { type: "metric", label: "Current", value: g.currentValue ?? 0, ref: g.id },
        { type: "metric", label: "Target", value: g.targetValue, ref: g.id },
        { type: "count", label: "Days left", value: daysLeft },
      ],
      confidence: 0.7,
      severity: 2,
      suggestedActions: ["Decide: add resources, or reset the target", "Check whether any project actually serves this goal"],
      detector: "goal_off_track",
      dedupeKey: `goal_off_track:${g.id}:${Math.floor(Date.now() / (14 * DAY))}`,
      expiresInDays: 14,
    });
  }
  return out;
};

const DETECTORS: Detector[] = [
  releaseWithoutCampaign,
  staleOutreach,
  contentFormatSignal,
  spendWithoutReturn,
  releaseCadence,
  overdueBottleneck,
  shelvedFinishedMusic,
  unusedLabelTargets,
  goalOffTrack,
];

/**
 * Runs every detector and persists new insights.
 *
 * dedupeKey carries a time bucket, so a standing problem resurfaces on a
 * sensible cadence instead of either spamming daily or going silent forever.
 */
export async function scanForInsights(): Promise<{ created: number; skipped: number; insights: DetectedInsight[] }> {
  const found: DetectedInsight[] = [];
  for (const detector of DETECTORS) {
    try {
      found.push(...(await detector()));
    } catch (err) {
      log.warn("intelligence.detector.failed", { error: String(err) });
    }
  }

  let created = 0;
  let skipped = 0;
  for (const insight of found) {
    const existing = await prisma.insight.findUnique({ where: { dedupeKey: insight.dedupeKey } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.insight.create({
      data: {
        kind: insight.kind,
        area: insight.area,
        title: insight.title,
        body: insight.body,
        evidenceJson: toJson(insight.evidence),
        confidence: insight.confidence,
        severity: insight.severity,
        suggestedActionsJson: toJson(insight.suggestedActions),
        detector: insight.detector,
        dedupeKey: insight.dedupeKey,
        expiresAt: insight.expiresInDays ? new Date(Date.now() + insight.expiresInDays * DAY) : null,
      },
    });
    created++;
  }

  await prisma.insight.updateMany({
    where: { status: "new", expiresAt: { lt: new Date() } },
    data: { status: "expired" },
  });

  log.info("intelligence.scan", { found: found.length, created, skipped });
  return { created, skipped, insights: found };
}
