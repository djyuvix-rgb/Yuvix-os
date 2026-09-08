import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { memory } from "@/server/memory/store";
import { prisma } from "@/server/db/client";
import { parseList, toJson } from "@/server/db/json";
import { MEMORY_KINDS, MEMORY_LAYERS } from "@/server/domain/constants";

const layerEnum = z.enum(MEMORY_LAYERS);
const kindEnum = z.enum(MEMORY_KINDS);

export const memoryTools = [
  defineTool({
    name: "memory_remember",
    group: "memory",
    autonomy: "level1",
    description:
      "Store something worth remembering long-term: a preference, a lesson from a campaign, a decision's context, a research conclusion, an important fact the operator told you. " +
      "Use kind='fact' only for things the operator stated or a tool measured; use kind='assumption' for your own inference and say what it rests on in the content. " +
      "Do NOT use this for data that belongs in a real record (a release, contact, task, finance entry) — create the record instead.",
    schema: z.object({
      layer: layerEnum.describe("Which memory layer this belongs to"),
      kind: kindEnum,
      title: z.string().min(3).max(200).describe("Short retrievable label"),
      content: z.string().min(3).max(4000),
      confidence: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).max(10).optional(),
      sourceUrl: z.string().url().optional(),
      entityType: z.string().optional().describe("e.g. Release, Contact, Campaign"),
      entityId: z.string().optional(),
      supersedeSameTitle: z.boolean().optional().describe("Archive any existing memory with this exact title first"),
    }),
    async execute(input) {
      const item = await memory.remember({ ...input, source: "agent" });
      return { id: item.id, stored: true, layer: item.layer, kind: item.kind, title: item.title };
    },
  }),

  defineTool({
    name: "memory_recall",
    group: "memory",
    autonomy: "level1",
    readOnly: true,
    description:
      "Search long-term memory for anything previously stored — past decisions, campaign lessons, operator preferences, research conclusions. " +
      "Call this before answering 'what did we decide about X', 'why did we choose Y', or 'what worked last time'.",
    schema: z.object({
      query: z.string().min(2),
      layers: z.array(layerEnum).optional(),
      kinds: z.array(kindEnum).optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    async execute(input) {
      const results = await memory.recall(input.query, input);
      return {
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          layer: r.layer,
          kind: r.kind,
          title: r.title,
          content: r.content,
          confidence: r.confidence,
          source: r.source,
          sourceUrl: r.sourceUrl,
          storedAt: r.createdAt.toISOString().slice(0, 10),
          relevance: r.score,
        })),
        note: results.length ? undefined : "Nothing in memory matches. Do not fabricate history — say you have no record of it.",
      };
    },
  }),

  defineTool({
    name: "memory_update",
    group: "memory",
    autonomy: "level1",
    description:
      "Correct or replace an existing memory. The old version is archived rather than deleted, so the change is auditable. Use when the operator corrects you or new evidence supersedes a stored belief.",
    schema: z.object({
      id: z.string(),
      layer: layerEnum,
      kind: kindEnum,
      title: z.string().min(3).max(200),
      content: z.string().min(3).max(4000),
      confidence: z.number().min(0).max(1).optional(),
      reason: z.string().describe("Why this changed"),
    }),
    async execute(input) {
      const created = await memory.update(input.id, { ...input, source: "agent" });
      return { supersededId: input.id, newId: created.id, reason: input.reason };
    },
  }),

  defineTool({
    name: "memory_list",
    group: "memory",
    autonomy: "level1",
    readOnly: true,
    description: "Browse stored memories by layer, without a search query. Useful for auditing what the system believes.",
    schema: z.object({
      layer: layerEnum.optional(),
      kind: kindEnum.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute(input) {
      const items = await prisma.memoryItem.findMany({
        where: {
          isArchived: false,
          ...(input.layer ? { layer: input.layer } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit ?? 30,
      });
      return {
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          layer: i.layer,
          kind: i.kind,
          title: i.title,
          content: i.content.slice(0, 500),
          confidence: i.confidence,
          tags: parseList(i.tagsJson),
          usedTimes: i.useCount,
        })),
      };
    },
  }),

  defineTool({
    name: "memory_forget",
    group: "memory",
    autonomy: "level2",
    description: "Archive a memory so it stops influencing decisions. Requires approval because losing context is hard to undo.",
    schema: z.object({ id: z.string(), reason: z.string().min(3) }),
    async preview(input) {
      const item = await prisma.memoryItem.findUnique({ where: { id: input.id } });
      return {
        title: "Archive a memory",
        description: item ? `"${item.title}" will stop being used in decisions.` : "Memory not found.",
        details: [
          `Layer: ${item?.layer ?? "?"} / ${item?.kind ?? "?"}`,
          `Content: ${item?.content.slice(0, 300) ?? "—"}`,
          `Reason: ${input.reason}`,
        ],
        riskNotes: "Archived memories are recoverable in the database but the agent will no longer surface them.",
      };
    },
    async execute(input) {
      await memory.forget(input.id, input.reason);
      return { archived: true, id: input.id };
    },
  }),

  defineTool({
    name: "artist_profile_get",
    group: "memory",
    autonomy: "level1",
    readOnly: true,
    description:
      "Read the full artist and brand profile: identity, genres, sound, story, positioning, audience, bios, tone of voice, brand keywords, content pillars, social accounts, capacity and budget. " +
      "Call this before writing ANY external-facing copy (bio, caption, pitch, outreach) so the output is in the artist's voice rather than generic.",
    schema: z.object({}),
    async execute() {
      const artist = await prisma.artistProfile.findFirst({
        include: { socialAccounts: true, contentPillars: true },
      });
      if (!artist) {
        return {
          exists: false,
          note: "No artist profile exists yet. Ask the operator for artist name, genres, sound, positioning, audience, weekly hours and monthly budget, then call artist_profile_update. Do not invent these.",
        };
      }
      return {
        exists: true,
        artistName: artist.artistName,
        realName: artist.realName,
        tagline: artist.tagline,
        base: [artist.homeCity, artist.country].filter(Boolean).join(", "),
        genres: parseList(artist.genresJson),
        sound: parseList(artist.soundJson),
        influences: parseList(artist.influencesJson),
        story: artist.story,
        positioning: artist.positioning,
        targetAudience: artist.targetAudience,
        toneOfVoice: artist.toneOfVoice,
        visualIdentity: artist.visualIdentity,
        visualReferences: parseList(artist.visualReferencesJson),
        brandKeywords: parseList(artist.brandKeywordsJson),
        messaging: parseList(artist.messagingJson),
        bios: { short: artist.shortBio, long: artist.longBio, press: artist.pressBio },
        capacity: { weeklyHours: artist.weeklyHours, monthlyBudgetEur: artist.monthlyBudgetEur },
        contentPillars: artist.contentPillars.map((p) => ({ name: p.name, sharePct: p.sharePct, description: p.description })),
        accounts: artist.socialAccounts.map((a) => ({
          platform: a.platform,
          handle: a.handle,
          url: a.url,
          followers: a.followers,
          monthlyListeners: a.monthlyListeners,
        })),
      };
    },
  }),

  defineTool({
    name: "artist_profile_update",
    group: "memory",
    autonomy: "level1",
    description:
      "Create or update the artist/brand profile. Only pass fields you actually learned from the operator or verified research — omitted fields are left untouched. Never fill this in from imagination.",
    schema: z.object({
      artistName: z.string().optional(),
      realName: z.string().optional(),
      tagline: z.string().optional(),
      homeCity: z.string().optional(),
      country: z.string().optional(),
      genres: z.array(z.string()).optional(),
      sound: z.array(z.string()).optional(),
      influences: z.array(z.string()).optional(),
      story: z.string().optional(),
      positioning: z.string().optional(),
      targetAudience: z.string().optional(),
      shortBio: z.string().optional(),
      longBio: z.string().optional(),
      pressBio: z.string().optional(),
      toneOfVoice: z.string().optional(),
      visualIdentity: z.string().optional(),
      visualReferences: z.array(z.string()).optional(),
      brandKeywords: z.array(z.string()).optional(),
      messaging: z.array(z.string()).optional(),
      weeklyHours: z.number().int().min(0).max(100).optional(),
      monthlyBudgetEur: z.number().min(0).optional(),
      resources: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
    async execute(input) {
      const existing = await prisma.artistProfile.findFirst();
      const data: Record<string, unknown> = {};
      const map: [keyof typeof input, string][] = [
        ["artistName", "artistName"], ["realName", "realName"], ["tagline", "tagline"],
        ["homeCity", "homeCity"], ["country", "country"], ["story", "story"],
        ["positioning", "positioning"], ["targetAudience", "targetAudience"],
        ["shortBio", "shortBio"], ["longBio", "longBio"], ["pressBio", "pressBio"],
        ["toneOfVoice", "toneOfVoice"], ["visualIdentity", "visualIdentity"],
        ["weeklyHours", "weeklyHours"], ["monthlyBudgetEur", "monthlyBudgetEur"],
      ];
      for (const [key, column] of map) if (input[key] !== undefined) data[column] = input[key];
      if (input.genres) data.genresJson = toJson(input.genres);
      if (input.sound) data.soundJson = toJson(input.sound);
      if (input.influences) data.influencesJson = toJson(input.influences);
      if (input.visualReferences) data.visualReferencesJson = toJson(input.visualReferences);
      if (input.brandKeywords) data.brandKeywordsJson = toJson(input.brandKeywords);
      if (input.messaging) data.messagingJson = toJson(input.messaging);
      if (input.resources) data.resourcesJson = toJson(input.resources);

      if (existing) {
        const updated = await prisma.artistProfile.update({ where: { id: existing.id }, data });
        return { id: updated.id, created: false, updatedFields: Object.keys(data) };
      }
      if (!input.artistName) {
        return { error: "No profile exists yet, so artistName is required to create one." };
      }
      const created = await prisma.artistProfile.create({
        data: { artistName: input.artistName, ...data } as never,
      });
      return { id: created.id, created: true, updatedFields: Object.keys(data) };
    },
  }),

  defineTool({
    name: "social_account_upsert",
    group: "memory",
    autonomy: "level1",
    description:
      "Record or update one of the artist's platform accounts, including follower or monthly-listener counts the operator gives you. " +
      "These numbers are operator-reported unless an integration supplied them — treat them as a point-in-time snapshot, not live data.",
    schema: z.object({
      platform: z.string(),
      handle: z.string(),
      url: z.string().url().optional(),
      followers: z.number().int().min(0).optional(),
      monthlyListeners: z.number().int().min(0).optional(),
      isPrimary: z.boolean().optional(),
      notes: z.string().optional(),
    }),
    async execute(input) {
      const artist = await prisma.artistProfile.findFirst();
      if (!artist) return { error: "Create the artist profile first with artist_profile_update." };
      const account = await prisma.socialAccount.upsert({
        where: { artistId_platform_handle: { artistId: artist.id, platform: input.platform, handle: input.handle } },
        create: { artistId: artist.id, ...input },
        update: { ...input, lastSyncedAt: new Date() },
      });
      // Follower counts are also a metric, so growth is chartable over time.
      if (input.followers != null || input.monthlyListeners != null) {
        const now = new Date();
        await prisma.metric.create({
          data: {
            platform: input.platform,
            metric: input.monthlyListeners != null ? "monthly_listeners" : "followers",
            value: input.monthlyListeners ?? input.followers ?? 0,
            entityType: "account",
            entityId: account.id,
            periodStart: now,
            periodEnd: now,
            source: "manual",
          },
        });
      }
      return { id: account.id, platform: account.platform, handle: account.handle };
    },
  }),
];
