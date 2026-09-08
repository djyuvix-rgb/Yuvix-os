import { mkdir, readdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, normalize, resolve, sep, extname, basename, dirname } from "node:path";
import { env } from "@/server/env";
import { prisma } from "@/server/db/client";
import { log } from "@/server/logger";

/**
 * The workspace: one organised tree holding the artist's real files.
 *
 * Every path the agent touches is resolved against this root and rejected if it
 * escapes — the agent can never read or write outside it, whatever a tool
 * argument or a fetched web page claims.
 */
export const WORKSPACE_TREE = [
  "Artist",
  "Music/Released",
  "Music/Unreleased",
  "Music/Stems",
  "Music/Masters",
  "Artwork",
  "Marketing",
  "Campaigns",
  "Contacts",
  "Contracts",
  "Analytics",
  "Finance",
  "Research",
  "Strategy",
] as const;

export const CATEGORY_BY_PREFIX: [string, string][] = [
  ["Music", "music"],
  ["Artwork", "artwork"],
  ["Marketing", "marketing"],
  ["Campaigns", "marketing"],
  ["Contracts", "contract"],
  ["Analytics", "analytics"],
  ["Finance", "finance"],
  ["Research", "research"],
  ["Strategy", "strategy"],
  ["Contacts", "other"],
  ["Artist", "other"],
];

export function workspaceRoot(): string {
  return resolve(env.workspaceDir);
}

export class PathEscapeError extends Error {
  constructor(path: string) {
    super(`Refusing to touch "${path}": it resolves outside the YUVIX OS workspace.`);
    this.name = "PathEscapeError";
  }
}

/** Resolves a workspace-relative path, refusing traversal and absolute paths. */
export function resolveInWorkspace(relativePath: string): string {
  const root = workspaceRoot();
  const cleaned = normalize(relativePath).replace(/^([/\\])+/, "");
  const full = resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + sep)) throw new PathEscapeError(relativePath);
  return full;
}

export function toRelative(fullPath: string): string {
  const root = workspaceRoot();
  return fullPath.startsWith(root) ? fullPath.slice(root.length + 1) : fullPath;
}

export async function ensureWorkspace(): Promise<string> {
  const root = workspaceRoot();
  await mkdir(root, { recursive: true });
  for (const dir of WORKSPACE_TREE) await mkdir(join(root, dir), { recursive: true });
  return root;
}

export function categoryFor(relativePath: string): string {
  const top = relativePath.split(/[/\\]/)[0];
  return CATEGORY_BY_PREFIX.find(([prefix]) => prefix === top)?.[1] ?? "other";
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: string;
  category: string;
}

export async function listWorkspace(relativeDir = "", recursive = false): Promise<WorkspaceEntry[]> {
  await ensureWorkspace();
  const full = resolveInWorkspace(relativeDir);
  const out: WorkspaceEntry[] = [];

  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      const info = await stat(child).catch(() => null);
      if (!info) continue;
      const rel = toRelative(child);
      out.push({
        path: rel,
        name: entry.name,
        isDirectory: entry.isDirectory(),
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        category: categoryFor(rel),
      });
      if (entry.isDirectory() && recursive && depth < 4) await walk(child, depth + 1);
    }
  };

  await walk(full, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".log", ".srt", ".xml", ".html"]);

export function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function readWorkspaceFile(relativePath: string, maxChars = 40_000) {
  const full = resolveInWorkspace(relativePath);
  const info = await stat(full);
  if (info.size > 25 * 1024 * 1024) throw new Error("File is too large to read inline (25 MB limit).");

  if (!isTextFile(relativePath)) {
    return {
      path: relativePath,
      binary: true,
      sizeBytes: info.size,
      note: "Binary file. Audio files can be analysed with audio_analyze; other binaries can only be catalogued, not read.",
    };
  }

  const content = await readFile(full, "utf8");
  return {
    path: relativePath,
    binary: false,
    sizeBytes: info.size,
    truncated: content.length > maxChars,
    content: content.slice(0, maxChars),
  };
}

export async function writeWorkspaceFile(relativePath: string, content: string) {
  const full = resolveInWorkspace(relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  const info = await stat(full);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);

  await prisma.fileAsset.upsert({
    where: { path: relativePath },
    create: {
      path: relativePath,
      name: basename(relativePath),
      category: categoryFor(relativePath),
      mimeType: extname(relativePath) === ".md" ? "text/markdown" : "text/plain",
      sizeBytes: info.size,
      hash,
    },
    update: { sizeBytes: info.size, hash },
  });

  log.info("workspace.write", { path: relativePath, bytes: info.size });
  return { path: relativePath, sizeBytes: info.size };
}

export async function moveWorkspaceFile(from: string, to: string) {
  const fullFrom = resolveInWorkspace(from);
  const fullTo = resolveInWorkspace(to);
  await mkdir(dirname(fullTo), { recursive: true });
  await rename(fullFrom, fullTo);
  await prisma.fileAsset.updateMany({
    where: { path: from },
    data: { path: to, name: basename(to), category: categoryFor(to) },
  });
  return { from, to };
}
