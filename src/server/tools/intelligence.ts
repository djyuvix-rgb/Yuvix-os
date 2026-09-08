import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { parseArray, toJson } from "@/server/db/json";
import { scanForInsights } from "@/server/intelligence/detectors";
import { dailyPriorities, renderWeeklyMarkdown, runWeeklyReview, weeklyReview } from "@/server/intelligence/reviews";
import { INSIGHT_KINDS } from "@/server/domain/constants";

export const intelligenceTools = [
  defineTool({
    name: "daily_priorities",
    group: "intelligence",
    autonomy: "level1",
    readOnly: true,
    description:
      "The answer to 'what should I do today'. Returns a scored, ordered list of tasks, follow-ups, pending approvals and unreviewed insights, each with the reason it matters, plus a capacity check against the artist's stated hours. " +
      "Present the reasons, not just the list — the operator needs to understand why the order is what it is.",
    schema: z.object({ limit: z.number().int().min(3).max(15).optional() }),
    async execute(input) {
      return dailyPriorities(input.limit ?? 8);
    },
  }),

  defineTool({
    name: "weekly_review",
    group: "intelligence",
    autonomy: "level1",
    description:
      "Run the weekly CEO review: what happened, what matters, what worked, what failed, what was learned, what to do next, and the top 5 priorities — built strictly from recorded data. " +
      "Where a section comes back empty, that emptiness is the finding; report it rather than filling it with narrative.",
    schema: z.object({ persist: z.boolean().optional(), weeksBack: z.number().int().min(0).max(12).optional() }),
    async execute(input) {
      if (input.weeksBack && input.weeksBack > 0) {
        const review = await weeklyReview(input.weeksBack);
        return { review, markdown: renderWeeklyMarkdown(review), persisted: false };
      }
      if (input.persist === false) {
        const review = await weeklyReview(0);
        return { review, markdown: renderWeeklyMarkdown(review), persisted: false };
      }
      const { id, markdown, review } = await runWeeklyReview();
      return { reviewId: id, review, markdown, persisted: true };
    },
  }),

  defineTool({
    name: "insights_scan",
    group: "intelligence",
    autonomy: "level1",
    description:
      "Run the proactive intelligence pass over the business: missing campaigns, stale outreach, content signals, unproductive spend, release cadence, overdue bottlenecks, shelved finished music, unused label targets, goals off pace. " +
      "Every insight carries its evidence. Report the evidence with the insight — an unsupported claim is worse than silence.",
    schema: z.object({}),
    async execute() {
      const { created, skipped, insights } = await scanForInsights();
      return {
        created,
        alreadyKnown: skipped,
        insights: insights.map((i) => ({
          kind: i.kind,
          area: i.area,
          title: i.title,
          body: i.body,
          evidence: i.evidence,
          confidence: i.confidence,
          severity: i.severity,
          suggestedActions: i.suggestedActions,
        })),
        note: insights.length === 0 ? "No rule fired. Nothing in the recorded data indicates a problem or an opportunity right now." : undefined,
      };
    },
  }),

  defineTool({
    name: "insights_list",
    group: "intelligence",
    autonomy: "level1",
    readOnly: true,
    description: "List stored insights and their status, so the same recommendation is not repeated after it has been acted on or dismissed.",
    schema: z.object({ status: z.string().optional(), kind: z.enum(INSIGHT_KINDS).optional(), limit: z.number().int().min(1).max(50).optional() }),
    async execute(input) {
      const rows = await prisma.insight.findMany({
        where: { ...(input.status ? { status: input.status } : { status: "new" }), ...(input.kind ? { kind: input.kind } : {}) },
        orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
        take: input.limit ?? 20,
      });
      return {
        count: rows.length,
        insights: rows.map((i) => ({
          id: i.id,
          kind: i.kind,
          area: i.area,
          title: i.title,
          body: i.body,
          evidence: parseArray(i.evidenceJson),
          suggestedActions: parseArray<string>(i.suggestedActionsJson),
          confidence: i.confidence,
          severity: i.severity,
          status: i.status,
          raisedAt: i.createdAt.toISOString().slice(0, 10),
        })),
      };
    },
  }),

  defineTool({
    name: "insight_update",
    group: "intelligence",
    autonomy: "level1",
    description: "Mark an insight acknowledged, acted on or dismissed. Dismissing needs a reason — that reason becomes a memory so the same suggestion is not made again.",
    schema: z.object({
      id: z.string(),
      status: z.enum(["acknowledged", "acted", "dismissed"]),
      note: z.string().optional(),
    }),
    async execute(input) {
      const insight = await prisma.insight.update({ where: { id: input.id }, data: { status: input.status } });
      if (input.status === "dismissed" && input.note) {
        await prisma.memoryItem.create({
          data: {
            layer: "business",
            kind: "preference",
            title: `Dismissed: ${insight.title}`,
            content: `The operator dismissed this recommendation. Reason: ${input.note}. Do not raise it again in the same form.`,
            confidence: 0.9,
            source: "user",
            tagsJson: toJson(["dismissed-insight", insight.detector]),
          },
        });
      }
      return { id: insight.id, status: insight.status };
    },
  }),
];
