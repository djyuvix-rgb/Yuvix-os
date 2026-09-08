import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { toJson } from "@/server/db/json";
import { CONTENT_FORMATS, CONTENT_STATUS, PLATFORMS } from "@/server/domain/constants";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toDate = (s?: string) => (s ? new Date(`${s}T12:00:00.000Z`) : undefined);

export const contentTools = [
  defineTool({
    name: "content_pillar_set",
    group: "content",
    autonomy: "level1",
    description:
      "Define the artist's content pillars — the 3–5 recurring themes the brand is built on (e.g. studio process, live DJ energy, the sound's origin story, taste-making). " +
      "Shares should total roughly 100%. Everything the content engine produces should map to a pillar.",
    schema: z.object({
      pillars: z.array(z.object({
        name: z.string(),
        description: z.string(),
        sharePct: z.number().int().min(5).max(70),
        examples: z.array(z.string()).optional(),
      })).min(2).max(6),
      replaceExisting: z.boolean().optional(),
    }),
    async execute(input) {
      const artist = await prisma.artistProfile.findFirst();
      if (!artist) return { error: "Create the artist profile first with artist_profile_update." };
      if (input.replaceExisting) await prisma.contentPillar.deleteMany({ where: { artistId: artist.id } });

      const created = [];
      for (const p of input.pillars) {
        const pillar = await prisma.contentPillar.upsert({
          where: { artistId_name: { artistId: artist.id, name: p.name } },
          create: { artistId: artist.id, name: p.name, description: p.description, sharePct: p.sharePct, examplesJson: toJson(p.examples ?? []) },
          update: { description: p.description, sharePct: p.sharePct, examplesJson: toJson(p.examples ?? []) },
        });
        created.push({ id: pillar.id, name: pillar.name, sharePct: pillar.sharePct });
      }
      const total = input.pillars.reduce((s, p) => s + p.sharePct, 0);
      return { pillars: created, totalSharePct: total, warning: total < 90 || total > 110 ? `Shares total ${total}% — rebalance them.` : undefined };
    },
  }),

  defineTool({
    name: "content_create",
    group: "content",
    autonomy: "level1",
    description:
      "Create a content piece with a real hook, script, caption and CTA — not a topic placeholder. " +
      "Write it in the artist's voice from the brand profile: specific, scene-native, no marketing-speak, no generic AI phrasing. " +
      "The hook is the first 1–2 seconds of a video or the first line of a caption; it must earn attention on its own. Always state what has to be filmed or made in productionNotes.",
    schema: z.object({
      platform: z.enum(PLATFORMS),
      format: z.enum(CONTENT_FORMATS),
      title: z.string().min(3).describe("Internal working title"),
      hook: z.string().describe("The actual opening line or on-screen text"),
      script: z.string().optional().describe("Beat-by-beat for video: what is shown and said"),
      caption: z.string().optional(),
      cta: z.string().optional(),
      productionNotes: z.string().optional(),
      assetsNeeded: z.array(z.string()).optional(),
      pillarId: z.string().optional(),
      releaseId: z.string().optional(),
      campaignId: z.string().optional(),
      scheduledFor: dateStr.optional(),
      status: z.enum(CONTENT_STATUS).optional(),
    }),
    async execute({ assetsNeeded, scheduledFor, ...rest }) {
      const piece = await prisma.contentPiece.create({
        data: { ...rest, assetsNeededJson: toJson(assetsNeeded ?? []), scheduledFor: toDate(scheduledFor) },
      });
      return { id: piece.id, title: piece.title, platform: piece.platform, scheduledFor: piece.scheduledFor?.toISOString().slice(0, 10) ?? null };
    },
  }),

  defineTool({
    name: "content_plan_create",
    group: "content",
    autonomy: "level1",
    description:
      "Create a batch of content pieces as a calendar — the normal way to deliver a content plan. Each piece needs its own hook and caption; a calendar of topics without written hooks is not a plan. " +
      "Respect the operator's real capacity: a person with 8 hours a week cannot ship 20 videos.",
    schema: z.object({
      campaignId: z.string().optional(),
      releaseId: z.string().optional(),
      pieces: z.array(z.object({
        platform: z.enum(PLATFORMS),
        format: z.enum(CONTENT_FORMATS),
        title: z.string(),
        hook: z.string(),
        script: z.string().optional(),
        caption: z.string().optional(),
        cta: z.string().optional(),
        productionNotes: z.string().optional(),
        pillarId: z.string().optional(),
        scheduledFor: dateStr.optional(),
      })).min(1).max(40),
    }),
    async execute(input) {
      const created = [];
      for (const p of input.pieces) {
        const piece = await prisma.contentPiece.create({
          data: {
            ...p,
            campaignId: input.campaignId,
            releaseId: input.releaseId,
            scheduledFor: toDate(p.scheduledFor),
            status: "idea",
          },
        });
        created.push({ id: piece.id, title: piece.title, platform: piece.platform, scheduledFor: p.scheduledFor ?? null });
      }
      return { created: created.length, pieces: created };
    },
  }),

  defineTool({
    name: "content_list",
    group: "content",
    autonomy: "level1",
    readOnly: true,
    description: "List content pieces with their status, schedule and measured performance.",
    schema: z.object({
      status: z.enum(CONTENT_STATUS).optional(),
      platform: z.enum(PLATFORMS).optional(),
      upcomingOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute(input) {
      const pieces = await prisma.contentPiece.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.platform ? { platform: input.platform } : {}),
          ...(input.upcomingOnly ? { scheduledFor: { gte: new Date() } } : {}),
        },
        orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
        take: input.limit ?? 40,
        include: { performance: true, pillar: { select: { name: true } } },
      });
      return {
        count: pieces.length,
        pieces: pieces.map((p) => ({
          id: p.id,
          title: p.title,
          platform: p.platform,
          format: p.format,
          pillar: p.pillar?.name ?? null,
          status: p.status,
          hook: p.hook,
          caption: p.caption,
          scheduledFor: p.scheduledFor?.toISOString().slice(0, 10) ?? null,
          publishedAt: p.publishedAt?.toISOString().slice(0, 10) ?? null,
          url: p.url,
          performance: p.performance
            ? { views: p.performance.views, likes: p.performance.likes, saves: p.performance.saves, shares: p.performance.shares, followersGained: p.performance.followersGained }
            : null,
        })),
      };
    },
  }),

  defineTool({
    name: "content_update",
    group: "content",
    autonomy: "level1",
    description: "Update a content piece: change status, reschedule, attach the published URL, or revise the copy.",
    schema: z.object({
      id: z.string(),
      status: z.enum(CONTENT_STATUS).optional(),
      hook: z.string().optional(),
      script: z.string().optional(),
      caption: z.string().optional(),
      cta: z.string().optional(),
      scheduledFor: dateStr.optional(),
      publishedAt: dateStr.optional(),
      url: z.string().url().optional(),
    }),
    async execute({ id, scheduledFor, publishedAt, ...rest }) {
      const piece = await prisma.contentPiece.update({
        where: { id },
        data: { ...rest, scheduledFor: toDate(scheduledFor), publishedAt: toDate(publishedAt) },
      });
      return { id: piece.id, status: piece.status, url: piece.url };
    },
  }),

  defineTool({
    name: "content_performance_log",
    group: "content",
    autonomy: "level1",
    description:
      "Record measured performance for a published piece. Numbers come from the operator or a connected integration — never estimate them. This is the data the content engine learns from.",
    schema: z.object({
      pieceId: z.string(),
      views: z.number().int().min(0).optional(),
      likes: z.number().int().min(0).optional(),
      comments: z.number().int().min(0).optional(),
      shares: z.number().int().min(0).optional(),
      saves: z.number().int().min(0).optional(),
      watchTimeSec: z.number().int().min(0).optional(),
      followersGained: z.number().int().min(0).optional(),
      clicks: z.number().int().min(0).optional(),
      source: z.string().optional(),
    }),
    async execute(input) {
      const { pieceId, ...metrics } = input;
      const perf = await prisma.contentPerformance.upsert({
        where: { pieceId },
        create: { pieceId, ...metrics, measuredAt: new Date() },
        update: { ...metrics, measuredAt: new Date() },
      });
      return { id: perf.id, pieceId, recorded: Object.keys(metrics) };
    },
  }),

  defineTool({
    name: "content_performance_analysis",
    group: "content",
    autonomy: "level1",
    readOnly: true,
    description:
      "Analyse what content has actually worked: by platform, format and pillar, with sample sizes. " +
      "Use this before recommending a content direction — and report the sample size honestly, because three posts is a hint, not a finding.",
    schema: z.object({ sinceDays: z.number().int().min(7).max(365).optional() }),
    async execute(input) {
      const since = new Date(Date.now() - (input.sinceDays ?? 90) * 86_400_000);
      const pieces = await prisma.contentPiece.findMany({
        where: { publishedAt: { gte: since }, performance: { isNot: null } },
        include: { performance: true, pillar: { select: { name: true } } },
      });

      if (pieces.length === 0) {
        return {
          sampleSize: 0,
          note: "No published content with measured performance in this window. Nothing can be concluded about what works — log performance with content_performance_log first.",
        };
      }

      const bucket = (key: string, acc: Map<string, { n: number; views: number; engagement: number; followers: number }>, p: (typeof pieces)[number]) => {
        const cur = acc.get(key) ?? { n: 0, views: 0, engagement: 0, followers: 0 };
        cur.n++;
        cur.views += p.performance?.views ?? 0;
        cur.engagement += (p.performance?.likes ?? 0) + (p.performance?.comments ?? 0) + (p.performance?.shares ?? 0) + (p.performance?.saves ?? 0);
        cur.followers += p.performance?.followersGained ?? 0;
        acc.set(key, cur);
      };

      const byFormat = new Map<string, { n: number; views: number; engagement: number; followers: number }>();
      const byPlatform = new Map<string, { n: number; views: number; engagement: number; followers: number }>();
      const byPillar = new Map<string, { n: number; views: number; engagement: number; followers: number }>();
      for (const p of pieces) {
        bucket(p.format, byFormat, p);
        bucket(p.platform, byPlatform, p);
        bucket(p.pillar?.name ?? "unassigned", byPillar, p);
      }

      const shape = (m: Map<string, { n: number; views: number; engagement: number; followers: number }>) =>
        [...m.entries()]
          .map(([key, v]) => ({
            key,
            posts: v.n,
            avgViews: Math.round(v.views / v.n),
            avgEngagement: Math.round(v.engagement / v.n),
            engagementRate: v.views ? Number(((v.engagement / v.views) * 100).toFixed(2)) : null,
            followersGained: v.followers,
            reliability: v.n >= 8 ? "usable" : v.n >= 4 ? "weak" : "anecdotal",
          }))
          .sort((a, b) => b.avgViews - a.avgViews);

      const top = [...pieces]
        .sort((a, b) => (b.performance?.views ?? 0) - (a.performance?.views ?? 0))
        .slice(0, 5)
        .map((p) => ({ id: p.id, title: p.title, platform: p.platform, format: p.format, views: p.performance?.views, hook: p.hook }));

      return {
        sampleSize: pieces.length,
        windowDays: input.sinceDays ?? 90,
        byPlatform: shape(byPlatform),
        byFormat: shape(byFormat),
        byPillar: shape(byPillar),
        topPieces: top,
        caution: "Buckets marked 'anecdotal' or 'weak' have too few posts to justify a strategy change. Say so when you report them.",
      };
    },
  }),

  defineTool({
    name: "content_publish",
    group: "content",
    autonomy: "level2",
    description:
      "Request approval to publish a content piece to a connected platform. Creates an approval request; nothing goes live without it. If no publishing integration is connected, it returns the finished copy for the operator to post.",
    schema: z.object({ pieceId: z.string(), platform: z.enum(PLATFORMS) }),
    async preview(input) {
      const piece = await prisma.contentPiece.findUnique({ where: { id: input.pieceId } });
      if (!piece) return { title: "Publish content", description: "Piece not found.", details: [] };
      return {
        title: `Publish "${piece.title}" to ${input.platform}`,
        description: "This posts publicly under the artist's name.",
        details: [
          `Format: ${piece.format}`,
          `Hook: ${piece.hook ?? "—"}`,
          `Caption: ${piece.caption ?? "—"}`,
          `CTA: ${piece.cta ?? "—"}`,
        ],
        riskNotes: "Published posts shape the brand and are visible to labels and promoters. Read the copy before approving.",
      };
    },
    async execute(input) {
      const integration = await prisma.integration.findFirst({ where: { key: input.platform, status: "configured" } });
      const piece = await prisma.contentPiece.findUnique({ where: { id: input.pieceId } });
      if (!piece) return { error: "Piece not found." };

      if (!integration) {
        await prisma.contentPiece.update({ where: { id: piece.id }, data: { status: "ready" } });
        return {
          published: false,
          status: "approved_awaiting_manual_post",
          message: `No ${input.platform} publishing integration is connected, so YUVIX OS cannot post this. The copy below is approved and ready — post it yourself, then call content_update with the URL.`,
          copy: { hook: piece.hook, caption: piece.caption, cta: piece.cta, script: piece.script },
        };
      }
      // A configured integration would perform the actual publish here.
      return { published: false, error: `The ${input.platform} integration is registered but publishing is not implemented for it yet.` };
    },
  }),
];
