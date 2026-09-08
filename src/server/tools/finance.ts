import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/server/domain/constants";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toDate = (s: string) => new Date(`${s}T12:00:00.000Z`);

export const financeTools = [
  defineTool({
    name: "finance_record",
    group: "finance",
    autonomy: "level1",
    description:
      "Record income or an expense. Link it to a release, campaign or project whenever it belongs to one — that link is what makes marketing ROI and revenue-per-release computable later. " +
      "Only record amounts the operator actually reports. Never estimate earnings.",
    schema: z.object({
      direction: z.enum(["income", "expense"]),
      category: z.string().describe(`income: ${INCOME_CATEGORIES.join("|")} · expense: ${EXPENSE_CATEGORIES.join("|")}`),
      amountEur: z.number().positive(),
      description: z.string().optional(),
      vendor: z.string().optional(),
      occurredAt: dateStr,
      releaseId: z.string().optional(),
      campaignId: z.string().optional(),
      projectId: z.string().optional(),
    }),
    async execute({ occurredAt, ...rest }) {
      const entry = await prisma.financeEntry.create({ data: { ...rest, occurredAt: toDate(occurredAt) } });
      return { id: entry.id, direction: entry.direction, amountEur: entry.amountEur, category: entry.category };
    },
  }),

  defineTool({
    name: "finance_summary",
    group: "finance",
    autonomy: "level1",
    readOnly: true,
    description:
      "Financial position over a period: revenue, expenses, profit, breakdown by category, revenue per release, marketing ROI and cost per result. " +
      "Use this before recommending any spend — and report honestly when there is not enough data to compute ROI.",
    schema: z.object({
      fromDate: dateStr.optional(),
      toDate: dateStr.optional(),
      groupBy: z.enum(["month", "category", "release", "campaign"]).optional(),
    }),
    async execute(input) {
      const from = input.fromDate ? toDate(input.fromDate) : new Date(Date.now() - 365 * 86_400_000);
      const to = input.toDate ? toDate(input.toDate) : new Date();

      const entries = await prisma.financeEntry.findMany({
        where: { occurredAt: { gte: from, lte: to } },
        orderBy: { occurredAt: "asc" },
      });

      if (entries.length === 0) {
        return {
          period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
          entries: 0,
          note: "No financial entries recorded in this period. No revenue, profit or ROI figure can be produced — say so rather than estimating.",
        };
      }

      const income = entries.filter((e) => e.direction === "income");
      const expense = entries.filter((e) => e.direction === "expense");
      const sum = (rows: typeof entries) => Number(rows.reduce((s, e) => s + e.amountEur, 0).toFixed(2));

      const byCategory = (rows: typeof entries) => {
        const m = new Map<string, number>();
        for (const e of rows) m.set(e.category, (m.get(e.category) ?? 0) + e.amountEur);
        return [...m.entries()].map(([category, total]) => ({ category, total: Number(total.toFixed(2)) })).sort((a, b) => b.total - a.total);
      };

      const byMonth = new Map<string, { income: number; expense: number }>();
      for (const e of entries) {
        const key = e.occurredAt.toISOString().slice(0, 7);
        const cur = byMonth.get(key) ?? { income: 0, expense: 0 };
        cur[e.direction as "income" | "expense"] += e.amountEur;
        byMonth.set(key, cur);
      }

      // Per-release economics: only releases that carry linked entries.
      const releaseIds = [...new Set(entries.map((e) => e.releaseId).filter((x): x is string => !!x))];
      const releases = releaseIds.length
        ? await prisma.release.findMany({ where: { id: { in: releaseIds } }, select: { id: true, title: true, releaseDate: true } })
        : [];
      const perRelease = releases.map((r) => {
        const rows = entries.filter((e) => e.releaseId === r.id);
        const rev = sum(rows.filter((e) => e.direction === "income"));
        const cost = sum(rows.filter((e) => e.direction === "expense"));
        return {
          releaseId: r.id,
          title: r.title,
          revenue: rev,
          cost,
          net: Number((rev - cost).toFixed(2)),
          roi: cost > 0 ? Number((((rev - cost) / cost) * 100).toFixed(1)) : null,
        };
      });

      const marketingSpend = sum(expense.filter((e) => ["promotion", "advertising", "content"].includes(e.category)));
      const totalIncome = sum(income);
      const totalExpense = sum(expense);

      const months = Math.max(1, (to.getTime() - from.getTime()) / (30 * 86_400_000));

      return {
        period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        entries: entries.length,
        totals: {
          income: totalIncome,
          expense: totalExpense,
          profit: Number((totalIncome - totalExpense).toFixed(2)),
          margin: totalIncome > 0 ? Number((((totalIncome - totalExpense) / totalIncome) * 100).toFixed(1)) : null,
        },
        monthlyAverages: {
          income: Number((totalIncome / months).toFixed(2)),
          expense: Number((totalExpense / months).toFixed(2)),
          profit: Number(((totalIncome - totalExpense) / months).toFixed(2)),
        },
        incomeByCategory: byCategory(income),
        expenseByCategory: byCategory(expense),
        byMonth: [...byMonth.entries()].map(([month, v]) => ({
          month,
          income: Number(v.income.toFixed(2)),
          expense: Number(v.expense.toFixed(2)),
          profit: Number((v.income - v.expense).toFixed(2)),
        })),
        perRelease,
        marketing: {
          spend: marketingSpend,
          note:
            marketingSpend > 0
              ? "Marketing ROI needs attributable revenue. Only releases with linked income entries above can support an ROI claim."
              : "No marketing spend recorded in this period.",
        },
      };
    },
  }),

  defineTool({
    name: "experiment_track",
    group: "finance",
    autonomy: "level1",
    description:
      "Log a business experiment (an ad test, a content format test, an outreach approach) with its hypothesis, metric, baseline and cost — then update it with the result. " +
      "This is how the system stops repeating things that did not work.",
    schema: z.object({
      id: z.string().optional(),
      hypothesis: z.string(),
      area: z.enum(["content", "ads", "outreach", "release", "pricing", "other"]),
      design: z.string().optional(),
      metric: z.string(),
      baseline: z.number().optional(),
      result: z.number().optional(),
      costEur: z.number().min(0).optional(),
      status: z.enum(["proposed", "running", "concluded", "abandoned"]).optional(),
      conclusion: z.string().optional(),
    }),
    async execute({ id, ...rest }) {
      const experiment = id
        ? await prisma.experiment.update({ where: { id }, data: { ...rest, endedAt: rest.status === "concluded" ? new Date() : undefined } })
        : await prisma.experiment.create({ data: { ...rest, startedAt: rest.status === "running" ? new Date() : null } });
      return { id: experiment.id, hypothesis: experiment.hypothesis, status: experiment.status };
    },
  }),

  defineTool({
    name: "experiment_list",
    group: "finance",
    autonomy: "level1",
    readOnly: true,
    description: "List experiments and their conclusions, so past results inform new recommendations.",
    schema: z.object({ status: z.string().optional() }),
    async execute(input) {
      const items = await prisma.experiment.findMany({
        where: input.status ? { status: input.status } : {},
        orderBy: { createdAt: "desc" },
        take: 40,
      });
      return {
        count: items.length,
        experiments: items.map((e) => ({
          id: e.id,
          hypothesis: e.hypothesis,
          area: e.area,
          metric: e.metric,
          baseline: e.baseline,
          result: e.result,
          delta: e.baseline != null && e.result != null ? Number((e.result - e.baseline).toFixed(2)) : null,
          costEur: e.costEur,
          status: e.status,
          conclusion: e.conclusion,
        })),
      };
    },
  }),
];
