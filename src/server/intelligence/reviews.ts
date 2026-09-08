import { prisma } from "@/server/db/client";
import { parseArray, toJson } from "@/server/db/json";
import { scanForInsights, type Evidence } from "./detectors";

const DAY = 86_400_000;
const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");

/**
 * Daily prioritisation ("what should I do today").
 *
 * Scoring is explicit rather than model-judged so the ordering is stable and
 * explainable: the same inputs always produce the same list, and every item
 * carries the reason it is there.
 */
export interface PrioritisedItem {
  type: "task" | "followup" | "insight" | "approval";
  id: string;
  title: string;
  why: string;
  score: number;
  dueDate: string | null;
  effortMin: number | null;
  project: string | null;
}

export async function dailyPriorities(limit = 8): Promise<{
  date: string;
  items: PrioritisedItem[];
  capacityMinutes: number | null;
  overCapacity: boolean;
  notes: string[];
}> {
  const now = new Date();
  const soon = new Date(now.getTime() + 3 * DAY);

  const [tasks, contacts, labels, insights, approvals, artist] = await Promise.all([
    prisma.task.findMany({
      where: { status: { in: ["todo", "doing"] } },
      include: {
        project: { select: { name: true, priority: true, goal: { select: { title: true, level: true } } } },
        dependsOn: { include: { dependsOn: { select: { status: true, title: true } } } },
      },
      take: 100,
    }),
    prisma.contact.findMany({
      where: { nextActionAt: { lte: soon }, status: { notIn: ["rejected", "inactive", "signed"] } },
      take: 20,
    }),
    prisma.label.findMany({
      where: { nextActionAt: { lte: soon }, status: { notIn: ["rejected", "inactive", "signed"] } },
      take: 10,
    }),
    prisma.insight.findMany({ where: { status: "new" }, orderBy: { severity: "asc" }, take: 10 }),
    prisma.approval.findMany({ where: { status: "pending" }, take: 10 }),
    prisma.artistProfile.findFirst(),
  ]);

  const items: PrioritisedItem[] = [];

  for (const task of tasks) {
    const blocked = task.dependsOn.filter((d) => d.dependsOn.status !== "done");
    if (blocked.length) continue; // a blocked task is not today's work

    const daysToDue = task.dueDate ? (task.dueDate.getTime() - now.getTime()) / DAY : null;
    // Urgency rises sharply once something is due or overdue; impact and the
    // parent project's priority carry the rest.
    const urgency = daysToDue == null ? 0 : daysToDue < 0 ? 40 + Math.min(-daysToDue, 20) : Math.max(0, 25 - daysToDue * 3);
    const impact = task.impact * 8;
    const projectWeight = task.project ? (6 - task.project.priority) * 3 : 0;
    const quickWin = task.effortMin && task.effortMin <= 30 ? 5 : 0;

    items.push({
      type: "task",
      id: task.id,
      title: task.title,
      why:
        task.rationale ??
        (task.project?.goal ? `Serves the goal "${task.project.goal.title}"` : "No rationale recorded — consider whether this task should exist"),
      score: Math.round(urgency + impact + projectWeight + quickWin),
      dueDate: fmt(task.dueDate),
      effortMin: task.effortMin,
      project: task.project?.name ?? null,
    });
  }

  for (const c of contacts) {
    const overdue = c.nextActionAt ? c.nextActionAt < now : false;
    items.push({
      type: "followup",
      id: c.id,
      title: `Follow up: ${c.name}${c.company ? ` (${c.company})` : ""}`,
      why: `${c.nextAction ?? "Scheduled follow-up"} — pipeline status "${c.status}", last contact ${fmt(c.lastContactAt)}. Relationships in this stage go cold without contact.`,
      score: (overdue ? 45 : 28) + (6 - c.priority) * 4,
      dueDate: fmt(c.nextActionAt),
      effortMin: 15,
      project: "CRM",
    });
  }

  for (const l of labels) {
    items.push({
      type: "followup",
      id: l.id,
      title: `Label action: ${l.name}`,
      why: `${l.nextAction ?? "Scheduled follow-up"} — status "${l.status}"${l.fitScore ? `, fit ${Math.round(l.fitScore)}` : ""}.`,
      score: 30 + (l.fitScore ?? 0) / 10,
      dueDate: fmt(l.nextActionAt),
      effortMin: 20,
      project: "Label pipeline",
    });
  }

  for (const a of approvals) {
    items.push({
      type: "approval",
      id: a.id,
      title: `Decide: ${a.title}`,
      why: "The agent is blocked on your approval and cannot proceed without it.",
      score: 55,
      dueDate: null,
      effortMin: 5,
      project: "Approvals",
    });
  }

  for (const i of insights.slice(0, 3)) {
    items.push({
      type: "insight",
      id: i.id,
      title: i.title,
      why: i.body.slice(0, 280),
      score: 50 - i.severity * 6,
      dueDate: null,
      effortMin: 10,
      project: "Intelligence",
    });
  }

  const ranked = items.sort((a, b) => b.score - a.score).slice(0, limit);
  const plannedMinutes = ranked.reduce((s, i) => s + (i.effortMin ?? 30), 0);
  const dailyCapacity = artist?.weeklyHours ? Math.round((artist.weeklyHours * 60) / 5) : null;

  const notes: string[] = [];
  if (dailyCapacity && plannedMinutes > dailyCapacity) {
    notes.push(
      `This list is about ${Math.round(plannedMinutes / 60)}h against roughly ${Math.round(dailyCapacity / 60)}h of daily capacity. Do the top three; the rest can wait.`,
    );
  }
  if (ranked.length === 0) notes.push("Nothing is scheduled or overdue. That is either a genuinely clear day or a sign the plan is empty — check the goals.");

  return {
    date: now.toISOString().slice(0, 10),
    items: ranked,
    capacityMinutes: dailyCapacity,
    overCapacity: Boolean(dailyCapacity && plannedMinutes > dailyCapacity),
    notes,
  };
}

export interface WeeklyReview {
  periodStart: string;
  periodEnd: string;
  whatHappened: string[];
  whatMatters: string[];
  whatWorked: string[];
  whatFailed: string[];
  whatILearned: string[];
  whatToDoNext: string[];
  topPriorities: { title: string; why: string }[];
  numbers: Record<string, number | string | null>;
}

/**
 * Weekly CEO review, built from data only.
 *
 * Sections stay empty rather than being filled with plausible-sounding
 * narrative — an empty "what worked" is itself the finding.
 */
export async function weeklyReview(weeksBack = 0): Promise<WeeklyReview> {
  const end = new Date(Date.now() - weeksBack * 7 * DAY);
  const start = new Date(end.getTime() - 7 * DAY);
  const prevStart = new Date(start.getTime() - 7 * DAY);

  const [
    doneTasks, missedTasks, createdTasks, releases, published, interactions,
    finance, metrics, insights, decisions, prevDone, prevPublished,
  ] = await Promise.all([
    prisma.task.findMany({ where: { completedAt: { gte: start, lte: end } }, include: { project: { select: { name: true } } } }),
    prisma.task.findMany({ where: { status: { in: ["todo", "doing", "blocked"] }, dueDate: { gte: start, lte: end } } }),
    prisma.task.count({ where: { createdAt: { gte: start, lte: end } } }),
    prisma.release.findMany({ where: { releaseDate: { gte: start, lte: end } } }),
    prisma.contentPiece.findMany({ where: { publishedAt: { gte: start, lte: end } }, include: { performance: true } }),
    prisma.interaction.findMany({ where: { occurredAt: { gte: start, lte: end } } }),
    prisma.financeEntry.findMany({ where: { occurredAt: { gte: start, lte: end } } }),
    prisma.metric.findMany({ where: { periodEnd: { gte: prevStart, lte: end } }, orderBy: { periodEnd: "asc" } }),
    prisma.insight.findMany({ where: { createdAt: { gte: start, lte: end } }, orderBy: { severity: "asc" } }),
    prisma.decision.findMany({ where: { createdAt: { gte: start, lte: end } } }),
    prisma.task.count({ where: { completedAt: { gte: prevStart, lt: start } } }),
    prisma.contentPiece.count({ where: { publishedAt: { gte: prevStart, lt: start } } }),
  ]);

  const income = finance.filter((f) => f.direction === "income").reduce((s, f) => s + f.amountEur, 0);
  const expense = finance.filter((f) => f.direction === "expense").reduce((s, f) => s + f.amountEur, 0);
  const outbound = interactions.filter((i) => i.direction === "outbound").length;
  const replies = interactions.filter((i) => i.direction === "inbound" || ["replied", "positive", "meeting", "deal"].includes(i.outcome ?? "")).length;

  const whatHappened: string[] = [];
  if (doneTasks.length) whatHappened.push(`Completed ${doneTasks.length} task${doneTasks.length === 1 ? "" : "s"} (previous week: ${prevDone}).`);
  if (createdTasks) whatHappened.push(`${createdTasks} new task${createdTasks === 1 ? "" : "s"} created.`);
  if (releases.length) whatHappened.push(`Released: ${releases.map((r) => r.title).join(", ")}.`);
  if (published.length) whatHappened.push(`Published ${published.length} content piece${published.length === 1 ? "" : "s"} (previous week: ${prevPublished}).`);
  if (interactions.length) whatHappened.push(`${outbound} outbound message${outbound === 1 ? "" : "s"}, ${replies} reply/positive outcome${replies === 1 ? "" : "s"}.`);
  if (finance.length) whatHappened.push(`€${income.toFixed(2)} in, €${expense.toFixed(2)} out.`);
  if (whatHappened.length === 0) whatHappened.push("Nothing was recorded this week. Either it was a genuinely quiet week, or work is happening outside the system and the record is not reflecting reality.");

  const whatWorked: string[] = [];
  const measured = published.filter((p) => p.performance?.views != null);
  if (measured.length >= 2) {
    const best = measured.sort((a, b) => (b.performance?.views ?? 0) - (a.performance?.views ?? 0))[0];
    whatWorked.push(`Best content: "${best.title}" (${best.platform}/${best.format}) at ${best.performance?.views} views. Hook: "${best.hook ?? "—"}".`);
  }
  if (replies > 0 && outbound > 0) whatWorked.push(`Outreach reply rate ${Math.round((replies / outbound) * 100)}% on ${outbound} message${outbound === 1 ? "" : "s"}.`);
  if (doneTasks.length > prevDone && prevDone > 0) whatWorked.push(`Throughput up from ${prevDone} to ${doneTasks.length} tasks.`);

  const whatFailed: string[] = [];
  if (missedTasks.length) whatFailed.push(`${missedTasks.length} task${missedTasks.length === 1 ? "" : "s"} due this week not completed: ${missedTasks.slice(0, 5).map((t) => t.title).join("; ")}.`);
  if (outbound > 0 && replies === 0) whatFailed.push(`${outbound} outbound message${outbound === 1 ? "" : "s"} with no replies. Either the targeting or the message is wrong — do not simply send more.`);
  if (published.length === 0 && prevPublished > 0) whatFailed.push("No content published this week after publishing last week. Consistency is what compounds; gaps reset it.");
  if (expense > income && expense > 0) whatFailed.push(`Spent €${(expense - income).toFixed(2)} more than earned this week.`);

  const whatMatters: string[] = insights.slice(0, 4).map((i) => `[${i.kind}] ${i.title}`);
  const whatILearned: string[] = decisions.map((d) => `Decided: ${d.question} → ${d.chosenOption ?? d.recommendation}${d.uncertainty ? ` (uncertainty: ${d.uncertainty})` : ""}`);

  // Growth from actual measurements only.
  const numbers: Record<string, number | string | null> = {
    tasksCompleted: doneTasks.length,
    tasksMissed: missedTasks.length,
    contentPublished: published.length,
    outboundMessages: outbound,
    replies,
    incomeEur: Number(income.toFixed(2)),
    expenseEur: Number(expense.toFixed(2)),
    netEur: Number((income - expense).toFixed(2)),
  };
  const bySeries = new Map<string, { at: Date; value: number }[]>();
  for (const m of metrics) {
    const key = `${m.platform}.${m.metric}`;
    const arr = bySeries.get(key) ?? [];
    arr.push({ at: m.periodEnd, value: m.value });
    bySeries.set(key, arr);
  }
  for (const [key, points] of bySeries) {
    if (points.length < 2) {
      numbers[key] = points[0]?.value ?? null;
      continue;
    }
    const first = points[0].value;
    const last = points[points.length - 1].value;
    numbers[key] = last;
    numbers[`${key}_change`] = Number((last - first).toFixed(2));
  }
  if (bySeries.size === 0) numbers.audienceMetrics = "none recorded — no growth claim can be made";

  const nextInsights = await prisma.insight.findMany({ where: { status: "new" }, orderBy: { severity: "asc" }, take: 5 });
  const priorities = await dailyPriorities(5);

  const whatToDoNext = [
    ...nextInsights.slice(0, 3).map((i) => (parseArray<string>(i.suggestedActionsJson)[0] ?? i.title)),
    ...(missedTasks.length ? ["Reschedule or cancel the tasks that slipped — carrying them silently is how a plan dies"] : []),
  ];

  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
    whatHappened,
    whatMatters: whatMatters.length ? whatMatters : ["No new insights were raised this week."],
    whatWorked: whatWorked.length ? whatWorked : ["Nothing measurable can be called a win this week — not enough was measured to say."],
    whatFailed: whatFailed.length ? whatFailed : ["Nothing recorded as failed."],
    whatILearned: whatILearned.length ? whatILearned : ["No decisions were logged this week."],
    whatToDoNext: whatToDoNext.length ? whatToDoNext : ["Set the next concrete objective — there is nothing queued."],
    topPriorities: priorities.items.slice(0, 5).map((i) => ({ title: i.title, why: i.why })),
    numbers,
  };
}

export function renderWeeklyMarkdown(review: WeeklyReview): string {
  const section = (title: string, lines: string[]) => `## ${title}\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
  return [
    `# Weekly review — ${review.periodStart} to ${review.periodEnd}`,
    "",
    section("What happened", review.whatHappened),
    section("What matters", review.whatMatters),
    section("What worked", review.whatWorked),
    section("What failed", review.whatFailed),
    section("What I learned", review.whatILearned),
    section("What to do next", review.whatToDoNext),
    `## Top 5 priorities\n${review.topPriorities.map((p, i) => `${i + 1}. **${p.title}** — ${p.why}`).join("\n")}`,
    "",
    `## Numbers\n${Object.entries(review.numbers).map(([k, v]) => `- ${k}: ${v ?? "—"}`).join("\n")}`,
  ].join("\n");
}

/** Runs the weekly review, persists it, and refreshes insights first so it reflects current state. */
export async function runWeeklyReview(): Promise<{ id: string; markdown: string; review: WeeklyReview }> {
  await scanForInsights();
  const review = await weeklyReview(0);
  const markdown = renderWeeklyMarkdown(review);
  const row = await prisma.review.create({
    data: {
      type: "weekly",
      periodStart: new Date(review.periodStart),
      periodEnd: new Date(review.periodEnd),
      bodyJson: toJson(review),
      markdown,
    },
  });
  return { id: row.id, markdown, review };
}

export type { Evidence };
