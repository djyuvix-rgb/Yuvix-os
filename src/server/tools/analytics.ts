import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toDate = (s: string) => new Date(`${s}T12:00:00.000Z`);

export const analyticsTools = [
  defineTool({
    name: "metric_record",
    group: "analytics",
    autonomy: "level1",
    description:
      "Record a measured metric (monthly listeners, followers, streams, saves, views) for a period. " +
      "Source must be honest: 'manual' when the operator reported it, 'integration:<name>' when a connected platform returned it. Never record a number you inferred.",
    schema: z.object({
      platform: z.string(),
      metric: z.string().describe("snake_case, e.g. monthly_listeners, followers, streams, saves"),
      value: z.number(),
      entityType: z.enum(["release", "track", "content", "account"]).optional(),
      entityId: z.string().optional(),
      periodStart: dateStr,
      periodEnd: dateStr,
      source: z.string().optional(),
    }),
    async execute({ periodStart, periodEnd, ...rest }) {
      const metric = await prisma.metric.create({
        data: { ...rest, periodStart: toDate(periodStart), periodEnd: toDate(periodEnd), source: rest.source ?? "manual" },
      });
      return { id: metric.id, platform: metric.platform, metric: metric.metric, value: metric.value };
    },
  }),

  defineTool({
    name: "metric_history",
    group: "analytics",
    autonomy: "level1",
    readOnly: true,
    description:
      "Read a metric's history with growth rates between measurements. Use this instead of guessing at trends. " +
      "If it returns fewer than two points, say that growth cannot be assessed yet.",
    schema: z.object({
      platform: z.string().optional(),
      metric: z.string().optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      sinceDays: z.number().int().min(7).max(1095).optional(),
    }),
    async execute(input) {
      const since = new Date(Date.now() - (input.sinceDays ?? 180) * 86_400_000);
      const rows = await prisma.metric.findMany({
        where: {
          periodEnd: { gte: since },
          ...(input.platform ? { platform: input.platform } : {}),
          ...(input.metric ? { metric: input.metric } : {}),
          ...(input.entityType ? { entityType: input.entityType } : {}),
          ...(input.entityId ? { entityId: input.entityId } : {}),
        },
        orderBy: { periodEnd: "asc" },
      });

      const series = new Map<string, { at: string; value: number; source: string }[]>();
      for (const r of rows) {
        const key = `${r.platform}.${r.metric}`;
        const arr = series.get(key) ?? [];
        arr.push({ at: r.periodEnd.toISOString().slice(0, 10), value: r.value, source: r.source });
        series.set(key, arr);
      }

      return {
        seriesCount: series.size,
        series: [...series.entries()].map(([key, points]) => {
          const first = points[0];
          const last = points[points.length - 1];
          const days = (new Date(last.at).getTime() - new Date(first.at).getTime()) / 86_400_000;
          return {
            key,
            points,
            change: points.length > 1
              ? {
                  absolute: Number((last.value - first.value).toFixed(2)),
                  percent: first.value !== 0 ? Number((((last.value - first.value) / first.value) * 100).toFixed(1)) : null,
                  overDays: Math.round(days),
                  perMonth: days > 0 ? Number((((last.value - first.value) / days) * 30).toFixed(2)) : null,
                }
              : null,
            assessment: points.length < 2 ? "Only one measurement — no trend can be stated." : undefined,
          };
        }),
        note: rows.length === 0 ? "No metrics recorded. Ask the operator for current numbers or connect an integration; do not estimate." : undefined,
      };
    },
  }),

  defineTool({
    name: "integration_status",
    group: "system",
    autonomy: "level1",
    readOnly: true,
    description:
      "List every platform integration, whether it is connected, and exactly which environment variables are needed to connect it. " +
      "Call this whenever the operator asks for live platform data so you can tell them precisely what to set up instead of guessing at numbers.",
    schema: z.object({}),
    async execute() {
      const rows = await prisma.integration.findMany({ orderBy: { key: "asc" } });
      return {
        connected: rows.filter((r) => r.status === "configured").map((r) => r.key),
        integrations: rows.map((r) => ({
          key: r.key,
          name: r.name,
          status: r.status,
          requiredEnv: JSON.parse(r.requiredEnvJson || "[]") as string[],
          lastError: r.lastError,
        })),
        note: "Only 'configured' integrations can return live data. For the rest, ask the operator for numbers or a CSV export.",
      };
    },
  }),
];
