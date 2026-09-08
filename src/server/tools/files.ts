import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { toJson } from "@/server/db/json";
import {
  ensureWorkspace, listWorkspace, moveWorkspaceFile, readWorkspaceFile,
  WORKSPACE_TREE, writeWorkspaceFile,
} from "@/server/files/workspace";

export const fileTools = [
  defineTool({
    name: "workspace_list",
    group: "files",
    autonomy: "level1",
    readOnly: true,
    description:
      "List files in the YUVIX OS workspace. The tree is Artist, Music (Released/Unreleased/Stems/Masters), Artwork, Marketing, Campaigns, Contacts, Contracts, Analytics, Finance, Research, Strategy. " +
      "Use this before writing a file so you put it where it belongs and do not duplicate something that already exists.",
    schema: z.object({
      directory: z.string().optional().describe("Workspace-relative, e.g. 'Music/Unreleased'"),
      recursive: z.boolean().optional(),
    }),
    async execute(input) {
      await ensureWorkspace();
      const entries = await listWorkspace(input.directory ?? "", input.recursive ?? false);
      return {
        root: input.directory ?? "/",
        tree: WORKSPACE_TREE,
        count: entries.length,
        entries: entries.map((e) => ({
          path: e.path,
          type: e.isDirectory ? "dir" : "file",
          sizeKb: e.isDirectory ? null : Math.round(e.sizeBytes / 1024),
          modified: e.modifiedAt.slice(0, 10),
          category: e.category,
        })),
      };
    },
  }),

  defineTool({
    name: "workspace_read",
    group: "files",
    autonomy: "level1",
    readOnly: true,
    description:
      "Read a text file from the workspace: a CSV analytics export, a contract in text form, notes, a strategy document. Binary files (audio, images, PDFs) return metadata only — use audio_analyze for audio.",
    schema: z.object({ path: z.string(), maxChars: z.number().int().min(500).max(80_000).optional() }),
    async execute(input) {
      return readWorkspaceFile(input.path, input.maxChars ?? 40_000);
    },
  }),

  defineTool({
    name: "workspace_write",
    group: "files",
    autonomy: "level1",
    description:
      "Write a text document into the workspace — a strategy doc, campaign brief, research summary, press release, outreach template pack. " +
      "Put it in the right folder (Strategy/, Campaigns/, Research/, Marketing/) and use a dated, descriptive filename. Check workspace_list first so you extend an existing document instead of creating a near-duplicate.",
    schema: z.object({
      path: z.string().describe("Workspace-relative path including extension, e.g. 'Strategy/2026-Q1-growth-plan.md'"),
      content: z.string().min(1),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    async execute(input) {
      const result = await writeWorkspaceFile(input.path, input.content);
      if (input.description || input.tags) {
        await prisma.fileAsset.update({
          where: { path: input.path },
          data: { description: input.description, tagsJson: toJson(input.tags ?? []) },
        }).catch(() => undefined);
      }
      return { ...result, written: true };
    },
  }),

  defineTool({
    name: "workspace_organize",
    group: "files",
    autonomy: "level2",
    description:
      "Move a file to a different place in the workspace. Requires approval because moving the operator's masters or contracts breaks whatever else points at them.",
    schema: z.object({ from: z.string(), to: z.string(), reason: z.string() }),
    async preview(input) {
      return {
        title: "Move a file in the workspace",
        description: `${input.from} → ${input.to}`,
        details: [`Reason: ${input.reason}`],
        riskNotes: "Anything referencing the old path (a DAW project, an upload link, a backup script) will no longer find it.",
      };
    },
    async execute(input) {
      return moveWorkspaceFile(input.from, input.to);
    },
  }),

  defineTool({
    name: "file_register",
    group: "files",
    autonomy: "level1",
    description:
      "Catalogue a file that already exists in the workspace, optionally linking it to a track or release. Use this so masters, stems and artwork are findable by what they belong to rather than by filename.",
    schema: z.object({
      path: z.string(),
      category: z.enum(["music", "artwork", "marketing", "contract", "analytics", "finance", "research", "strategy", "other"]),
      description: z.string().optional(),
      trackId: z.string().optional(),
      releaseId: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    async execute(input) {
      const { path, tags, ...rest } = input;
      const asset = await prisma.fileAsset.upsert({
        where: { path },
        create: { path, name: path.split("/").pop() ?? path, ...rest, tagsJson: toJson(tags ?? []) },
        update: { ...rest, tagsJson: toJson(tags ?? []) },
      });
      return { id: asset.id, path: asset.path, category: asset.category };
    },
  }),
];
