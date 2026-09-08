import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { parseArray, parseObject, toJson } from "@/server/db/json";
import { currentResources, generateCampaign } from "@/server/campaign/generator";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const campaignTools = [
  defineTool({
    name: "campaign_generate",
    group: "campaign",
    autonomy: "level1",
    description:
      "Build a complete release campaign for a release: phased timeline (foundation → build → amplify → launch → sustain), a project, and dated tasks working backwards from the release date. " +
      "It adapts to the artist's real capacity and budget and tells you what it dropped and why. Run this the moment a release gets a date. " +
      "After generating, add the campaign-specific content pieces with content_plan_create and the label/DJ targets with the CRM tools — the engine builds the skeleton, you supply the judgement.",
    schema: z.object({
      releaseId: z.string(),
      releaseDate: dateStr.optional().describe("Overrides the release's stored date"),
      budgetEur: z.number().min(0).optional(),
      hasArtwork: z.boolean().optional(),
      hasVideoCapability: z.boolean().optional(),
      createTasks: z.boolean().optional(),
    }),
    async execute(input) {
      const release = await prisma.release.findUnique({ where: { id: input.releaseId } });
      if (!release) return { error: `Release ${input.releaseId} not found.` };

      const date = input.releaseDate ? new Date(`${input.releaseDate}T12:00:00.000Z`) : release.releaseDate;
      if (!date) return { error: "This release has no date. Set one with release_upsert first — the whole campaign is derived from it." };

      const resources = await currentResources({
        ...(input.budgetEur != null ? { monthlyBudgetEur: input.budgetEur } : {}),
        ...(input.hasArtwork != null ? { hasArtwork: input.hasArtwork } : {}),
        ...(input.hasVideoCapability != null ? { hasVideoCapability: input.hasVideoCapability } : {}),
      });

      const result = await generateCampaign({
        releaseId: release.id,
        releaseDate: date,
        resources,
        createTasks: input.createTasks !== false,
      });

      if (input.releaseDate && release.releaseDate?.getTime() !== date.getTime()) {
        await prisma.release.update({ where: { id: release.id }, data: { releaseDate: date, status: "scheduled" } });
      }

      return {
        ...result,
        resourcesUsed: resources,
        nextSteps: [
          "Write the actual content pieces for this campaign with content_plan_create — the tasks say what to post, not what it says.",
          "Build the DJ/curator promo list in the CRM with a specific reason per name.",
          "If a label is involved, confirm their delivery deadline; it overrides the generated dates.",
        ],
      };
    },
  }),

  defineTool({
    name: "campaign_status",
    group: "campaign",
    autonomy: "level1",
    readOnly: true,
    description: "Read a campaign's stages, task progress, attached content and spend, so you can see whether it is actually on track rather than assuming.",
    schema: z.object({ campaignId: z.string().optional(), releaseId: z.string().optional() }),
    async execute(input) {
      const campaign = await prisma.campaign.findFirst({
        where: { ...(input.campaignId ? { id: input.campaignId } : {}), ...(input.releaseId ? { releaseId: input.releaseId } : {}) },
        orderBy: { createdAt: "desc" },
        include: { stages: { orderBy: { orderIndex: "asc" } }, release: true, project: { include: { tasks: true } } },
      });
      if (!campaign) return { found: false, note: "No campaign exists for this release." };

      const tasks = campaign.project?.tasks ?? [];
      const done = tasks.filter((t) => t.status === "done");
      const overdue = tasks.filter((t) => t.status !== "done" && t.dueDate && t.dueDate < new Date());
      const spend = await prisma.financeEntry.aggregate({
        where: { campaignId: campaign.id, direction: "expense" },
        _sum: { amountEur: true },
      });

      return {
        found: true,
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        release: campaign.release ? { id: campaign.release.id, title: campaign.release.title, date: campaign.release.releaseDate?.toISOString().slice(0, 10) } : null,
        objective: parseObject<Record<string, unknown>>(campaign.objectiveJson, {}),
        stages: campaign.stages.map((s) => ({ name: s.name, phase: s.phase, start: s.startDate?.toISOString().slice(0, 10), end: s.endDate?.toISOString().slice(0, 10), status: s.status })),
        progress: {
          tasksTotal: tasks.length,
          tasksDone: done.length,
          pct: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0,
          overdue: overdue.length,
          overdueTitles: overdue.slice(0, 5).map((t) => t.title),
        },
        budgetEur: campaign.budgetEur,
        spentEur: spend._sum.amountEur ?? 0,
      };
    },
  }),

  defineTool({
    name: "campaign_retro",
    group: "campaign",
    autonomy: "level1",
    description:
      "Close a campaign with a written retro: what the results actually were, what worked, what did not, and what changes next time. " +
      "Store the durable lessons in memory too — the point of a retro is that release N+1 is better than release N.",
    schema: z.object({
      campaignId: z.string(),
      results: z.record(z.union([z.string(), z.number()])).describe("Measured outcomes only, e.g. { first_week_streams: 4200, playlist_adds: 3 }"),
      whatWorked: z.array(z.string()),
      whatDidNot: z.array(z.string()),
      changeNextTime: z.array(z.string()),
    }),
    async execute(input) {
      const campaign = await prisma.campaign.update({
        where: { id: input.campaignId },
        data: {
          status: "done",
          resultJson: toJson(input.results),
          retroNotes: [
            `Worked: ${input.whatWorked.join("; ")}`,
            `Did not: ${input.whatDidNot.join("; ")}`,
            `Change: ${input.changeNextTime.join("; ")}`,
          ].join("\n"),
        },
      });
      return {
        id: campaign.id,
        closed: true,
        reminder: "Store the transferable lessons with memory_remember (layer 'campaign', kind 'lesson') so they surface during the next release.",
      };
    },
  }),

  defineTool({
    name: "campaign_list",
    group: "campaign",
    autonomy: "level1",
    readOnly: true,
    description: "List campaigns with their results and retro notes — the record of what has been tried before.",
    schema: z.object({ status: z.string().optional() }),
    async execute(input) {
      const campaigns = await prisma.campaign.findMany({
        where: input.status ? { status: input.status } : {},
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { release: { select: { title: true, releaseDate: true } } },
      });
      return {
        count: campaigns.length,
        campaigns: campaigns.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          status: c.status,
          release: c.release?.title ?? null,
          releaseDate: c.release?.releaseDate?.toISOString().slice(0, 10) ?? null,
          budgetEur: c.budgetEur,
          results: parseObject<Record<string, unknown>>(c.resultJson, {}),
          retro: c.retroNotes,
        })),
      };
    },
  }),

  defineTool({
    name: "campaign_stage_update",
    group: "campaign",
    autonomy: "level1",
    description: "Mark a campaign stage as running, done or blocked, so campaign_status reflects reality.",
    schema: z.object({ stageId: z.string(), status: z.enum(["planned", "running", "done", "blocked"]) }),
    async execute(input) {
      const stage = await prisma.campaignStage.update({ where: { id: input.stageId }, data: { status: input.status } });
      return { id: stage.id, name: stage.name, status: stage.status };
    },
  }),
];

export const campaignHelpers = { parseArray };
