import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { parseList, parseObject, toJson } from "@/server/db/json";
import { RELEASE_STATUS, RELEASE_TYPE, TRACK_STATUS } from "@/server/domain/constants";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toDate = (s?: string) => (s ? new Date(`${s}T12:00:00.000Z`) : undefined);

export const musicTools = [
  defineTool({
    name: "track_upsert",
    group: "music",
    autonomy: "level1",
    description:
      "Create or update a track (released or unreleased). Pass `id` to update an existing one. " +
      "Record only what you actually know — leave BPM, key and ISRC out rather than guessing them. Audio analysis can fill in BPM and key later.",
    schema: z.object({
      id: z.string().optional(),
      title: z.string().min(1),
      artistCredit: z.string().optional(),
      version: z.enum(["original", "remix", "edit", "vip", "bootleg"]).optional(),
      genre: z.string().optional(),
      subgenre: z.string().optional(),
      bpm: z.number().min(40).max(300).optional(),
      musicalKey: z.string().optional(),
      durationSec: z.number().int().min(1).optional(),
      status: z.enum(TRACK_STATUS).optional(),
      collaborators: z.array(z.string()).optional(),
      labelTargets: z.array(z.string()).optional(),
      releaseStrategy: z.string().optional(),
      notes: z.string().optional(),
      isrc: z.string().optional(),
      deadline: dateStr.optional(),
    }),
    async execute({ id, collaborators, labelTargets, deadline, ...rest }) {
      const data = {
        ...rest,
        ...(collaborators ? { collaboratorsJson: toJson(collaborators) } : {}),
        ...(labelTargets ? { labelTargetsJson: toJson(labelTargets) } : {}),
        ...(deadline ? { deadline: toDate(deadline) } : {}),
      };
      const track = id
        ? await prisma.track.update({ where: { id }, data })
        : await prisma.track.create({ data });
      return { id: track.id, title: track.title, status: track.status, created: !id };
    },
  }),

  defineTool({
    name: "track_list",
    group: "music",
    autonomy: "level1",
    readOnly: true,
    description: "List tracks with their status, metadata and analysis history. Use status filters to find what is unreleased, ready to pitch, or stuck in mixdown.",
    schema: z.object({
      status: z.enum(TRACK_STATUS).optional(),
      unreleasedOnly: z.boolean().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute(input) {
      const tracks = await prisma.track.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.unreleasedOnly ? { status: { notIn: ["released", "shelved"] } } : {}),
          ...(input.query ? { title: { contains: input.query } } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit ?? 40,
        include: {
          releases: { select: { id: true, title: true, releaseDate: true, status: true } },
          analyses: { select: { id: true, createdAt: true, lufsIntegrated: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
      return {
        count: tracks.length,
        tracks: tracks.map((t) => ({
          id: t.id,
          title: t.title,
          artistCredit: t.artistCredit,
          version: t.version,
          status: t.status,
          genre: t.genre,
          bpm: t.bpm,
          key: t.musicalKey,
          collaborators: parseList(t.collaboratorsJson),
          labelTargets: parseList(t.labelTargetsJson),
          deadline: t.deadline?.toISOString().slice(0, 10) ?? null,
          notes: t.notes,
          releases: t.releases.map((r) => ({ id: r.id, title: r.title, date: r.releaseDate?.toISOString().slice(0, 10) ?? null, status: r.status })),
          lastAnalysis: t.analyses[0] ? { id: t.analyses[0].id, lufs: t.analyses[0].lufsIntegrated } : null,
        })),
      };
    },
  }),

  defineTool({
    name: "release_upsert",
    group: "music",
    autonomy: "level1",
    description:
      "Create or update a release (single/EP/album/remix). This is the anchor for campaigns, playlist placements and DJ support. " +
      "Setting a releaseDate is what lets the campaign engine build a working-back timeline.",
    schema: z.object({
      id: z.string().optional(),
      title: z.string().min(1),
      trackId: z.string().optional(),
      type: z.enum(RELEASE_TYPE).optional(),
      labelId: z.string().optional(),
      labelName: z.string().optional().describe("Use when the label has no record yet, or the release is self-released"),
      distributor: z.string().optional(),
      releaseDate: dateStr.optional(),
      announceDate: dateStr.optional(),
      status: z.enum(RELEASE_STATUS).optional(),
      isrc: z.string().optional(),
      upc: z.string().optional(),
      links: z.record(z.string()).optional().describe("e.g. { spotify, beatport, presave, soundcloud }"),
      splits: z.array(z.object({ name: z.string(), role: z.string(), percent: z.number() })).optional(),
      budgetEur: z.number().min(0).optional(),
      notes: z.string().optional(),
    }),
    async execute({ id, releaseDate, announceDate, links, splits, ...rest }) {
      const data = {
        ...rest,
        ...(releaseDate ? { releaseDate: toDate(releaseDate) } : {}),
        ...(announceDate ? { announceDate: toDate(announceDate) } : {}),
        ...(links ? { linksJson: toJson(links) } : {}),
        ...(splits ? { splitsJson: toJson(splits) } : {}),
      };
      const release = id
        ? await prisma.release.update({ where: { id }, data })
        : await prisma.release.create({ data });
      return {
        id: release.id,
        title: release.title,
        releaseDate: release.releaseDate?.toISOString().slice(0, 10) ?? null,
        status: release.status,
        created: !id,
        hint: !id && release.releaseDate ? "Call campaign_generate with this releaseId to build the campaign timeline." : undefined,
      };
    },
  }),

  defineTool({
    name: "release_list",
    group: "music",
    autonomy: "level1",
    readOnly: true,
    description: "List releases with campaign status, playlist placements, DJ support and any recorded performance metrics.",
    schema: z.object({
      status: z.enum(RELEASE_STATUS).optional(),
      upcomingOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute(input) {
      const releases = await prisma.release.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.upcomingOnly ? { releaseDate: { gte: new Date() } } : {}),
        },
        orderBy: { releaseDate: "desc" },
        take: input.limit ?? 25,
        include: {
          campaigns: { select: { id: true, name: true, status: true } },
          supports: { select: { djName: true, weight: true, context: true } },
          placements: { select: { playlistName: true, platform: true, followers: true } },
          label: { select: { id: true, name: true, status: true } },
        },
      });
      const ids = releases.map((r) => r.id);
      const metrics = ids.length
        ? await prisma.metric.findMany({ where: { entityType: "release", entityId: { in: ids } }, orderBy: { periodEnd: "desc" } })
        : [];
      return {
        count: releases.length,
        releases: releases.map((r) => ({
          id: r.id,
          title: r.title,
          type: r.type,
          status: r.status,
          releaseDate: r.releaseDate?.toISOString().slice(0, 10) ?? null,
          label: r.label?.name ?? r.labelName ?? "self-released",
          distributor: r.distributor,
          links: parseObject<Record<string, string>>(r.linksJson, {}),
          budgetEur: r.budgetEur,
          campaign: r.campaigns[0] ?? null,
          djSupport: r.supports,
          playlists: r.placements,
          metrics: metrics.filter((m) => m.entityId === r.id).map((m) => ({ metric: m.metric, value: m.value, asOf: m.periodEnd.toISOString().slice(0, 10) })),
        })),
      };
    },
  }),

  defineTool({
    name: "dj_support_log",
    group: "music",
    autonomy: "level1",
    description:
      "Record that a DJ played or supported a release, with evidence (a tracklist link, a radio show, a message). Weight 1–5 by how meaningful the support is. " +
      "This is how the system learns which relationships actually convert.",
    schema: z.object({
      releaseId: z.string(),
      djName: z.string(),
      contactId: z.string().optional(),
      context: z.string().optional().describe("Radio show, festival set, chart, private feedback"),
      evidenceUrl: z.string().url().optional(),
      date: dateStr.optional(),
      weight: z.number().int().min(1).max(5).optional(),
      notes: z.string().optional(),
    }),
    async execute({ date, ...rest }) {
      const support = await prisma.djSupport.create({ data: { ...rest, date: toDate(date) } });
      return { id: support.id, djName: support.djName, releaseId: support.releaseId };
    },
  }),

  defineTool({
    name: "playlist_placement_log",
    group: "music",
    autonomy: "level1",
    description: "Record a playlist placement with follower count and, if known, streams attributed to it. Use removedAt when a track drops off.",
    schema: z.object({
      releaseId: z.string().optional(),
      platform: z.string().optional(),
      playlistName: z.string(),
      curator: z.string().optional(),
      followers: z.number().int().min(0).optional(),
      url: z.string().url().optional(),
      addedAt: dateStr.optional(),
      removedAt: dateStr.optional(),
      streamsFrom: z.number().int().min(0).optional(),
      notes: z.string().optional(),
    }),
    async execute({ addedAt, removedAt, ...rest }) {
      const placement = await prisma.playlistPlacement.create({
        data: { ...rest, addedAt: toDate(addedAt), removedAt: toDate(removedAt) },
      });
      return { id: placement.id, playlistName: placement.playlistName };
    },
  }),

  defineTool({
    name: "label_upsert",
    group: "music",
    autonomy: "level1",
    description:
      "Create or update a label record. Populate submission method, policy and roster ONLY from research you actually performed — a wrong submission address wastes a real opportunity. " +
      "Always fill fitRationale explaining the fitScore; a score without reasoning is noise. Cite sources.",
    schema: z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      country: z.string().optional(),
      genres: z.array(z.string()).optional(),
      roster: z.array(z.string()).optional(),
      website: z.string().url().optional(),
      submissionMethod: z.string().optional(),
      submissionUrl: z.string().url().optional(),
      submissionEmail: z.string().email().optional(),
      submissionPolicy: z.string().optional(),
      recentReleases: z.array(z.string()).optional(),
      audienceNotes: z.string().optional(),
      fitScore: z.number().min(0).max(100).optional(),
      fitRationale: z.string().optional(),
      tier: z.enum(["major", "established", "mid", "boutique", "new"]).optional(),
      status: z.string().optional(),
      notes: z.string().optional(),
      sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).optional(),
      nextAction: z.string().optional(),
      nextActionAt: dateStr.optional(),
    }),
    async execute({ id, genres, roster, recentReleases, sources, nextActionAt, ...rest }) {
      const data = {
        ...rest,
        ...(genres ? { genresJson: toJson(genres) } : {}),
        ...(roster ? { rosterJson: toJson(roster) } : {}),
        ...(recentReleases ? { recentReleasesJson: toJson(recentReleases) } : {}),
        ...(sources ? { sourcesJson: toJson(sources.map((s) => ({ ...s, fetchedAt: new Date().toISOString() }))) } : {}),
        ...(nextActionAt ? { nextActionAt: toDate(nextActionAt) } : {}),
      };
      const label = id
        ? await prisma.label.update({ where: { id }, data })
        : await prisma.label.upsert({ where: { name: rest.name }, create: data, update: data });
      return { id: label.id, name: label.name, status: label.status, fitScore: label.fitScore };
    },
  }),

  defineTool({
    name: "label_list",
    group: "music",
    autonomy: "level1",
    readOnly: true,
    description: "List labels in the pipeline, ranked by fit, with submission details and interaction history. Use before any demo-submission planning.",
    schema: z.object({
      status: z.string().optional(),
      minFit: z.number().min(0).max(100).optional(),
      limit: z.number().int().min(1).max(60).optional(),
    }),
    async execute(input) {
      const labels = await prisma.label.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.minFit != null ? { fitScore: { gte: input.minFit } } : {}),
        },
        orderBy: [{ fitScore: "desc" }, { name: "asc" }],
        take: input.limit ?? 30,
        include: { interactions: { orderBy: { occurredAt: "desc" }, take: 3 }, contacts: { select: { id: true, name: true, role: true, email: true } } },
      });
      return {
        count: labels.length,
        labels: labels.map((l) => ({
          id: l.id,
          name: l.name,
          country: l.country,
          tier: l.tier,
          genres: parseList(l.genresJson),
          roster: parseList(l.rosterJson).slice(0, 8),
          fitScore: l.fitScore,
          fitRationale: l.fitRationale,
          status: l.status,
          submission: { method: l.submissionMethod, url: l.submissionUrl, email: l.submissionEmail, policy: l.submissionPolicy },
          lastContactAt: l.lastContactAt?.toISOString().slice(0, 10) ?? null,
          nextAction: l.nextAction,
          contacts: l.contacts,
          recentInteractions: l.interactions.map((i) => ({ direction: i.direction, channel: i.channel, outcome: i.outcome, at: i.occurredAt.toISOString().slice(0, 10) })),
          sources: parseList(l.sourcesJson),
        })),
      };
    },
  }),
];
